/**
 * The LasseCash client — the single thing the frontend imports.
 *
 * WHAT THIS DOES: fetches, joins reads into views, converts user input into
 * base-unit arguments, and formats what came back.
 *
 * WHAT THIS MUST NEVER DO: work out a balance, a reward, a multiplier or a
 * payout. Every such number arrives already computed. If a screen needs a figure
 * that no endpoint returns, add a backend quote — do not compute it here. See
 * CLAUDE.md, golden rule.
 */
import { fromUnits, toBaseUnitArg } from "./amount.js";
import type { Backend, Signer } from "./backend.js";
import { BackendError, MaxSideCalls, type SubmitOptions } from "./backend.js";
import type {
  AccountView, ChainInfo, Content, GovernanceMember, LiquidityQuote,
  MigrationRecord, MintQuote, MintView, PostVote, PostView, PublishResult,
  ResourceCredits, SwapDirection, SwapQuote, TrancheView, TxResult, Window,
} from "./types.js";
import { commentPermlink } from "./hive-metadata.js";
import { constants } from "./engine.js";
import { Entrypoint } from "./types.js";

export interface ClientOptions {
  backend: Backend;
  signer?: Signer;
}

/** Joins the pipe-delimited argument list an entrypoint expects. */
function args(...parts: (string | number)[]): string {
  return parts.map(String).join("|");
}

/** Raw base units from a state key, as the decimal Amount the UI renders. */
function units(raw: string | undefined): string {
  return fromUnits(BigInt(raw || "0"));
}

export class LasseCashClient {
  readonly backend: Backend;
  #signer: Signer | undefined;

  constructor(opts: ClientOptions) {
    this.backend = opts.backend;
    this.#signer = opts.signer;
  }

  /** The signed-in account, or null when browsing anonymously. */
  get account(): string | null { return this.#signer?.account ?? null; }

  /** Attach or replace the signer (login / logout). */
  setSigner(signer: Signer | undefined): void { this.#signer = signer; }

  #requireSigner(): Signer {
    if (!this.#signer) throw new BackendError("not signed in");
    return this.#signer;
  }

  // --- reads --------------------------------------------------------------

  chain(): Promise<ChainInfo> { return this.backend.chain(); }
  accountOf(name: string): Promise<AccountView> { return this.backend.account(name); }
  state(keys: string[]): Promise<Record<string, string>> { return this.backend.state(keys); }
  txStatus(txId: string) { return this.backend.txStatus(txId); }

  /** Content, newest first. */
  async posts(limit = 50): Promise<PostView[]> {
    const v = await this.backend.posts(limit);
    this.notePayable(v);
    return v;
  }

  /**
   * Who voted on a post, heaviest first.
   *
   * Fetched on demand, never with the feed: a post's voter list is a detail
   * one reader in twenty opens, and on MAGI it costs a history query per post.
   *
   * The rows carry raw rshares — vote weight, not LASSECASH. A voter's share of
   * the curator pot is that weight over the post's total, which is what the
   * contract itself divides by, so present it as a share of vote weight and
   * nothing more.
   */
  postVotes(author: string, permlink: string): Promise<PostVote[]> {
    return this.backend.postVotes(author, permlink);
  }

  /**
   * The registered replies to a post, newest-first from the backend.
   *
   * Comments are NOT in `posts()`: a reply is registered through the `comment`
   * entrypoint, and both backends keep the two lists disjoint so a reply can
   * never appear in the feed or the sitemap as an article.
   */
  comments(author: string, permlink: string): Promise<PostView[]> {
    return this.backend.comments(author, permlink);
  }

  /**
   * The governing board as RAW rows: every `gov_board` account, its L-Shares
   * and its standing preferences.
   *
   * Hand these straight to `engine.consensusGroup` (who holds the ten seats)
   * and `engine.effectiveValue` (what is in force). This method deliberately
   * does not tell you either — the median, the clamping and the tie-break are
   * the engine's, and this is the same read a foreign dApp contract makes
   * against the frozen public ABI.
   */
  governance(paramKeys: string[]): Promise<GovernanceMember[]> {
    return this.backend.governance(paramKeys);
  }

  // --- migration ----------------------------------------------------------
  //
  // The migration is CLAIM-based: the owner commits one Merkle root, every
  // holder claims their own leaf with a proof. The proofs are STATIC FILES
  // served with the site (web/static/migration), never computed here — a
  // proof is data plumbing, and the only arithmetic in sight (the leaf hash)
  // happens in the contract, in Go.

  /**
   * The committed migration root, or null while none has been committed.
   *
   * 64 lowercase hex characters. A page can compare it against the root.json
   * shipped with the proofs and refuse to offer a claim the chain would
   * reject.
   */
  async migrationRoot(): Promise<string | null> {
    const st = await this.backend.state(["cfg_migroot"]);
    const root = st["cfg_migroot"];
    return root ? root : null;
  }

  /**
   * An account's permanent migration receipt, or null if it has not been
   * claimed or recorded yet.
   *
   * This is the one-credit guard the contract itself checks, so it is also the
   * honest answer to "has this account already migrated?" — a balance is not,
   * because a claimed account can spend down to zero.
   */
  async migrationRecord(account: string): Promise<MigrationRecord | null> {
    const key = `mig_${account}`;
    const st = await this.backend.state([key]);
    const raw = st[key];
    // A MISSING KEY ON MAGI READS AS AN EMPTY STRING, not as absent. Treating
    // "" as a receipt would tell every unclaimed holder they had claimed.
    if (!raw) return null;
    const f = raw.split("|");
    if (f.length === 3 && f[0] === "burned") {
      return { burned: true, liquid: units(f[1]), staked: units(f[2]) };
    }
    if (f.length === 2) {
      return { burned: false, liquid: units(f[0]), staked: units(f[1]) };
    }
    // The legacy "1" marker from the first rehearsals: migrated, figures lost.
    return { burned: false, liquid: "0.00000000", staked: "0.00000000" };
  }

  /** One article body. Null when registered on-chain but never published. */
  content(author: string, permlink: string): Promise<Content | null> {
    return this.backend.content(author, permlink);
  }

  /**
   * Publish an article and open its payout window.
   *
   * `payoutMode` applies to the AUTHOR's reward only — curators always take the
   * standard split. Returns the permlink the post was registered under, which
   * is the contract's key for it.
   */
  async publish(input: {
    title: string; body: string; summary?: string; tags?: string[];
    window: Window; payoutMode?: number; permlink?: string;
  }): Promise<PublishResult> {
    const signer = this.#requireSigner();
    return this.backend.publish({
      permlink: input.permlink ?? "",
      title: input.title,
      body: input.body,
      summary: input.summary ?? "",
      tags: input.tags ?? [],
      window: input.window,
      payoutMode: input.payoutMode ?? 0,
      signer,
      ...({ sender: signer.account } as object),
    });
  }

  /** The signed-in account's view. */
  me(): Promise<AccountView> {
    return this.backend.account(this.#requireSigner().account);
  }

  /** Open mints, newest first. The list the Mint dashboard renders. */
  async openMints(name: string): Promise<MintView[]> {
    const a = await this.backend.account(name);
    return a.mints.filter((m) => !m.ended);
  }

  /**
   * Mints that need attention: matured, or already bleeding.
   *
   * Bleeding is losing money, so the UI must make this impossible to miss.
   * `bleed_remaining_pct` below 1.0 means value is actively draining.
   */
  async mintsNeedingAttention(name: string): Promise<MintView[]> {
    const mints = await this.openMints(name);
    return mints.filter((m) => m.mature || m.bleed_remaining_pct !== "1.00000000");
  }

  /** Open liquidity tranches, newest first. */
  async openTranches(name: string): Promise<TrancheView[]> {
    const a = await this.backend.account(name);
    return a.tranches.filter((t) => !t.closed);
  }

  // --- quotes -------------------------------------------------------------
  //
  // Previews are ENGINE-computed. `amount` is what the user typed, e.g. "1000.5".

  async quoteSwap(direction: SwapDirection, amount: string): Promise<SwapQuote> {
    return this.backend.quoteSwap(direction, toBaseUnitArg(amount));
  }

  async quoteMint(amount: string, days: number): Promise<MintQuote> {
    return this.backend.quoteMint(toBaseUnitArg(amount), days);
  }

  async quoteLiquidity(amount: string): Promise<LiquidityQuote> {
    return this.backend.quoteLiquidity(toBaseUnitArg(amount));
  }

  // --- writes -------------------------------------------------------------
  //
  // Amounts are typed by the user as decimals and converted here — the single
  // point where human input becomes chain input.

  async transfer(to: string, amount: string): Promise<TxResult> {
    return this.#send(Entrypoint.Transfer, args(to, toBaseUnitArg(amount)));
  }

  async burn(amount: string): Promise<TxResult> {
    return this.#send(Entrypoint.Burn, args(toBaseUnitArg(amount)));
  }

  /**
   * Claim this account's migration position.
   *
   * `liquidUnits` and `stakedUnits` are BASE UNITS exactly as they appear in
   * the published leaf — NOT decimals. They are inside the Merkle leaf hash,
   * so converting or rounding them by a single unit makes the proof fail; this
   * is the one write on the client that deliberately skips `toBaseUnitArg`.
   *
   * The staked half becomes the 30-day migration mint, which has been running
   * on the shared clock since genesis whether or not it was claimed: before
   * day 30 the claimer gets a live mint, after day 60 it is bleeding, and
   * after day 150 the window is shut. Preview with `previewMintClose` before
   * showing a figure.
   */
  async claimMigration(
    liquidUnits: string, stakedUnits: string, proof: string[],
    opts?: { cheap?: boolean },
  ): Promise<TxResult> {
    // Measured on the devnet 2026-08-21: a staked claim before maturity can
    // cost up to 5,892 RC (it creates a mint and may take a board seat); a
    // liquid-only or already-matured claim costs ~1,042–1,824. The page
    // passes `cheap` when it knows the cheap path applies, so a fresh
    // account is not frozen for five days over a small claim.
    return this.#send(Entrypoint.ClaimMigration,
      args(liquidUnits, stakedUnits, proof.join(",")),
      opts?.cheap ? { rcLimit: 2_500 } : undefined);
  }

  /**
   * Write the permanent on-chain receipt for a BURNED leaf.
   *
   * Permissionless and moves nothing — @null was credited with the whole burn
   * total when the root was committed. This exists so "this account held this
   * and did not qualify" is readable on MAGI forever rather than only implied
   * by a lump sum. Same base-unit rule as `claimMigration`.
   */
  async recordBurn(
    account: string, liquidUnits: string, stakedUnits: string, proof: string[],
  ): Promise<TxResult> {
    return this.#send(Entrypoint.RecordBurn,
      args(account, liquidUnits, stakedUnits, proof.join(",")));
  }

  /**
   * Plan the `advance` slices a mint/claim needs in front of it.
   *
   * The contract lets an ordinary call retire only UserRetireBudget (25)
   * matured accounts as a side effect; a heavier day — the migration
   * maturity day above all — must be crossed by `advance`, one
   * MaxRetirePerWalk (50) slice per call. This reads how far accrual lags
   * (`acc_day` vs today) and how many accounts are queued on the days in
   * between (`explc_<day>` chunk counts × ExpiryChunkSize), and returns that
   * many slices, capped. The signer sends as many as the account can afford
   * ahead of the user's call, each its own transaction, so the progress
   * persists. No economics here — it only counts rows.
   */
  async catchUp(max = 8): Promise<{ entrypoint: string; args: string }[]> {
    try {
      const c = constants();
      const hpd = Number(c.heightsPerDay);
      const st = await this.backend.state(["acc_day", "cfg_genesis", "cfg_settled"]);
      const info = await this.backend.chain();
      const genesis = Number(st["cfg_genesis"] || 0);
      if (!genesis || !hpd) return [];
      const today = Math.floor((info.height - genesis) / hpd);
      const accDay = Number(st["acc_day"] || 0);
      if (accDay >= today) return [];
      const days: string[] = [];
      for (let d = accDay; d <= today && days.length < 64; d++) days.push(`explc_${d}`);
      const counts = await this.backend.state(days);
      let chunks = 0;
      for (const k of days) chunks += Number(counts[k] || 0);
      const entries = chunks * c.expiryChunkSize;
      const slices = Math.ceil(entries / c.maxRetirePerWalk) + 1;
      const n = Math.min(max, Math.max(1, slices));
      return Array.from({ length: n }, () => ({ entrypoint: "advance", args: "" }));
    } catch {
      return [];
    }
  }

  /** Lock LASSECASH for `days` (1..1095, sliding scale). */
  async mint(amount: string, days: number): Promise<TxResult> {
    return this.#send(Entrypoint.Mint, args(toBaseUnitArg(amount), days), { preCalls: await this.catchUp() });
  }

  /**
   * Close a mint.
   *
   * ONE call for both cases: the chain decides from the height whether this is
   * an early end (principal slashed, yield forfeited) or a mature claim. There
   * is deliberately no way for a caller to pick the friendlier path — show the
   * user `if_claimed_now` and `slashed_if_claimed_now` first.
   */
  async claimMint(mintId: number): Promise<TxResult> {
    return this.#send(Entrypoint.ClaimMint, args(mintId), { preCalls: await this.catchUp() });
  }

  /** Arm tax deferral. Only in the 30 days before maturity, never after. */
  async armGoodAccounting(mintId: number): Promise<TxResult> {
    return this.#send(Entrypoint.GoodAccounting, args(mintId));
  }

  /** The mint length used for the monthly Proof-of-Brain mint. */
  async setMintDuration(days: number): Promise<TxResult> {
    return this.#send(Entrypoint.SetDuration, args(days));
  }

  /** Convert accrued Proof-of-Brain rewards into this month's mint. */
  async settlePending(account?: string): Promise<TxResult> {
    return this.#send(Entrypoint.SettlePending, args(account ?? ""), { preCalls: await this.catchUp() });
  }

  async post(permlink: string, window: Window): Promise<TxResult> {
    return this.#send(Entrypoint.Post, args(permlink, window));
  }

  /**
   * Publish a reply and open its payout window.
   *
   * TWO STEPS, in this order: the body goes to the content layer (Hive in
   * production), then the contract is told a reply exists. An unregistered
   * comment is recoverable; a payout window over content that does not exist
   * is not.
   *
   * A comment runs VIRAL economics — 7-day window, viral pool, viral vote
   * meter — but is gated by its own lower threshold (`post.threshold_comment`).
   * PREFLIGHT THAT THRESHOLD BEFORE CALLING: the contract refuses a
   * below-threshold reply, and by then the body has already been written to
   * Hive. `engine.effectiveValue(constants().paramPostThresholdComment, …)` is
   * the figure to check against the account's `shares`.
   *
   * The permlink is derived HERE, once, and used for both steps — it is the
   * contract's key for the reply, so the two must agree exactly.
   */
  async comment(input: {
    body: string; parentAuthor: string; parentPermlink: string;
    payoutMode?: number;
  }): Promise<PublishResult> {
    const signer = this.#requireSigner();
    return this.backend.publishComment({
      permlink: commentPermlink(input.parentAuthor, input.parentPermlink),
      body: input.body,
      parentAuthor: input.parentAuthor,
      parentPermlink: input.parentPermlink,
      payoutMode: input.payoutMode ?? 0,
      signer,
      ...({ sender: signer.account } as object),
    });
  }

  /**
   * Burn LASSECASH to buy a post a promoted slot in Trending.
   *
   * THE MONEY IS DESTROYED. The burn credits `hive:null` — provably
   * unspendable, visible forever — and the post records the running total.
   * There is no refund and no way to undo it, so the UI must confirm loudly
   * before calling this.
   *
   * The chain refuses a promotion on a comment, on a paid-out post, below the
   * governed minimum (`promote.min_burn`), and once `engine.PromoteCutoffPct`
   * of the window has elapsed — nobody buys a slot that ends in ten minutes.
   */
  async promotePost(author: string, permlink: string, amount: string): Promise<TxResult> {
    return this.#send(Entrypoint.PromotePost,
      args(author, permlink, toBaseUnitArg(amount)));
  }

  async vote(author: string, permlink: string, weightPct: number): Promise<TxResult> {
    return this.#send(Entrypoint.Vote, args(author, permlink, weightPct), { sideCalls: this.#settlements() });
  }

  /**
   * Posts whose window has closed and nobody has settled, as side calls.
   *
   * The client keeps the list from the last feed/post read (`notePayable`);
   * every signed action carries up to MaxSideCalls of them in the same wallet
   * confirm. This is what makes payout need no cron and no bot: as long as
   * anyone uses the site, settlement rides on what they were doing anyway.
   */
  #payable = new Map<string, { author: string; permlink: string }>();
  notePayable(posts: { author: string; permlink: string; payable: boolean; paid_out: boolean }[]): void {
    for (const p of posts) {
      const k = `${p.author}/${p.permlink}`;
      if (p.payable && !p.paid_out) this.#payable.set(k, { author: p.author, permlink: p.permlink });
      else this.#payable.delete(k);
    }
  }
  #settlements(): { entrypoint: string; args: string }[] {
    const out: { entrypoint: string; args: string }[] = [];
    for (const p of this.#payable.values()) {
      if (out.length >= MaxSideCalls) break;
      out.push({ entrypoint: Entrypoint.Payout, args: args(p.author, p.permlink) });
    }
    return out;
  }

  /**
   * Withdraw your own vote: weight 0. Subtracts exactly what this account
   * added, refunds no power; the bundled Hive vote is withdrawn too.
   */
  async unvote(author: string, permlink: string): Promise<TxResult> {
    return this.#send(Entrypoint.Vote, args(author, permlink, 0), { sideCalls: this.#settlements() });
  }

  /** Trigger a post's payout. Permissionless — anyone may call it. */
  async payout(author: string, permlink: string): Promise<TxResult> {
    return this.#send(Entrypoint.Payout, args(author, permlink));
  }

  /**
   * Collect a curator's share of a paid-out post.
   *
   * Permissionless: pass `curator` to settle on someone else's behalf. The
   * reward always goes to the curator, never to the caller — splitting the
   * claim is a gas necessity, not a way to lose rewards by forgetting.
   */
  async claimCuration(author: string, permlink: string, curator = ""): Promise<TxResult> {
    return this.#send(Entrypoint.ClaimCuration, args(author, permlink, curator));
  }

  /**
   * Add liquidity. `maxHbd` is the most HBD to supply; only what the pool ratio
   * requires is drawn. Quote first — `quoteLiquidity` returns `hbd_needed`.
   */
  async addLiquidity(lcAmount: string, maxHbd: string): Promise<TxResult> {
    return this.#send(Entrypoint.AddLiquidity,
      args(toBaseUnitArg(lcAmount), toBaseUnitArg(maxHbd)));
  }

  async removeLiquidity(trancheId: number): Promise<TxResult> {
    return this.#send(Entrypoint.RemoveLiquidity, args(trancheId));
  }

  async claimPoolRewards(trancheId: number): Promise<TxResult> {
    return this.#send(Entrypoint.ClaimPool, args(trancheId));
  }

  /**
   * Swap through the pool.
   *
   * `minOut` is slippage protection and is NOT optional in practice: quote
   * first, then pass a minimum a little under the quote. Sending "0" accepts
   * any price, which invites a sandwich.
   */
  async swap(direction: SwapDirection, amountIn: string, minOut: string): Promise<TxResult> {
    const ep = direction === "lc_hbd" ? Entrypoint.SwapLcHbd : Entrypoint.SwapHbdLc;
    return this.#send(ep, args(toBaseUnitArg(amountIn), toBaseUnitArg(minOut)));
  }

  /** Offer an account a consensus seat. Permissionless. */
  async promote(account?: string): Promise<TxResult> {
    return this.#send(Entrypoint.Promote, args(account ?? ""));
  }

  /** Record a consensus member's standing preference for a parameter. */
  async setParam(key: string, value: string | number): Promise<TxResult> {
    return this.#send(Entrypoint.SetParam, args(key, value));
  }

  /** An account's resource credits, or null if the backend cannot report them. */
  resourceCredits(account?: string): Promise<ResourceCredits | null> {
    const who = account ?? this.account;
    if (!who || !this.backend.resourceCredits) return Promise.resolve(null);
    return this.backend.resourceCredits(who);
  }

  /**
   * Whether there is enough RC headroom to spend some on the user's behalf.
   *
   * Background housekeeping must never leave someone unable to post, vote or
   * transfer. The floor is a FRACTION OF THEIR OWN MAXIMUM, not an absolute:
   * a small account and a whale have very different meters, and an absolute
   * threshold would either be meaningless to one or lock out the other.
   *
   * Unknown RC returns true — the dev chain has no RC model, and refusing to
   * work there would make the guard untestable.
   */
  async hasRcHeadroom(floorFraction = 0.25): Promise<boolean> {
    const rc = await this.resourceCredits();
    if (!rc || rc.max <= 0) return true;
    return rc.amount / rc.max > floorFraction;
  }

  /**
   * Recycle a settled post's unclaimed curator pot, one year after payout.
   *
   * Permissionless and pays the caller nothing.
   */
  async sweepCuration(author: string, permlink: string): Promise<TxResult> {
    return this.#send("sweep_curation", args(author, permlink));
  }

  /** Credit emission up to the current height. Permissionless. */
  async settle(): Promise<TxResult> { return this.#send(Entrypoint.Settle, ""); }

  // async, so a missing signer or a malformed amount surfaces as a REJECTED
  // promise rather than a synchronous throw. A method typed Promise<T> that
  // sometimes throws before returning cannot be handled with .catch(), which
  // is exactly the kind of trap that makes a UI swallow errors silently.
  async #send(entrypoint: string, payload: string, opts?: SubmitOptions): Promise<TxResult> {
    return this.#requireSigner().submit(entrypoint, payload, opts);
  }

  // --- dev only -----------------------------------------------------------

  /** Move the dev chain's clock. Returns null against a real node. */
  async advanceDays(days: number): Promise<number | null> {
    return this.backend.advanceDays ? this.backend.advanceDays(days) : null;
  }
}

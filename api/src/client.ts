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
import { BackendError } from "./backend.js";
import type {
  AccountView, ChainInfo, Content, LiquidityQuote, MigrationRecord, MintQuote,
  MintView, PostView, PublishResult, ResourceCredits, SwapDirection, SwapQuote,
  TrancheView, TxResult, Window,
} from "./types.js";
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

  /** Content, newest first. */
  posts(limit = 50): Promise<PostView[]> { return this.backend.posts(limit); }

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
    window: Window; payoutMode?: number;
  }): Promise<PublishResult> {
    const signer = this.#requireSigner();
    return this.backend.publish({
      title: input.title,
      body: input.body,
      summary: input.summary ?? "",
      tags: input.tags ?? [],
      window: input.window,
      payoutMode: input.payoutMode ?? 0,
      ...({ sender: signer.account } as object),
    });
  }

  /** The signed-in account's view. */
  me(): Promise<AccountView> {
    return this.backend.account(this.#requireSigner().account);
  }

  /** Open mints, newest first. The list the LasseMint dashboard renders. */
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
  ): Promise<TxResult> {
    return this.#send(Entrypoint.ClaimMigration,
      args(liquidUnits, stakedUnits, proof.join(",")));
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

  /** Lock LASSECASH for `days` (1..1095, sliding scale). */
  async mint(amount: string, days: number): Promise<TxResult> {
    return this.#send(Entrypoint.Mint, args(toBaseUnitArg(amount), days));
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
    return this.#send(Entrypoint.ClaimMint, args(mintId));
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
    return this.#send(Entrypoint.SettlePending, args(account ?? ""));
  }

  async post(permlink: string, window: Window): Promise<TxResult> {
    return this.#send(Entrypoint.Post, args(permlink, window));
  }

  async vote(author: string, permlink: string, weightPct: number): Promise<TxResult> {
    return this.#send(Entrypoint.Vote, args(author, permlink, weightPct));
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
  async #send(entrypoint: string, payload: string): Promise<TxResult> {
    return this.#requireSigner().submit(entrypoint, payload);
  }

  // --- dev only -----------------------------------------------------------

  /** Move the dev chain's clock. Returns null against a real node. */
  async advanceDays(days: number): Promise<number | null> {
    return this.backend.advanceDays ? this.backend.advanceDays(days) : null;
  }
}

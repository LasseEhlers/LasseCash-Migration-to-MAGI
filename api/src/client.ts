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
import { fromUnits, toBaseUnitArg, toUnits, type Amount } from "./amount.js";
import type { Backend, Signer } from "./backend.js";
import { type AccountActivity, BackendError, MaxSideCalls, type AccountOp, type SubmitOptions } from "./backend.js";
import type {
  AccountView, ChainInfo, Content, GovernanceMember, LiquidityQuote,
  MigrationRecord, MintQuote, MintView, PoolTrade, PostVote, PostView, PublishResult,
  ResourceCredits, SwapDirection, SwapQuote, TrancheView, TxResult, Window,
} from "./types.js";
import { commentPermlink } from "./hive-metadata.js";
import { MAPPING_CONTRACTS,
  ASSET_SCALE, BTC_DUST_SATS, BTC_MAPPING_CONTRACT, decimalToUnits, poolFor, qualifyAddress,
  quoteMagiSwap, swapIntent, swapPayload, unitsToDecimal, type MagiPool, type MagiQuote,
} from "./magi-pools.js";
import { constants } from "./engine.js";
import * as engine from "./engine.js";
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

  /**
   * Confirmed contract calls grouped by signer, newest-busiest first.
   *
   * Empty on the simulator, which keeps no transaction log — callers get a
   * blank activity column rather than an error, because the rest of a stats
   * view is still worth showing.
   */
  activity(limit = 2000): Promise<AccountActivity[]> {
    return this.backend.activity ? this.backend.activity(limit) : Promise.resolve([]);
  }
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

  /**
   * Every trade since the pool opened, with the price each one left behind.
   *
   * HOW IT IS BUILT. The chain records the CALL, not its effect: a swap's
   * payload says what went in, never what came out. So the series is a
   * REPLAY — start at the opening deposit, and for each swap ask the engine
   * what the pool would have paid against the reserves standing at that
   * moment. Every step is `engine.estimateSwap` and `engine.lcToHbd`: the
   * same Go code the contract runs, so the replay cannot drift from what the
   * chain actually did. Writing `(in * out) / (in + res)` here instead would
   * be exactly the second implementation the golden rule forbids.
   *
   * The replay is CHECKED, not trusted: `reconciled` is true only when the
   * final reserves land on the chain's live figures to the base unit. It did
   * on the first run (2026-09-01, five events, zero difference in either
   * asset). If it ever reads false the chart is telling you so rather than
   * drawing a plausible line.
   *
   * Liquidity events move DEPTH but not PRICE — a proportional deposit is
   * priced at the pool's own ratio, which is why the first one is the only
   * one that sets a price.
   */
  async poolTrades(limit = 500): Promise<{ trades: PoolTrade[]; reconciled: boolean }> {
    const [ops, info] = await Promise.all([this.backend.poolOps(limit), this.chain()]);
    const trades: PoolTrade[] = [];
    let lc = 0n;
    let hbd = 0n;

    /**
     * WHAT ONE L-SHARE COST AT THIS POINT, in HBD.
     *
     * Both halves of a minter's decision in one number: the share rate is
     * EXACT — a deterministic +7% a year from genesis, never down — and the
     * price is whatever the pool held at that block. The engine does the
     * conversion (`shareRateHbd`), so the ratchet is never re-derived here.
     *
     * Height, not time: the ratchet is a function of block height, and the
     * chain hands us `anchr_height` per transaction, so there is nothing to
     * estimate.
     *
     * Expect it to track the price chart for a long while. The rate moves
     * about 0.02% a day; the pool moved 91% on a single 5 HBD buy. The
     * ratchet only separates the two over years — by which time it has
     * doubled the cost on its own.
     */
    const shareCostNow = (height: number): Amount | null => {
      if (lc <= 0n || hbd <= 0n || !height) return null;
      try {
        return engine.shareRateHbd(info.genesis_height, height, lc.toString(), hbd.toString());
      } catch { return null; }
    };

    const priceNow = (): Amount => {
      if (lc <= 0n || hbd <= 0n) return "0.00000000";
      // One LASSECASH, priced by the pool: the engine's own conversion.
      try {
        return engine.lcToHbd(toUnits("1").toString(), lc.toString(), hbd.toString()) ?? "0.00000000";
      } catch { return "0.00000000"; }
    };

    // The two liquidity calls have DIFFERENT payloads, and reading them as one
    // shape was the bug this replay shipped with:
    //
    //   add_liquidity     <lcAmount>|<maxHbd>     maxHbd is a CEILING, and the
    //                                            HBD actually taken is whatever
    //                                            the pool's own ratio requires
    //   remove_liquidity  <trancheId>            no amounts at all
    //
    // So a removal read as "<lc>|<hbd>" subtracted the tranche ID as base units
    // — two whole positions closing showed as 0.0000 / 0.000000 against
    // reserves that never moved (2026-09-01). And every deposit subtracted the
    // ceiling rather than the real HBD, which is what kept `reconciled` false.
    //
    // Fixing it means the replay has to track SHARES, because a withdrawal pays
    // a tranche's proportional slice of the reserves standing at that moment.
    // Both figures come from the engine — `estimateLiquidity` for what a
    // deposit takes and mints, `estimateWithdraw` for what a closure pays.
    // Doing either division here would be the second implementation the golden
    // rule forbids.
    let totalShares = 0n;
    const trancheShares = new Map<string, bigint>();
    const nextId = new Map<string, number>();

    for (const op of ops) {
      const f = op.payload.split("|");

      if (op.action === "add_liquidity") {
        const dLc = toUnits(fromUnits(BigInt(f[0] || "0")));
        const q = engine.estimateLiquidity(
          dLc.toString(), lc.toString(), hbd.toString(), totalShares.toString(),
        );
        // The FIRST deposit is the only one that sets a price, so it is also
        // the only one where the caller's HBD figure is the real amount.
        const dHbd = q.isFirstDeposit ? toUnits(fromUnits(BigInt(f[1] || "0"))) : toUnits(q.hbdNeeded);
        const minted = q.isFirstDeposit ? dLc : toUnits(q.shares);

        lc += dLc; hbd += dHbd; totalShares += minted;
        const id = (nextId.get(op.signer) ?? 0) + 1;
        nextId.set(op.signer, id);
        trancheShares.set(`${op.signer}_${id}`, minted);

        trades.push({
          time: op.time, height: op.height, side: q.isFirstDeposit ? "open" : "liquidity",
          amountIn: fromUnits(dLc), amountOut: fromUnits(dHbd),
          lcReserve: fromUnits(lc), hbdReserve: fromUnits(hbd), price: priceNow(),
          shareHbd: shareCostNow(op.height), trader: op.signer,
        });
        continue;
      }

      if (op.action === "remove_liquidity") {
        const key = `${op.signer}_${(f[0] || "").trim()}`;
        const held = trancheShares.get(key) ?? 0n;
        // A tranche we never saw opened cannot be replayed — skip it rather
        // than invent a withdrawal, and let `reconciled` report the gap.
        if (held <= 0n) continue;
        const w = engine.estimateWithdraw(
          held.toString(), totalShares.toString(), lc.toString(), hbd.toString(),
        );
        const outLc = toUnits(w.lc);
        const outHbd = toUnits(w.hbd);

        lc -= outLc; hbd -= outHbd; totalShares -= held;
        trancheShares.delete(key);

        trades.push({
          time: op.time, height: op.height, side: "liquidity",
          amountIn: fromUnits(outLc), amountOut: fromUnits(outHbd),
          lcReserve: fromUnits(lc), hbdReserve: fromUnits(hbd), price: priceNow(),
          shareHbd: shareCostNow(op.height), trader: op.signer,
        });
        continue;
      }
      const selling = op.action === "swap_lc_hbd";
      const amountIn = BigInt(f[0] || "0");
      if (amountIn <= 0n || lc <= 0n || hbd <= 0n) continue;
      const q = engine.estimateSwap(
        (selling ? lc : hbd).toString(),
        (selling ? hbd : lc).toString(),
        amountIn.toString(),
      );
      if (!q.ok) continue;
      const outUnits = toUnits(q.amountOut);
      if (selling) { lc += amountIn; hbd -= outUnits; }
      else { hbd += amountIn; lc -= outUnits; }
      trades.push({
        time: op.time, height: op.height, side: selling ? "sell" : "buy",
        amountIn: fromUnits(amountIn), amountOut: q.amountOut,
        lcReserve: fromUnits(lc), hbdReserve: fromUnits(hbd), price: priceNow(),
        shareHbd: shareCostNow(op.height), trader: op.signer,
      });
    }

    const reconciled =
      trades.length > 0 &&
      lc === toUnits(info.amm_lc) &&
      hbd === toUnits(info.amm_hbd);
    return { trades, reconciled };
  }

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

  /**
   * Send LASSECASH to another account.
   *
   * THE RECIPIENT IS QUALIFIED HERE, and it is not cosmetic. Balances are
   * keyed by the address exactly as the SDK renders a sender — `hive:alice`,
   * never `alice` — so a bare name creates a balance under a key that no
   * signer can ever match. On 2026-09-01 `transfer daneamanda|1000` was
   * CONFIRMED on the live chain and stranded 1,000 LC permanently: the call
   * succeeded, the sender was debited, and the money landed somewhere with no
   * owner.
   *
   * The contract now refuses a bare name outright, which is the real fix. This
   * is the second layer: a person typing a username into a send box means the
   * Hive account, and should not have to know the chain's addressing rules to
   * avoid losing their balance.
   */
  async transfer(to: string, amount: string, memo = ""): Promise<TxResult> {
    const t = to.trim().replace(/^@/, "");
    const dest = t.includes(":") ? t : `hive:${t}`;
    // THE MEMO COSTS THE CONTRACT NOTHING. `transfer` reads argument 0 and 1
    // and ParseArgs simply splits on `|`, so a third field is ignored on
    // chain — no state written, no entrypoint changed, no update needed. It
    // still lives forever in the call payload, on Hive L1 as the custom_json
    // and on MAGI as the transaction, which is exactly what a memo is.
    //
    // `|` is STRIPPED, not escaped: it is the argument separator, so a memo
    // containing one would split into fields the contract never expects.
    // Newlines go too — a memo is a line, not a document.
    const clean = memo.replace(/[|\r\n]+/g, " ").trim().slice(0, 200);
    return this.#send(Entrypoint.Transfer,
      clean
        ? args(dest, toBaseUnitArg(amount), clean)
        : args(dest, toBaseUnitArg(amount)));
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

  /**
   * Claim (= close) every MATURED mint in one signed transaction where the
   * signer supports it; loops individually on the dev chain.
   *
   * SAFETY: only `mature === true` mints are ever included. claim_mint on a
   * mint that has not matured is an EARLY END, not a claim — it slashes the
   * principal and forfeits all yield. This filter is load-bearing; never
   * pass an unfiltered id list to Signer.claimAllOf for this entrypoint.
   *
   * Known gap: unlike claimMint(), the bundled path does not run catchUp()
   * first — if accrual has fallen behind, affected ids are skipped by the
   * per-id RC dry run (reported as "refused") rather than caught up
   * automatically. Not expected to bite this early post-genesis; revisit if
   * "claimed 0 of N" reports start showing up.
   */
  async claimAllMintRewards(): Promise<TxResult> {
    const signer = this.#requireSigner();
    const mints = await this.mintsNeedingAttention(signer.account);
    const ids = mints.filter((m) => m.mature).map((m) => m.id);
    if (ids.length === 0) return { ok: false, height: 0, msg: "nothing to claim" };
    if (signer.claimAllOf) return signer.claimAllOf(Entrypoint.ClaimMint, ids);
    let last: TxResult = { ok: false, height: 0, msg: "nothing to claim" };
    for (const id of ids) {
      last = await this.claimMint(id);
      if (!last.ok) return last;
    }
    return last;
  }

  /** Arm tax deferral. Only in the 30 days before maturity, never after. */
  async armGoodAccounting(mintId: number): Promise<TxResult> {
    return this.#send(Entrypoint.GoodAccounting, args(mintId));
  }

  /**
   * How long this account's monthly Proof-of-Brain mint locks for.
   *
   * Post and curation earnings do not each become a mint — one real post
   * carried 201 votes, and a mint per payout would be roughly 1.5 million new
   * positions a year. They accrue to one pending balance, and on the 1st of
   * each calendar month that whole balance becomes ONE mint. This is its
   * length.
   *
   * The contract defaults to the MAXIMUM, 1,095 days, for an account that has
   * never set one — and nothing on the site could set one until 2026-09-02,
   * so every account was heading for a three-year lock on 1 October without
   * being asked.
   *
   * 1..1,095. The contract refuses anything outside that rather than clamping
   * silently, so the caller sees the error instead of a different lock than
   * they asked for.
   */
  async setMintDuration(days: number): Promise<TxResult> {
    return this.#send(Entrypoint.SetDuration, args(Math.round(days)));
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
   * Claim every open tranche's pending reward. One signed transaction on a
   * real wallet (Signer.claimAllOf); loops individually on the dev chain,
   * which has no signature to save by bundling.
   */
  async claimAllPoolRewards(): Promise<TxResult> {
    const signer = this.#requireSigner();
    const tranches = await this.openTranches(signer.account);
    const ids = tranches.filter((t) => Number(t.pending_reward) > 0).map((t) => t.id);
    if (ids.length === 0) return { ok: false, height: 0, msg: "nothing to claim" };
    if (signer.claimAllOf) return signer.claimAllOf(Entrypoint.ClaimPool, ids);
    let last: TxResult = { ok: false, height: 0, msg: "nothing to claim" };
    for (const id of ids) {
      last = await this.claimPoolRewards(id);
      if (!last.ok) return last;
    }
    return last;
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

  /**
   * Move HBD between Hive L1 and MAGI.
   *
   * MAGI's HBD is the same HBD — it is bridged, not wrapped — and it is the
   * account's RC meter as well as the pool's other side, so this is the one
   * operation that unblocks everything else on the site.
   */
  async depositHbd(amount: string, asset: "HBD" | "HIVE" = "HBD"): Promise<TxResult> {
    if (!this.#signer?.depositHbd) throw new BackendError("moving funds needs a wallet");
    return this.#signer.depositHbd(Number(amount), asset);
  }
  async withdrawHbd(amount: string, to?: string, asset: "HBD" | "HIVE" = "HBD"): Promise<TxResult> {
    if (!this.#signer?.withdrawHbd) throw new BackendError("moving funds needs a wallet");
    return this.#signer.withdrawHbd(Number(amount), to, asset);
  }

  /**
   * Quote a swap on one of MAGI's own pools, from its live reserves.
   *
   * An ESTIMATE of somebody else's pool: our arithmetic over their published
   * reserves and their published fee, not their code. Which is exactly why
   * the call we build carries a `min_amount_out` the CHAIN enforces — if
   * this number is ever wrong, the swap is refused rather than filled badly.
   */
  async quoteMagi(assetIn: string, assetOut: string, amountIn: string): Promise<
    (MagiQuote & { pool: MagiPool; reserveIn: bigint; reserveOut: bigint }) | null
  > {
    const pool = poolFor(assetIn, assetOut);
    if (!pool || !this.backend.magiPoolReserves) return null;
    const res = await this.backend.magiPoolReserves(pool.contractId);
    if (!res) return null;
    // r0 belongs to asset0 — the pool's own init says which that is.
    const inIsAsset0 = pool.asset0 === assetIn;
    const reserveIn = inIsAsset0 ? res.r0 : res.r1;
    const reserveOut = inIsAsset0 ? res.r1 : res.r0;
    const units = decimalToUnits(amountIn || "0", ASSET_SCALE[assetIn] ?? 1_000n);
    const q = quoteMagiSwap(reserveIn, reserveOut, units, pool.feeBps,
      ASSET_SCALE[assetOut] ?? 1_000n);
    return q ? { ...q, pool, reserveIn, reserveOut } : null;
  }

  /**
   * Swap on one of MAGI's pools, with a floor the chain enforces.
   *
   * `slippagePct` is the user's own tolerance, applied to our estimate. The
   * result is `min_amount_out`: the pool must pay at least that or the swap
   * does not happen. It is never omitted and never zero.
   */
  async magiSwap(
    assetIn: string, assetOut: string, amountIn: string, slippagePct: number,
  ): Promise<TxResult> {
    if (!this.#signer?.magiSwap) throw new BackendError("swapping needs a wallet");
    const q = await this.quoteMagi(assetIn, assetOut, amountIn);
    if (!q) throw new BackendError("no quote — the pool could not be read");
    const bps = BigInt(Math.round(Math.max(0.1, Math.min(50, slippagePct)) * 100));
    const minOut = (q.amountOutUnits * (10_000n - bps)) / 10_000n;
    if (minOut <= 0n) throw new BackendError("amount too small to swap");
    return this.#signer.magiSwap({
      router: q.pool.router,
      payload: swapPayload({
        assetIn, assetOut,
        amountInUnits: q.amountInUnits,
        minOutUnits: minOut,
        // QUALIFIED, always. MAGI addresses carry their chain — a bare
        // "lasseehlers" is refused with "recipient address invalid", which
        // is exactly how the first live swap died (2026-09-01). The signer's
        // own `account` is the BARE Hive name, so it can never be passed
        // through to a MAGI payload unchanged.
        recipient: qualifyAddress(this.account ?? ""),
      }),
      intents: [swapIntent(assetIn, q.amountInUnits)],
      // Their pool, their gas: measured ~94 RC for a swap on this router.
      // 3,000 is the same order as our own swap limit and errs high, since a
      // refused call freezes the limit exactly as a successful one does.
      rcLimit: 3_000,
      // Selling a MAPPED asset: the router pulls it from the mapping
      // contract, which requires this account's allowance. Granted for the
      // exact amount, in the same transaction, every time — additive
      // semantics make that idempotent for the swap that follows.
      ...(MAPPING_CONTRACTS[assetIn]
        ? {
            approve: {
              contractId: MAPPING_CONTRACTS[assetIn]!,
              payload: JSON.stringify({
                spender: `contract:${q.pool.router}`,
                amount: q.amountInUnits.toString(),
              }),
              rcLimit: 800,
            },
          }
        : {}),
    });
  }

  /**
   * Send mapped BTC to a real Bitcoin address.
   *
   * Refused below the contract's own dust threshold rather than letting the
   * chain refuse it: an output under 546 satoshis cannot be spent, so there
   * is nothing to learn from broadcasting it except the RC cost.
   */
  async withdrawBtc(amount: string, toAddress: string): Promise<TxResult> {
    if (!this.#signer?.withdrawBtc) throw new BackendError("withdrawing BTC needs a wallet");
    const addr = toAddress.trim();
    if (!addr) throw new BackendError("enter a Bitcoin address");
    const sats = decimalToUnits(amount || "0", ASSET_SCALE["BTC"]!);
    if (sats < BTC_DUST_SATS) {
      throw new BackendError(
        `below Bitcoin's dust limit — ${BTC_DUST_SATS} satoshis (0.00000546 BTC) is the smallest spendable output`,
      );
    }
    return this.#signer.withdrawBtc(sats, addr);
  }

  /**
   * Send any asset this account holds ON MAGI to another MAGI account.
   *
   * Three different rails behind one call, which is the point: LASSECASH is
   * our contract, HBD and HIVE are MAGI's native assets, and BTC lives in the
   * mapping contract. A wallet that shows four balances and can move one is
   * half a wallet.
   */
  async sendAsset(asset: string, to: string, amount: string, memo = ""): Promise<TxResult> {
    const dest = to.trim().replace(/^@/, "");
    if (!dest) throw new BackendError("enter an account name");
    const A = asset.toUpperCase();
    if (A === "LASSECASH" || A === "LC") return this.transfer(dest, amount, memo);
    if (A === "HBD" || A === "HIVE") {
      if (!this.#signer?.sendNative) throw new BackendError("sending needs a wallet");
      return this.#signer.sendNative(qualifyAddress(dest), Number(amount), A as "HBD" | "HIVE", memo);
    }
    if (A === "BTC") {
      if (!this.#signer?.sendBtc) throw new BackendError("sending needs a wallet");
      const sats = decimalToUnits(amount || "0", ASSET_SCALE["BTC"]!);
      if (sats <= 0n) throw new BackendError("enter an amount");
      return this.#signer.sendBtc(qualifyAddress(dest), sats);
    }
    throw new BackendError(`cannot send ${asset}`);
  }

  /**
   * EVERY open tranche in the pool, not just the signed-in account's.
   *
   * The contract cannot enumerate accounts or tranches — that is the same
   * bound that gives governance its 20-slot board — so the list is rebuilt the
   * way the chart rebuilds price: from the calls themselves. Every tranche was
   * opened by an `add_liquidity`, ids are sequential per account, so walking
   * the transaction log names every (owner, id) that has ever existed. State
   * then says which are still open.
   *
   * Closed tranches keep their record with the shares that were in it, so
   * `weight = 0` is what marks one as gone — not the absence of a key.
   *
   * Public by the same reasoning as the snapshot: pool positions are on chain
   * and an LP is choosing to be part of a shared pool. Someone deciding
   * whether to put money in deserves to see who else already has.
   */
  async allTranches(): Promise<{
    owner: string; id: number; shares: string; ageDays: number;
    loyalty: string; valueLc: Amount; valueHbd: Amount; share: number;
  }[]> {
    const [ops, info] = await Promise.all([this.backend.poolOps(500), this.chain()]);

    const seq = new Map<string, number>();
    const wanted: { owner: string; id: number }[] = [];
    for (const op of ops) {
      if (op.action !== "add_liquidity" || !op.signer) continue;
      const id = (seq.get(op.signer) ?? 0) + 1;
      seq.set(op.signer, id);
      wanted.push({ owner: op.signer, id });
    }
    if (!wanted.length) return [];

    const st = await this.state(wanted.map((w) => `lp_${w.owner}_${w.id}`));
    const total = toUnits(info.amm_shares ?? "0");
    const out = [];
    for (const w of wanted) {
      const raw = st[`lp_${w.owner}_${w.id}`];
      if (!raw) continue;
      const f = raw.split("|");
      // Tranche codec: shares | startHeight | weight | ? | accStart | lastTouch
      const shares = BigInt(f[0] || "0");
      const weight = BigInt(f[2] || "0");
      if (weight <= 0n || shares <= 0n) continue; // closed
      const v = engine.trancheView({
        shares: f[0] ?? "0", startHeight: Number(f[1] ?? 0), weight: f[2] ?? "0",
        accStart: f[4] ?? "0", height: info.height,
        totalShares: toUnits(info.amm_shares ?? "0").toString(),
        lcReserve: toUnits(info.amm_lc ?? "0").toString(),
        hbdReserve: toUnits(info.amm_hbd ?? "0").toString(),
        poolLiq: "0", accSeen: "0", accHeld: "0", acc: "0", totalWeight: "0",
      });
      out.push({
        owner: w.owner.replace(/^hive:/, ""), id: w.id, shares: fromUnits(shares),
        ageDays: v.age_days, loyalty: v.loyalty,
        valueLc: v.value_lc, valueHbd: v.value_hbd,
        share: total > 0n ? Number(shares) / Number(total) : 0,
      });
    }
    return out.sort((a, b) => b.share - a.share);
  }

  /** This account's BTC on MAGI, as a decimal string, or null if unreadable. */
  async btcBalance(account?: string): Promise<string | null> {
    const who = account ?? this.account;
    if (!who || !this.backend.mappedBalance) return null;
    const sats = await this.backend.mappedBalance(BTC_MAPPING_CONTRACT, who);
    return sats === null ? null : unitsToDecimal(sats, ASSET_SCALE["BTC"]!);
  }

  /** Recent contract calls by this account, newest first. */
  accountOps(limit = 30): Promise<AccountOp[]> {
    const who = this.account;
    if (!who || !this.backend.accountOps) return Promise.resolve([]);
    return this.backend.accountOps(who, limit);
  }

  /** An account's resource credits, or null if the backend cannot report them. */
  resourceCredits(account?: string): Promise<ResourceCredits | null> {
    const who = account ?? this.account;
    if (!who || !this.backend.resourceCredits) return Promise.resolve(null);
    return this.backend.resourceCredits(who);
  }

  /**
   * The HIVE L1 meter, which is a different thing from the MAGI one.
   *
   * Both are needed to use LasseCash: publishing is a Hive comment AND a MAGI
   * call in one signed transaction, so either meter running dry stops the
   * same action — and the two are refilled in completely different ways.
   */
  /** HIVE L1 balances. A deposit spends these, not the MAGI ones. */
  hiveBalances(account?: string): Promise<{ hbd: string; hive: string } | null> {
    const who = account ?? this.account;
    if (!who || !this.backend.hiveBalances) return Promise.resolve(null);
    return this.backend.hiveBalances(who);
  }

  hiveResourceCredits(account?: string): Promise<ResourceCredits | null> {
    const who = account ?? this.account;
    if (!who || !this.backend.hiveResourceCredits) return Promise.resolve(null);
    return this.backend.hiveResourceCredits(who);
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

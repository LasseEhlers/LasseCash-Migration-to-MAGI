/**
 * Backend for a real MAGI node.
 *
 * STATUS: reads are wired; writes are not, and cannot be until a contract id
 * exists and Aioha signing is in place. It is written now so the boundary is
 * exercised by the type checker rather than discovered on deploy day.
 *
 * Verified MAGI facts this relies on (see CLAUDE.md):
 *   - GraphQL at https://api.vsc.eco/api/v1/graphql
 *   - `getStateByKeys` reads contract state by key
 *   - `simulateContractCalls` returns rc_used / gas_used / ret — this is how
 *     quotes are produced without broadcasting
 *   - `localNodeInfo.last_processed_block` is the Hive height (3s per unit)
 */
import { BackendError, type Backend } from "./backend.js";
import * as engine from "./engine.js";
import { toUnits } from "./amount.js";
import type {
  AccountView, ChainInfo, Content, LiquidityQuote, MintQuote, PostMeta, PostVote,
  PostView, PublishResult, ResourceCredits, SwapDirection, SwapQuote,
} from "./types.js";

export interface MagiBackendOptions {
  /** Node GraphQL endpoint. */
  url?: string;
  /** The deployed LasseCash contract id. Required for any contract read. */
  contractId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class MagiBackend implements Backend {
  readonly name = "magi";
  readonly #url: string;
  readonly #contractId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(opts: MagiBackendOptions) {
    this.#url = opts.url ?? "https://api.vsc.eco/api/v1/graphql";
    this.#contractId = opts.contractId;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
      });
    } catch (cause) {
      throw new BackendError(`MAGI node unreachable at ${this.#url}`, undefined, cause);
    } finally {
      clearTimeout(timer);
    }

    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new BackendError(`MAGI GraphQL: ${body.errors.map((e) => e.message).join("; ")}`,
        res.status, body.errors);
    }
    if (!body.data) throw new BackendError("MAGI returned no data", res.status, body);
    return body.data;
  }

  /** Raw contract state by key — the primitive every read is built on. */
  async state(keys: string[]): Promise<Record<string, string>> {
    const data = await this.query<{ getStateByKeys: Record<string, string> | null }>(
      `query($id: String!, $keys: [String!]!) { getStateByKeys(contractId: $id, keys: $keys) }`,
      { id: this.#contractId, keys },
    );
    return data.getStateByKeys ?? {};
  }

  /** Current Hive height, which is MAGI's height space (3 seconds per unit). */
  async height(): Promise<number> {
    const data = await this.query<{ localNodeInfo: { last_processed_block: number } }>(
      `{ localNodeInfo { last_processed_block } }`,
    );
    return data.localNodeInfo.last_processed_block;
  }

  /**
   * An account's resource credits. Wired, because the RC guard depends on it.
   *
   * RC regenerates from staked balance and is what every transaction actually
   * costs — MAGI has no fees.
   */
  async resourceCredits(account: string): Promise<ResourceCredits | null> {
    const data = await this.query<{
      getAccountRC: { amount: number; max_rcs: number } | null;
    }>(
      `query($a: String!) { getAccountRC(account: $a) { amount max_rcs } }`,
      { a: account },
    );
    const rc = data.getAccountRC;
    return rc ? { amount: rc.amount, max: rc.max_rcs } : null;
  }

  /**
   * The values in force for governable parameters, read from raw state.
   *
   * Governance is a standing MEDIAN, not a stored number: there is no key
   * holding "the" volume threshold. What state holds is `gov_board` (up to 20
   * candidate accounts), each account's `shr_<account>` L-Shares, and each
   * member's `gov_<param>_<account>` preference row — the same reads a foreign
   * dApp contract makes against the frozen public ABI, and the same ones
   * `contract/state/governance.go EffectiveParam` makes internally.
   *
   * Those rows go straight to `engine.effectiveValue`, which ranks the board
   * into the top 10, clamps every preference into the parameter's hardcoded
   * bounds and takes the lower median. NONE of that happens here — the median
   * and the bounds are exactly the sort of formula that must never exist twice.
   * A member who has never voted has no row; the engine skips them rather than
   * counting a zero, and with no votes at all the registered default stands.
   *
   * Batched deliberately: one read for the board, one for every share and
   * preference row across all the parameters asked for. Returns BASE-UNIT
   * strings, ready to hand back to the engine.
   */
  async #governed(paramKeys: string[]): Promise<Record<string, string>> {
    const boardRaw = await this.state(["gov_board"]);
    const board = (boardRaw["gov_board"] ?? "").split("|").filter(Boolean);

    const keys = board.flatMap((a) =>
      ["shr_" + a, ...paramKeys.map((p) => `gov_${p}_${a}`)]);
    const rows = keys.length ? await this.state(keys) : {};

    const out: Record<string, string> = {};
    for (const p of paramKeys) {
      // An empty board is not a special case: the engine returns the
      // registered default for an empty member list, which is what a chain
      // with no consensus group is actually running.
      const r = engine.effectiveValue(p, board.map((a) => ({
        account: a,
        shares: rows["shr_" + a] ?? "0",
        preference: rows[`gov_${p}_${a}`] ?? null,
      })));
      if (!r.ok) {
        throw new BackendError(`${p} is not a governable parameter`);
      }
      out[p] = toUnits(r.value).toString();
    }
    return out;
  }

  /**
   * Chain overview, assembled from raw state keys.
   *
   * AGGREGATION ONLY — every figure here is read, none is derived. The one
   * derived list, the consensus group, goes through engine.ConsensusGroup via
   * the same board+shares reads a foreign dApp contract would use (see the
   * frozen public ABI in CLAUDE.md).
   */
  async chain(): Promise<ChainInfo> {
    const [st, height] = await Promise.all([
      this.state([
        // Burned = the null account's balance: burning credits hive:null
        // (provably unspendable), so the burn total is visible forever.
        // The old sup_burned counter is retired.
        "cfg_genesis", "cfg_settled", "sup_migrated", "sup_emitted",
        "cfg_migtotal", "cfg_migburn",
        "bal_hive:null", "shares_total", "pool_lshare", "pool_viral",
        "pool_deep", "pool_liq", "amm_lc", "amm_hbd", "amm_shares",
        "gov_board",
      ]),
      this.height(),
    ]);
    const board = (st["gov_board"] ?? "").split("|").filter(Boolean);
    const shr = board.length
      ? await this.state(board.map((a) => "shr_" + a))
      : {};
    const group = engine.consensusGroup(
      board.map((a) => ({ account: a, shares: shr["shr_" + a] ?? "0" })),
    ).map((m) => m.account);
    return {
      height,
      timestamp: new Date().toISOString(),
      epoch: 0, // the contract derives epochs from block timestamps it alone sees
      genesis_height: num(st["cfg_genesis"]),
      settled_height: num(st["cfg_settled"]),
      migrated_supply: units(st["sup_migrated"]),
      snapshot_total: units(String(
        BigInt(st["cfg_migtotal"] || "0") + BigInt(st["cfg_migburn"] || "0"))),
      total_emitted: units(st["sup_emitted"]),
      total_burned: units(st["bal_hive:null"]),
      total_shares: units(st["shares_total"]),
      pool_lshare: units(st["pool_lshare"]),
      pool_viral: units(st["pool_viral"]),
      pool_deep: units(st["pool_deep"]),
      pool_liquidity: units(st["pool_liq"]),
      amm_lc: units(st["amm_lc"]),
      amm_hbd: units(st["amm_hbd"]),
      amm_shares: units(st["amm_shares"]),
      consensus_group: group,
    };
  }

  /**
   * One account, with every displayed figure computed by the ENGINE.
   *
   * The mint records are decoded here (decoding is aggregation; the field
   * order is the frozen append-only layout in contract/state/codec.go), but
   * every derived number — pending yield, claim-now value, bleed fraction —
   * comes from the engine WASM. If a figure is needed that the bridge does not
   * expose, extend the bridge; never compute it here.
   */
  async account(name: string): Promise<AccountView> {
    const acct = name.includes(":") ? name : "hive:" + name;
    const base = await this.state([
      "bal_" + acct, "shr_" + acct, "pend_" + acct, "mseq_" + acct,
      "set_" + acct + "_days", "acc_per", "acc_day", "cfg_genesis",
      "gov_board",
    ]);
    const height = await this.height();
    const seq = num(base["mseq_" + acct]);

    const mintKeys: string[] = [];
    for (let id = 1; id <= seq; id++) mintKeys.push(`mint_${acct}_${id}`);
    const recs = mintKeys.length ? await this.state(mintKeys) : {};

    const genesis = num(base["cfg_genesis"]);
    // The day length comes from the ENGINE, never a literal: the TESTWINDOWS
    // build runs 120-height days (6 minutes), production 28,800. A hardcoded
    // 28_800 made maturity math 240x wrong against the test contract.
    const hpd = Number(engine.constants().heightsPerDay);
    const accPer = base["acc_per"] || "0";
    const accDay = num(base["acc_day"]);

    const mints = [];
    const accAtWanted = new Set<string>();
    const parsed: { id: number; f: string[] }[] = [];
    for (let id = 1; id <= seq; id++) {
      const raw = recs[`mint_${acct}_${id}`];
      if (!raw) continue;
      const f = raw.split("|");
      if (f.length < 6) continue;
      parsed.push({ id, f });
      const matDay = Math.floor(
        (num(f[2]) + Number(f[3]) * hpd - genesis) / hpd);
      if (accDay > matDay) accAtWanted.add("accAt_" + matDay);
    }
    const accAt = accAtWanted.size ? await this.state([...accAtWanted]) : {};

    for (const { id, f } of parsed) {
      const [principal, shares, startHeight, days, ga, ended] = f;
      const accStart = f[6] ?? "0";
      const start = num(startHeight);
      const nDays = Number(days);
      const maturity = start + nDays * hpd;
      const matDay = Math.floor((maturity - genesis) / hpd);
      const mature = height >= maturity;
      const accEnd =
        mature && accDay > matDay ? (accAt["accAt_" + matDay] || "0") : accPer;
      const accrued = engine.entitlement(shares ?? "0", accStart, accEnd);
      const view = engine.previewMintClose(
        {
          principal: units(principal), shares: units(shares),
          start_height: start, days: nDays, good_accounting: ga === "1",
        },
        height, toUnits(accrued).toString(),
      );
      mints.push({
        id,
        principal: units(principal),
        shares: units(shares),
        start_height: start,
        days: nDays,
        maturity_height: maturity,
        maturity_time: new Date(
          Date.now() + (maturity - height) * 3_000).toISOString(),
        mature,
        good_accounting: ga === "1",
        can_arm_good_accounting:
          !mature && ga !== "1" && height >= maturity - 7 * hpd,
        ended: ended === "1",
        pending_yield: ended === "1" ? "0.00000000" : accrued,
        if_claimed_now: view.toOwner,
        slashed_if_claimed_now: view.toRewardPool,
        bleed_remaining_pct: view.bleedRemaining,
      });
    }

    const board = (base["gov_board"] ?? "").split("|").filter(Boolean);
    return {
      account: acct,
      balance: units(base["bal_" + acct]),
      shares: units(base["shr_" + acct]),
      pending: units((base["pend_" + acct] ?? "0").split("|")[0]),
      pending_curation: 0, // informational only; needs the queue cursors
      mint_duration_days: num(base["set_" + acct + "_days"]) || 1095,
      // TODO: real HBD balance on MAGI is not wired up. The contract custodies
      // HBD as a real SDK asset, not contract state, so reading a user's
      // deposited-but-not-yet-in-the-pool HBD needs a node call we have not
      // identified yet (the pool's own HBD reserve is `amm_hbd`, which is NOT
      // this — it is the contract's, not the caller's). Leave at 0 rather than
      // guessing; the /pool page's liquidity panel treats 0 as "insufficient"
      // and disables "Add liquidity" accordingly, which is honest here.
      hbd: 0,
      vote_power: { viral: "0.00000000", deep: "0.00000000" },
      mints,
      tranches: [],
      is_consensus_member: board.includes(acct),
    };
  }
  /**
   * The feed, built from transaction history.
   *
   * The contract cannot enumerate posts (no unbounded iteration on-chain), so
   * DISCOVERY comes from `findTransaction byContract` — every `post` call ever
   * made names its author and permlink. The MONEY data then comes from the
   * post's state record, which is authoritative; history only tells us where
   * to look. A post register whose transaction failed simply has no record and
   * is dropped.
   */
  /**
   * Which posts exist, from transaction history.
   *
   * The contract cannot enumerate its own posts — unbounded iteration does not
   * fit in the gas budget — so DISCOVERY is history: every `post` call ever
   * made names its author and permlink. What is TRUE about each one still comes
   * from its state record; history only says where to look.
   */
  async #discover(limit: number): Promise<{ author: string; permlink: string }[]> {
    const data = await this.query<{
      findTransaction: {
        anchr_ts: string;
        required_auths: string[];
        ops: { type: string; data: { action?: string; payload?: string } }[];
      }[];
    }>(
      // MAGI rejects limit outside 1..100 — the node enforces the cap.
      `query($c: String!) { findTransaction(filterOptions: {byContract: $c, limit: 100}) {
        anchr_ts required_auths ops { type data } } }`,
      { c: this.#contractId },
    );

    // Newest-first discovery, deduped: re-registering a permlink is refused by
    // the contract, so the first sighting is the real one.
    const seen = new Set<string>();
    const found: { author: string; permlink: string }[] = [];
    for (const tx of data.findTransaction ?? []) {
      for (const op of tx.ops ?? []) {
        if (op.type !== "call" || op.data?.action !== "post") continue;
        const author = tx.required_auths?.[0];
        const permlink = (op.data.payload ?? "").split("|")[0];
        if (!author || !permlink) continue;
        const key = author + "/" + permlink;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ author, permlink });
        }
      }
      if (found.length >= limit) break;
    }
    return found;
  }

  /**
   * Post metadata with NO money in it, and — the point — no ENGINE either.
   *
   * `posts()` asks the engine for each post's pending payout, which means it
   * needs the WASM loaded. That is fine in a browser and impossible in an edge
   * worker, where the site is server-rendered. Everything a crawler, a sitemap
   * or an RSS feed needs is content: who wrote it, when, and which window it
   * is in. All three are in the record or derivable from block height.
   *
   * So this exists to keep server rendering free of the engine WITHOUT growing
   * a second implementation of anything — there is no arithmetic here beyond
   * turning a height difference into a timestamp, which is what the chain's own
   * 3-second block time means.
   */
  async postsMeta(limit = 50): Promise<PostMeta[]> {
    const found = await this.#discover(limit);
    if (found.length === 0) return [];

    const [records, height] = await Promise.all([
      this.state(found.map((p) => `post_${p.author}_${p.permlink}`)),
      this.height(),
    ]);

    const out: PostMeta[] = [];
    for (const { author, permlink } of found) {
      const raw = records[`post_${author}_${permlink}`];
      if (!raw) continue; // registered call failed, or record swept
      const f = raw.split("|");
      if (f.length < 6) continue;
      const created = Number(f[1] ?? 0) || 0;
      out.push({
        author,
        permlink,
        window: f[0] === "1" ? "deep" : "viral",
        created_height: created,
        created_time: new Date(Date.now() - (height - created) * 3_000).toISOString(),
        // Presentation fields live on the CONTENT layer (Hive). Never invented
        // here — the caller fetches them with content().
        title: "",
        summary: "",
        body_excerpt: "",
        tags: null,
      });
    }
    return out;
  }

  async posts(limit = 50): Promise<PostView[]> {
    const found = await this.#discover(limit);
    if (found.length === 0) return [];

    const [records, height] = await Promise.all([
      this.state(found.map((p) => `post_${p.author}_${p.permlink}`)),
      this.height(),
    ]);
    const pools = await this.state(["pool_viral", "pool_deep", "rsh_viral", "rsh_deep"]);
    const c = engine.constants();

    const views: PostView[] = [];
    for (const { author, permlink } of found) {
      const raw = records[`post_${author}_${permlink}`];
      if (!raw) continue; // registered call failed, or record swept
      // Frozen field order (contract/state/pob.go encodePost):
      // window|createdHeight|rshares|paidOut|curatorPot|curatorRshares|votes|mode|paidHeight
      const f = raw.split("|");
      if (f.length < 6) continue;
      const window = f[0] === "1" ? "deep" : "viral";
      const created = num(f[1]);
      const days = window === "deep" ? c.deepPayoutDays : c.viralPayoutDays;
      const payoutHeight = created + days * Number(c.heightsPerDay);
      const paidOut = f[3] === "1";
      const poolKey = window === "deep" ? "pool_deep" : "pool_viral";
      const rshKey = window === "deep" ? "rsh_deep" : "rsh_viral";
      views.push({
        author,
        permlink,
        window,
        created_height: created,
        created_time: new Date(Date.now() - (height - created) * 3_000).toISOString(),
        payout_height: payoutHeight,
        payout_time: new Date(Date.now() + (payoutHeight - height) * 3_000).toISOString(),
        rshares: f[2] ?? "0",
        payout_mode: num(f[7]),
        // Fields 10–12 (append-only): comment parent and promoted burn.
        parent_author: f[9] ?? "",
        parent_permlink: f[10] ?? "",
        promoted: units(f[11] ?? "0"),
        // Presentation fields live on the CONTENT layer (Hive); the feed
        // fetches them per post via content(). Empty here, never invented.
        title: permlink,
        summary: "",
        body_excerpt: "",
        tags: null,
        votes: num(f[6]),
        paid_out: paidOut,
        payable: !paidOut && height >= payoutHeight,
        pending_payout: paidOut
          ? "0.00000000"
          : engine.estimateRewardShare(
              pools[poolKey] || "0", f[2] || "0", pools[rshKey] || "0"),
        curator_pot: units(f[4]),
        // paidHeight + one year; 0 until paid, exactly like the record.
        curation_expires_at:
          num(f[8]) > 0 ? num(f[8]) + 365 * Number(c.heightsPerDay) : 0,
      });
    }
    return views;
  }

  /**
   * Who voted on a post, and with what weight.
   *
   * Same two-step shape as `posts()`, and for the same reason: the contract
   * cannot enumerate its own keys, so HISTORY says where to look and STATE says
   * what is true. `findTransaction byContract` yields every `vote` call ever
   * made; the ones whose payload names this post give us a candidate voter
   * list, and each candidate's `pv_` record supplies the authoritative rshares.
   *
   * A candidate with no record is DROPPED, not defaulted to zero. That covers a
   * vote whose transaction failed, one that was later re-cast (the contract
   * rewrites the same key, so the last value stands), and — the common case
   * after settlement — one whose curator has already been paid, which deletes
   * the record. Inventing a row for any of those would put a voter on screen
   * whose weight the chain no longer recognises.
   */
  async postVotes(author: string, permlink: string): Promise<PostVote[]> {
    const data = await this.query<{
      findTransaction: {
        required_auths: string[];
        ops: { type: string; data: { action?: string; payload?: string } }[];
      }[];
    }>(
      // MAGI rejects limit outside 1..100 — the node enforces the cap.
      `query($c: String!) { findTransaction(filterOptions: {byContract: $c, limit: 100}) {
        required_auths ops { type data } } }`,
      { c: this.#contractId },
    );

    // `vote` takes <author>|<permlink>|<weight>, so the prefix identifies the
    // post exactly. Matching on the prefix rather than splitting keeps a
    // permlink containing a pipe (which the contract would reject anyway) from
    // ever being read as a different post.
    const prefix = `${author}|${permlink}|`;
    const voters: string[] = [];
    const seen = new Set<string>();
    for (const tx of data.findTransaction ?? []) {
      for (const op of tx.ops ?? []) {
        if (op.type !== "call" || op.data?.action !== "vote") continue;
        if (!(op.data.payload ?? "").startsWith(prefix)) continue;
        const voter = tx.required_auths?.[0];
        if (!voter || seen.has(voter)) continue;
        seen.add(voter);
        voters.push(voter);
      }
    }
    if (voters.length === 0) return [];

    const records = await this.state(
      voters.map((v) => `pv_${author}_${permlink}_${v}`));

    const out: PostVote[] = [];
    for (const voter of voters) {
      const raw = records[`pv_${author}_${permlink}_${voter}`];
      // A MISSING KEY ON MAGI READS AS AN EMPTY STRING, not as absent.
      if (!raw) continue;
      out.push({ voter, rshares: raw });
    }
    // Heaviest first, then by name — the same order the dev chain returns, so
    // the two backends are interchangeable behind the UI.
    out.sort((a, b) => {
      const x = BigInt(a.rshares), y = BigInt(b.rshares);
      if (x !== y) return x > y ? -1 : 1;
      return a.voter < b.voter ? -1 : a.voter > b.voter ? 1 : 0;
    });
    return out;
  }

  /**
   * Article content, from Hive — where it actually lives. The contract stores
   * only the money; `author + permlink` is the same key the old tribe used.
   */
  async content(author: string, permlink: string): Promise<Content | null> {
    const hiveUser = author.replace(/^hive:/, "");
    const res = await this.#fetch("https://api.hive.blog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "condenser_api.get_content",
        params: [hiveUser, permlink],
        id: 1,
      }),
    });
    const body = (await res.json()) as {
      result?: { author?: string; title?: string; body?: string; json_metadata?: string };
    };
    const post = body.result;
    if (!post?.author) return null;
    let tags: string[] = [];
    let summary = "";
    try {
      const meta = JSON.parse(post.json_metadata || "{}");
      if (Array.isArray(meta.tags)) tags = meta.tags.slice(0, 10);
      if (typeof meta.description === "string") summary = meta.description;
    } catch {
      // malformed author metadata is the author's problem, not a crash
    }
    return { title: post.title ?? "", body: post.body ?? "", tags, summary };
  }
  /**
   * ⚠️ NOT WIRED. Publishing against a real chain is two signed operations and
   * both need a wallet, which lives in the frontend, not here.
   *
   * When it is wired it MUST go through `AiohaWallet.publishToHive()` rather
   * than calling `aioha.comment()` directly, because that is the one place that
   * attaches `canonical_url` and `app` to the post's `json_metadata` — the
   * claim that makes lassecash.com the original copy of the article on peakd,
   * ecency and every other Hive frontend. A publish path that skips it silently
   * hands that authority away. Order is fixed: Hive first, contract second (an
   * unregistered article is recoverable; a payout window over nothing is not).
   */
  publish(_i: unknown): Promise<PublishResult> {
    return Promise.reject(new BackendError(notWired("publish")));
  }

  /**
   * Swap preview. **ESTIMATE** — reserves move between this read and
   * broadcast, exactly like the dev chain's `/quote/swap` (node/sim/chain.go
   * `QuoteSwap`), which this mirrors field-for-field. `engine.estimateSwap`
   * does the whole calculation; this method only orients the reserves by
   * direction and converts base units to display units.
   */
  async quoteSwap(direction: SwapDirection, amountUnits: string): Promise<SwapQuote> {
    const st = await this.state(["amm_lc", "amm_hbd"]);
    const lcRes = st["amm_lc"] ?? "0";
    const hbdRes = st["amm_hbd"] ?? "0";
    const [reserveInUnits, reserveOutUnits] =
      direction === "hbd_lc" ? [hbdRes, lcRes] : [lcRes, hbdRes];

    const est = engine.estimateSwap(reserveInUnits, reserveOutUnits, amountUnits);
    return {
      amount_in: units(amountUnits),
      amount_out: est.amountOut,
      rate: est.rate,
      price_impact_pct: est.priceImpactPct,
      reserve_in: units(reserveInUnits),
      reserve_out: units(reserveOutUnits),
      ok: est.ok,
      msg: est.ok ? "" : "swap not possible at this size",
    };
  }

  /**
   * Mint preview. The share formula and both multipliers are EXACT — every
   * input either comes from chain state (share rate) or the caller (amount,
   * days) — computed by `engine.mintQuote`, mirroring the dev chain's
   * `/quote/mint` (node/sim/chain.go `QuoteMint`).
   *
   * The Bigger-Pays-Better volume thresholds are GOVERNABLE, so they are READ,
   * never assumed: `#governed` pulls `gov_board`, the members' L-Shares and
   * their standing preference rows out of state and the engine turns them into
   * the median in force. A quote therefore tracks the top 10 the moment they
   * move a threshold, instead of quietly quoting the registry default the
   * chain has stopped using. The parameter keys come from the engine too — a
   * key typed as a literal here could drift from the registry that owns it.
   */
  async quoteMint(amountUnits: string, days: number): Promise<MintQuote> {
    const c = engine.constants();
    const [st, height, gov] = await Promise.all([
      this.state(["cfg_genesis"]),
      this.height(),
      this.#governed([c.paramVolumeStart, c.paramVolumeEnd]),
    ]);
    const genesis = num(st["cfg_genesis"]);
    const rate = engine.shareRate(genesis, height);

    const q = engine.mintQuote(
      amountUnits, days, toUnits(rate).toString(),
      gov[c.paramVolumeStart]!, gov[c.paramVolumeEnd]!);
    const maturityHeight = height + days * Number(c.heightsPerDay);

    return {
      principal: units(amountUnits),
      days,
      shares: q.shares,
      share_rate: rate,
      duration_multiplier: q.durationMultiplier,
      volume_multiplier: q.volumeMultiplier,
      combined_multiplier: q.combinedMultiplier,
      maturity_height: maturityHeight,
      maturity_time: new Date(Date.now() + (maturityHeight - height) * 3_000).toISOString(),
      ok: q.ok,
      msg: q.ok ? "" : "mint not valid: check amount and duration (1..1095 days)",
    };
  }

  /**
   * Liquidity-deposit preview. **ESTIMATE** — reserves move between this
   * read and broadcast. `engine.estimateLiquidity` computes `hbdNeeded` and
   * `shares`; mirrors the dev chain's `/quote/liquidity`
   * (node/sim/chain.go `QuoteLiquidity`).
   *
   * The bridge's `liquidityQuote` does not return a pool-share percentage
   * (`api/engine-wasm/main.go` only returns `hbdNeeded`/`shares`), so rather
   * than compute the ratio in TypeScript — banned by the golden rule even
   * though BigInt makes it numerically safe — this reuses
   * `engine.estimateRewardShare`, whose formula
   * (`pool * userShares / totalShares`, floored) is IDENTICAL to the ratio
   * the dev chain computes server-side for this same field
   * (`engine.MulDiv(shares, 100*Unit, newTotal)`). Passing a pool of
   * "100.00000000" makes the result exactly the percentage, still computed
   * entirely inside the engine.
   */
  async quoteLiquidity(amountUnits: string): Promise<LiquidityQuote> {
    const st = await this.state(["amm_lc", "amm_hbd", "amm_shares"]);
    const lcRes = st["amm_lc"] ?? "0";
    const hbdRes = st["amm_hbd"] ?? "0";
    const totalShares = st["amm_shares"] ?? "0";

    const est = engine.estimateLiquidity(amountUnits, lcRes, hbdRes, totalShares);

    let poolSharePct = "0.00000000";
    if (est.ok) {
      const newShares = toUnits(est.shares);
      const newTotal = BigInt(totalShares || "0") + newShares;
      if (newTotal > 0n) {
        const hundredPct = (100n * BigInt(engine.constants().unit)).toString();
        poolSharePct = engine.estimateRewardShare(
          hundredPct, newShares.toString(), newTotal.toString());
      }
    }

    return {
      lc_in: units(amountUnits),
      hbd_needed: est.hbdNeeded,
      shares: est.shares,
      pool_share_pct: poolSharePct,
      is_first_deposit: est.isFirstDeposit,
      ok: est.ok,
      msg: est.ok ? "" : "liquidity deposit not valid: check amount and pool reserves",
    };
  }
}

/** Raw base-unit string (or missing key) -> 8dp decimal Amount string. */
function units(raw: string | undefined): string {
  const v = BigInt(raw || "0");
  const neg = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  return `${neg}${abs / 100_000_000n}.${(abs % 100_000_000n).toString().padStart(8, "0")}`;
}

function num(raw: string | undefined): number {
  return Number(raw || "0");
}

function notWired(what: string): string {
  return `MagiBackend.${what} is not wired yet. ` +
    `Reads need the deployed contract id; quotes must go through ` +
    `simulateContractCalls so the ENGINE computes them, never this layer.`;
}

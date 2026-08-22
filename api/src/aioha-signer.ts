/**
 * Hive wallet signing, via Aioha.
 *
 * Aioha is a thin adapter over the wallets users already have — Keychain,
 * HiveAuth, PeakVault, HiveSigner. **No key ever reaches us.** The user's
 * wallet holds it, shows them what they are signing, and returns a signature.
 * There is nothing for LasseCash to store or protect.
 *
 * It covers BOTH chains we need, which is why there is no second signing path:
 *   - `vscCallContract` signs a MAGI contract call
 *   - `comment` publishes an article to Hive
 *   - `signMessage` produces the signature Hive's image server requires
 *
 * KEY TYPES MATTER. Posting authority covers content and image upload; it
 * cannot move funds. Anything touching value uses ACTIVE authority, so a site
 * compromise cannot drain an account that only ever granted posting.
 */
import { Aioha, KeyTypes, Providers } from "@aioha/aioha";
import { BackendError, MaxSideCalls, type Signer, type SubmitOptions } from "./backend.js";
import { commentMetadata, postMetadata } from "./hive-metadata.js";
import type { TxResult } from "./types.js";

export { KeyTypes, Providers };

/** Which wallets to offer. */
export interface AiohaOptions {
  /** The deployed LasseCash contract id on MAGI. */
  contractId: string;
  /** MAGI node GraphQL endpoint, for free pre-flight simulation. */
  chainUrl?: string;
  /** MAGI network id. Omit for mainnet. */
  netId?: string;
  /**
   * RC ceiling for a contract call.
   *
   * MAGI has no fees — RC is the entire cost — so this is the user's spending
   * limit for one call, not a gas price. Too low and legitimate calls fail;
   * too high and a buggy call can eat an account's whole meter.
   */
  rcLimit?: number;
  keychain?: boolean;
  /** HiveAuth needs app metadata to show the user who is asking. */
  hiveAuth?: { name: string; description?: string; icon?: string } | false;
  /**
   * The canonical origin, e.g. `https://lassecash.com`.
   *
   * Written into every published post's `canonical_url` so that peakd, ecency
   * and every other Hive frontend point their canonical tag back here. The
   * indexer must not hardcode the site's address, so the frontend passes it in.
   */
  siteUrl?: string;
  peakVault?: boolean;
  hiveSigner?: { app: string; callbackURL: string; scope: string[] };
}

/** A wallet the user can pick. */
export interface WalletOption {
  id: Providers;
  label: string;
  /** False when the wallet is not installed or otherwise unavailable. */
  available: boolean;
}

/**
 * Creates and holds one Aioha instance.
 *
 * One per app: Aioha keeps session state, and a second instance would silently
 * disagree with the first about who is logged in.
 */
export class AiohaWallet {
  readonly aioha: Aioha;
  readonly #contractId: string;
  readonly #rcLimit: number;
  /** Canonical origin written into every published post. */
  readonly siteUrl: string;

  readonly #netId: string;
  readonly #chainUrl: string;

  constructor(opts: AiohaOptions) {
    this.aioha = new Aioha();
    this.#contractId = opts.contractId;
    this.siteUrl = (opts.siteUrl ?? "https://lassecash.com").replace(/\/+$/, "");
    // ⚠️ The limit itself is FROZEN for MAGI's 5-day RC thaw, not just what
    // the call uses. A generous default here would quietly lock users out of
    // the chain for days after a handful of transactions.
    this.#rcLimit = opts.rcLimit ?? 1_500;

    if (opts.keychain !== false) this.aioha.registerKeychain();
    if (opts.hiveAuth !== false) {
      // The name is shown in the user's authenticator, so it must identify us.
      this.aioha.registerHiveAuth(
        opts.hiveAuth ?? { name: "LasseCash", description: "AnCap society tools" },
      );
    }
    if (opts.peakVault !== false) this.aioha.registerPeakVault();
    if (opts.hiveSigner) this.aioha.registerHiveSigner(opts.hiveSigner);
    this.#netId = opts.netId ?? "vsc-mainnet";
    this.#chainUrl = opts.chainUrl ?? "https://api.vsc.eco/api/v1/graphql";
    if (opts.netId) this.aioha.vscSetNetId(opts.netId);
  }

  /**
   * Wallets available right now.
   *
   * Availability is checked rather than assumed: offering Keychain to someone
   * without the extension is a dead end they cannot diagnose.
   */
  wallets(): WalletOption[] {
    const labels: Partial<Record<Providers, string>> = {
      [Providers.Keychain]: "Hive Keychain",
      [Providers.PeakVault]: "PeakVault",
      [Providers.HiveAuth]: "HiveAuth",
      [Providers.HiveSigner]: "HiveSigner",
    };
    return (Object.keys(labels) as Providers[]).map((id) => ({
      id,
      label: labels[id] ?? id,
      available: this.aioha.isProviderRegistered(id) && this.aioha.isProviderEnabled(id),
    }));
  }

  /** Restore a session saved by a previous visit. */
  restore(): string | null {
    this.aioha.loadAuth();
    return this.aioha.isLoggedIn() ? (this.aioha.getCurrentUser() ?? null) : null;
  }

  get user(): string | null {
    return this.aioha.isLoggedIn() ? (this.aioha.getCurrentUser() ?? null) : null;
  }

  /**
   * Log in with a wallet.
   *
   * Requests POSTING authority: it is enough to publish and to upload images,
   * and it cannot move funds. Value operations request active authority per
   * call, so the user is asked at the moment it matters rather than handing
   * over spending power at the door.
   */
  async login(provider: Providers, username: string): Promise<string> {
    const res = await this.aioha.login(provider, username, {
      msg: `Sign in to LasseCash as @${username}`,
      keyType: KeyTypes.Posting,
      loginTitle: "LasseCash",
    });
    if (!res.success) {
      throw new BackendError(res.error || "login failed", res.errorCode);
    }
    const user = this.aioha.getCurrentUser();
    if (!user) throw new BackendError("logged in but no user returned");
    return user;
  }

  logout(): Promise<unknown> {
    return this.aioha.logout();
  }

  /**
   * Publish an article to Hive.
   *
   * Content lives on Hive; the LasseCash contract only tracks the money. So
   * publishing is this call, THEN a contract call to open the payout window —
   * in that order, because a registered post with no body is recoverable and
   * the reverse is not.
   */
  async publishToHive(input: {
    permlink: string;
    title: string;
    body: string;
    tags: string[];
    summary?: string;
    /** Cover image, if the body has one. */
    image?: string | null;
  }): Promise<void> {
    const author = this.aioha.getCurrentUser();
    if (!author) throw new BackendError("not signed in");

    // The first tag is the Hive community/category, and `lassecash` is what
    // makes a post visible to the tribe at all.
    const tags = ["lassecash", ...input.tags.filter((t) => t !== "lassecash")].slice(0, 21);

    // CANONICAL OWNERSHIP. `canonical_url` is what makes lassecash.com the
    // original copy of this article on every other Hive frontend — see
    // hive-metadata.ts for why that matters and who honours it.
    const meta = postMetadata({
      author,
      permlink: input.permlink,
      tags,
      summary: input.summary ?? "",
      image: input.image ?? null,
      siteUrl: this.siteUrl,
    });

    const res = await this.aioha.comment(
      null,
      tags[0] ?? "lassecash",
      input.permlink,
      input.title,
      input.body,
      meta,
    );
    if (!res.success) {
      throw new BackendError(res.error || "publish to Hive failed", res.errorCode);
    }
  }

  /**
   * Publish a REPLY to Hive.
   *
   * The same `comment` operation an article uses, with `parent_author` and
   * `parent_permlink` set and no title — that is all a Hive reply is. It goes
   * out with `commentMetadata()` so it carries the same `app` and
   * `canonical_url` claim an article does: a reply rendered on four frontends
   * with no canonical is the same duplicate-content problem, and comment
   * threads are exactly the long-tail text that gets indexed against somebody
   * else's domain by default.
   *
   * The permlink is supplied by the caller (the client derives it once) because
   * the contract's `comment` registration must use the identical string, or the
   * reward attaches to nothing.
   */
  async publishCommentToHive(input: {
    permlink: string;
    body: string;
    /** May be qualified (`hive:alice`) or bare — normalised here. */
    parentAuthor: string;
    parentPermlink: string;
    tags?: string[];
  }): Promise<void> {
    const author = this.aioha.getCurrentUser();
    if (!author) throw new BackendError("not signed in");

    const parentAuthor = input.parentAuthor.replace(/^hive:/, "").replace(/^@/, "");
    const tags = input.tags?.length ? input.tags.slice(0, 10) : ["lassecash"];

    const meta = commentMetadata({
      author,
      permlink: input.permlink,
      tags,
      siteUrl: this.siteUrl,
      parentAuthor,
      parentPermlink: input.parentPermlink,
    });

    // A Hive reply is a comment whose parent is a post rather than a category,
    // and whose title is empty. Everything else is identical to publishing.
    const res = await this.aioha.comment(
      parentAuthor,
      input.parentPermlink,
      input.permlink,
      "",
      input.body,
      meta,
    );
    if (!res.success) {
      throw new BackendError(res.error || "publish comment to Hive failed", res.errorCode);
    }
  }


  /**
   * Dry-run a call on the node — free, no wallet, no broadcast. Returns the
   * gas it would use, or the contract's refusal.
   *
   * Two things ride on this. (1) RC sizing: a static per-entrypoint limit
   * cannot know how far the accrual walk lags at the moment of the call, and
   * mainnet weighs state writes 19x in gas — a real mint and a real vote both
   * hit `cost limit exceeded` under table limits on 2026-08-22. (2) Refusals
   * before the wallet: a call the chain would refuse ("insufficient balance")
   * is reported here, and no Keychain popup is ever shown for it.
   */
  async simulate(account: string, action: string, payload: string, intents: unknown[]): Promise<
    { ok: true; gas: number } | { ok: false; msg: string; gasLimitHit: boolean }
  > {
    const res = await fetch(this.#chainUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($i: SimulateContractCallsInput!) {
          simulateContractCalls(input: $i) { success err_msg gas_used } }`,
        variables: { i: {
          tx_id: "sim", required_auths: account,
          calls: [{ contract_id: this.#contractId, action, payload, rc_limit: 100_000, intents }],
        } },
      }),
    });
    const body = (await res.json()) as {
      data?: { simulateContractCalls?: { success: boolean; err_msg?: string | null; gas_used: number }[] };
    };
    const r = body.data?.simulateContractCalls?.[0];
    if (!r) throw new BackendError("simulation returned nothing");
    if (r.success) return { ok: true, gas: r.gas_used };
    const msg = r.err_msg ?? "refused";
    return { ok: false, msg, gasLimitHit: /gas_limit|cost limit/i.test(msg) };
  }

  /**
   * The account's RC right now. `getAccountRC` errors for an account the node
   * has no record for — that is a FRESH account, which holds exactly the free
   * allowance, so report that rather than nothing.
   */
  async availableRc(account: string): Promise<number | null> {
    try {
      const res = await fetch(this.#chainUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query($a: String!) { getAccountRC(account: $a) { amount max_rcs } }`,
          variables: { a: account },
        }),
      });
      const body = (await res.json()) as { data?: { getAccountRC?: { amount: number } | null } };
      const rc = body.data?.getAccountRC;
      if (rc && typeof rc.amount === "number") return rc.amount;
      return AiohaWallet.FREE_RC;
    } catch {
      return null;
    }
  }
  /** RC every hive: account has without staking anything on MAGI (rc-system/). */
  static readonly FREE_RC = 10_000;

  /**
   * ONE confirm for publishing: the Hive `comment` and the contract's
   * `vsc.call` registration travel in the SAME Hive transaction, signed once
   * with the posting key. Lasse 2026-08-22: Hive-Engine never asked twice.
   * Beyond the UX, this makes the two-step atomic — there is no longer a way
   * to end up with an article on Hive and no payout window, or the reverse.
   * The custom_json is byte-for-byte what Aioha's own `vscCallContract`
   * broadcasts, so MAGI sees an ordinary contract call.
   */
  async broadcastWithCall(
    hiveOps: unknown[],
    call: { action: string; payload: string; rcLimit: number; intents: unknown[] },
    contractId: string,
  ): Promise<TxResult> {
    return this.#broadcast([...hiveOps, this.#vscOp(call, contractId, KeyTypes.Posting)], KeyTypes.Posting);
  }

  /** Several contract calls in one signed transaction (a user's call + side calls). */
  async broadcastCalls(
    calls: { action: string; payload: string; rcLimit: number; intents: unknown[] }[],
    contractId: string,
    keyType: KeyTypes,
  ): Promise<TxResult> {
    return this.#broadcast(calls.map((c) => this.#vscOp(c, contractId, keyType)), keyType);
  }

  #vscOp(
    call: { action: string; payload: string; rcLimit: number; intents: unknown[] },
    contractId: string,
    keyType: KeyTypes,
  ): unknown {
    const user = this.aioha.getCurrentUser();
    if (!user) throw new BackendError("not signed in");
    return ["custom_json", {
      required_auths: keyType === KeyTypes.Active ? [user] : [],
      required_posting_auths: keyType === KeyTypes.Posting ? [user] : [],
      id: "vsc.call",
      json: JSON.stringify({
        net_id: this.#netId,
        contract_id: contractId,
        action: call.action,
        payload: call.payload,
        rc_limit: call.rcLimit,
        intents: call.intents,
      }),
    }];
  }

  async #broadcast(ops: unknown[], keyType: KeyTypes): Promise<TxResult> {
    // Aioha types operations loosely; the shapes above are Hive's own.
    const res = await this.aioha.signAndBroadcastTx(
      ops as Parameters<Aioha["signAndBroadcastTx"]>[0],
      keyType,
    );
    return {
      ok: !!res.success,
      msg: res.success ? "submitted" : (res.error ?? "rejected"),
      height: 0,
      txId: res.success && typeof res.result === "string" ? res.result : undefined,
    };
  }

  /** The Hive `comment` operation for an article, with our metadata. */
  articleOp(input: {
    permlink: string; title: string; body: string; tags: string[];
    summary?: string; image?: string | null;
  }): unknown {
    const author = this.aioha.getCurrentUser();
    if (!author) throw new BackendError("not signed in");
    const tags = ["lassecash", ...input.tags.filter((t) => t !== "lassecash")].slice(0, 21);
    const meta = postMetadata({
      author, permlink: input.permlink, tags,
      summary: input.summary ?? "", image: input.image ?? null, siteUrl: this.siteUrl,
    });
    return ["comment", {
      parent_author: "", parent_permlink: tags[0] ?? "lassecash",
      author, permlink: input.permlink, title: input.title, body: input.body,
      json_metadata: typeof meta === "string" ? meta : JSON.stringify(meta),
    }];
  }

  /** The Hive `comment` operation for a reply, with our metadata. */
  replyOp(input: {
    permlink: string; body: string; parentAuthor: string; parentPermlink: string;
  }): unknown {
    const author = this.aioha.getCurrentUser();
    if (!author) throw new BackendError("not signed in");
    const parentAuthor = input.parentAuthor.replace(/^hive:/, "").replace(/^@/, "");
    const meta = commentMetadata({
      author, permlink: input.permlink, tags: ["lassecash"], siteUrl: this.siteUrl,
      parentAuthor, parentPermlink: input.parentPermlink,
    });
    return ["comment", {
      parent_author: parentAuthor, parent_permlink: input.parentPermlink,
      author, permlink: input.permlink, title: "", body: input.body,
      json_metadata: typeof meta === "string" ? meta : JSON.stringify(meta),
    }];
  }

  /**
   * Upload an image to Hive's own image server.
   *
   * `POST https://images.hive.blog/:username/:signature`, where the signature
   * is over sha256("ImageSigningChallenge" + imageData) with the POSTING key.
   * We use Hive's host rather than our own because every existing Hive post
   * depends on it staying up, so it is maintained far beyond anything we could
   * justify running.
   *
   * VERIFIED AGAINST KEYCHAIN 2026-08-22 — and the first attempt was wrong.
   * Keychain's `signBuffer` HASHES whatever message it is handed and signs
   * that hash. hive.blog therefore hands it the raw bytes of the challenge,
   * serialised the way Node prints a Buffer: `{"type":"Buffer","data":[...]}`
   * — Keychain recognises that shape, rebuilds the bytes, and signs
   * sha256(bytes), which is exactly what the image server verifies. Passing a
   * hex digest instead (the first version) made Keychain sign sha256(hex
   * text) and the server refused the upload. Same shape every provider
   * following Keychain's API accepts.
   */
  async uploadImage(file: Blob, username: string): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());

    const challenge = new TextEncoder().encode("ImageSigningChallenge");
    const payload = new Uint8Array(challenge.length + bytes.length);
    payload.set(challenge, 0);
    payload.set(bytes, challenge.length);

    const message = JSON.stringify({ type: "Buffer", data: Array.from(payload) });
    const signed = await this.aioha.signMessage(message, KeyTypes.Posting);
    if (!signed.success) {
      throw new BackendError(signed.error || "image signing failed", signed.errorCode);
    }

    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`https://images.hive.blog/${username}/${signed.result}`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      throw new BackendError(`image upload failed (${res.status})`, res.status);
    }
    const body = (await res.json()) as { url?: string };
    if (!body.url) throw new BackendError("image server returned no url");
    return body.url;
  }

  /** A Signer bound to this wallet, for contract calls. */
  signer(): Signer {
    const user = this.user;
    if (!user) throw new BackendError("not logged in");
    return new AiohaSigner(this, user, this.#contractId, this.#rcLimit);
  }
}

/**
 * Signs LasseCash contract calls through the user's wallet.
 *
 * Entrypoint names and pipe-delimited arguments are IDENTICAL to the dev
 * chain's, so nothing above this layer changes when moving from the simulator
 * to MAGI. That was the point of keeping the two in step.
 */
export class AiohaSigner implements Signer {
  constructor(
    private readonly wallet: AiohaWallet,
    readonly account: string,
    private readonly contractId: string,
    private readonly rcLimit: number,
  ) {}

  /**
   * Operations that move value require ACTIVE authority.
   *
   * Posting authority is what a user grants to a website; if a compromised
   * frontend could mint or transfer with it, signing in would mean handing
   * over the account. Voting and publishing stay on posting.
   */
  static readonly ACTIVE_OPS = new Set([
    "transfer", "burn", "mint", "claim_mint", "good_accounting",
    // promote_post BURNS the caller's LASSECASH. Posting authority must never
    // be able to destroy money — see CLAUDE.md, the key-type split.
    "promote_post",
    "add_liquidity", "remove_liquidity", "claim_pool",
    "swap_lc_hbd", "swap_hbd_lc", "migrate", "migrate_batch",
    // claim_migration credits the caller's snapshot balance and creates their
    // migration mint — it moves value TO them, which is still value, and
    // posting authority must never be able to touch it.
    "claim_migration",
    // record_burn is deliberately NOT here: it moves nothing (null was
    // credited when the root was committed) and writing someone's receipt is
    // a public good anyone should be able to do cheaply.
  ]);

  /**
   * Entrypoints that DRAW REAL HBD from the caller, and where in their
   * pipe-delimited args the maximum draw sits (in 8dp base units).
   *
   * These calls need a `transfer.allow` intent or the chain rejects them with
   * "no caller intent for: hbd" — verified against the deployed contract via
   * simulateContractCalls, 2026-08-21. LASSECASH itself never needs an intent
   * (it is contract-managed); only the HBD side does.
   */
  /**
   * rc_limit PER ENTRYPOINT, from MEASURED gas (local MAGI devnet, 2026-08-21;
   * 100,000 gas = 1 RC) with ~60% headroom. Two failure modes bracket this
   * table, and both are silent in production:
   *   - too LOW and the call dies with gas_limit_hit (a mint at the old
   *     flat 1,500 default would have failed: it costs 2,401 RC);
   *   - too HIGH and MAGI freezes the whole limit for 5 days — six calls at
   *     100,000 locked the deployer out for days.
   * Unmeasured entrypoints get a conservative middle value; measure and
   * tighten on the devnet before launch.
   *
   * A mint also runs the accrual walk for any days nobody has touched; on a
   * live chain that is one day or zero. After a long silence the contract
   * refuses with "call advance" rather than ambushing the minter, so the
   * limit here never needs to cover a catch-up walk.
   */
  static readonly RC_LIMITS: Record<string, number> = {
    transfer: 600,        // measured 285
    burn: 600,
    settle: 400,
    advance: 4_000,       // no-op 100; one ordinary day ~5,000 gas => tiny; slices are the caller's choice
    mint: 7_000,          // measured 2,401 on the devnet, 3,142 simulated on mainnet — and a REAL mint hit gas_limit_hit at 4,000 when a day-step landed inside it (2026-08-22). Mainnet weighs writes 19x; keep ~2x headroom.
    claim_mint: 7_000,
    sweep_mint: 7_000,
    good_accounting: 800,
    set_duration: 400,
    settle_pending: 6_000, // drains up to MaxCurationDrain queue entries
    promote: 1_200,
    set_param: 800,
    post: 2_500,
    // A reply is the same write set as a post: one record, one threshold read.
    comment: 2_500,
    // Debit, burn to null, rewrite the post record. Unmeasured on a real
    // deploy — measure with simulateContractCalls before launch.
    promote_post: 2_500,
    vote: 4_000,          // includes PiggybackDrain curation settles
    payout: 4_000,
    claim_curation: 1_200,
    sweep_curation: 1_200,
    add_liquidity: 4_000,
    remove_liquidity: 4_000,
    claim_pool: 4_000,
    swap_lc_hbd: 3_000,
    swap_hbd_lc: 3_000,
    // A claim is a mint-sized write set (balance, mint record, share board,
    // accrual) plus ~14 Merkle hashes to walk the proof to the root.
    claim_migration: 9_500,  // measured worst case 5,892 (staked claim that takes a board seat); liquid-only 1,042, matured 1,327 — the claim page passes 2,500 for those
    // A receipt is one state write and the same proof walk, nothing else.
    record_burn: 1_000,      // measured 590
  };

  static readonly HBD_DRAW_OPS: Record<string, number> = {
    add_liquidity: 1, // <lcAmount>|<maxHbd>
    swap_hbd_lc: 0, //   <hbdIn>|<minOut>
  };

  /** 8dp base units -> the "1.234" HBD string an intent limit wants (3dp). */
  static hbdLimit(baseUnits: string): string {
    const n = BigInt(baseUnits);
    // Round UP to the next milli-HBD: an intent is a ceiling, and a floor here
    // could deny the draw by a rounding hair.
    const milli = (n + 99_999n) / 100_000n;
    const whole = milli / 1000n;
    const frac = (milli % 1000n).toString().padStart(3, "0");
    return `${whole}.${frac}`;
  }

  /** Article + registration in ONE signed transaction (see broadcastWithCall). */
  async publishAndRegister(input: {
    permlink: string; title: string; body: string; tags: string[];
    summary?: string; image?: string | null; window: number; payoutMode: number;
  }): Promise<TxResult> {
    const payload = `${input.permlink}|${input.window}|${input.payoutMode}`;
    const rcLimit = await this.sizeRc("post", payload, [], AiohaSigner.RC_LIMITS["post"] ?? this.rcLimit);
    if (typeof rcLimit !== "number") return rcLimit;
    return this.wallet.broadcastWithCall(
      [this.wallet.articleOp(input)],
      { action: "post", payload, rcLimit, intents: [] },
      this.contractId,
    );
  }
  /** Reply + registration in ONE signed transaction. */
  async commentAndRegister(input: {
    permlink: string; body: string; parentAuthor: string; parentPermlink: string; payoutMode: number;
  }): Promise<TxResult> {
    const parent = input.parentAuthor.replace(/^@/, "");
    const qualified = parent.startsWith("hive:") ? parent : `hive:${parent}`;
    const payload = `${input.permlink}|${qualified}|${input.parentPermlink}|${input.payoutMode}`;
    const rcLimit = await this.sizeRc("comment", payload, [], AiohaSigner.RC_LIMITS["comment"] ?? this.rcLimit);
    if (typeof rcLimit !== "number") return rcLimit;
    return this.wallet.broadcastWithCall(
      [this.wallet.replyOp(input)],
      { action: "comment", payload, rcLimit, intents: [] },
      this.contractId,
    );
  }

  /** Content-layer writes, forwarded to the wallet (posting authority). */
  publishToHive(input: {
    permlink: string; title: string; body: string; tags: string[];
    summary?: string; image?: string | null;
  }): Promise<void> {
    return this.wallet.publishToHive(input);
  }
  publishCommentToHive(input: {
    permlink: string; body: string; parentAuthor: string; parentPermlink: string;
  }): Promise<void> {
    return this.wallet.publishCommentToHive(input);
  }

  /** Gas → RC on MAGI: 100,000 cycles per RC (node source, rc-system/). */
  static readonly GAS_PER_RC = 100_000;
  /**
   * Headroom over the simulated figure. The simulator does not weigh state
   * writes the way settlement does (19x), so a walk-heavy call lands well
   * above its simulated gas; 3x has covered every case observed so far. The
   * limit is FROZEN for the 5-day thaw, not spent, so headroom is cheap.
   */
  static readonly RC_HEADROOM = 3;
  /** Never freeze more than this for one call, whatever the simulation says. */
  static readonly RC_CEILING = 30_000;

  /**
   * Size the RC limit from a dry run of the exact call: max(table, 3x simulated),
   * capped. Returns a refusal TxResult instead when the chain would refuse the
   * call outright, so the caller never opens the wallet for it. If the node
   * cannot simulate (network hiccup), fall back to the table.
   */
  async sizeRc(entrypoint: string, args: string, intents: unknown[], tableLimit: number): Promise<number | TxResult> {
    let sim: Awaited<ReturnType<AiohaWallet["simulate"]>>;
    try {
      sim = await this.wallet.simulate(this.account, entrypoint, args, intents);
    } catch {
      return tableLimit;
    }
    if (!sim.ok) {
      if (sim.gasLimitHit) {
        return { ok: false, msg: "this call would exceed the per-call gas ceiling — call advance first to close the accrual gap", height: 0 };
      }
      return { ok: false, msg: sim.msg, height: 0 };
    }
    const need = Math.ceil(sim.gas / AiohaSigner.GAS_PER_RC);
    const sized = Math.min(AiohaSigner.RC_CEILING, Math.max(tableLimit, need * AiohaSigner.RC_HEADROOM));
    // Never ask for more than the account has: the limit is admission-checked
    // against AVAILABLE RC ("minimum RC requirement is not met"), so a fresh
    // account's 10,000 must be able to carry a claim. Headroom gives way
    // first; below 1.3x the simulated need the call is not worth sending.
    const avail = await this.wallet.availableRc(this.account);
    if (avail !== null && sized > avail) {
      const floor = Math.ceil(need * 1.3);
      if (avail < floor) {
        return {
          ok: false, height: 0,
          msg: `not enough resource credits: this call needs about ${floor.toLocaleString()} RC and the account has ${avail.toLocaleString()}. RC thaws over 5 days; staking HBD on MAGI raises the meter.`,
        };
      }
      return avail;
    }
    return sized;
  }

  async submit(entrypoint: string, args: string, opts?: SubmitOptions): Promise<TxResult> {
    const keyType = AiohaSigner.ACTIVE_OPS.has(entrypoint)
      ? KeyTypes.Active
      : KeyTypes.Posting;

    // Attach an HBD allowance exactly as large as the call can draw. The
    // intent is what the user's wallet shows and signs, so it must never be
    // broader than the entrypoint's own argument.
    const drawArg = AiohaSigner.HBD_DRAW_OPS[entrypoint];
    const intents =
      drawArg === undefined
        ? []
        : [
            {
              type: "transfer.allow",
              args: {
                token: "hbd",
                limit: AiohaSigner.hbdLimit(args.split("|")[drawArg] ?? "0"),
              },
            },
          ];

    // Per-entrypoint limit from measurement; the constructor's value is only
    // the fallback for an entrypoint this table does not know.
    const tableLimit = opts?.rcLimit ?? AiohaSigner.RC_LIMITS[entrypoint] ?? this.rcLimit;
    const rcLimit = await this.sizeRc(entrypoint, args, intents, tableLimit);
    if (typeof rcLimit !== "number") return rcLimit; // the chain would refuse: say so, no popup

    // Side calls (settlements riding along) go in the same transaction. Each
    // is sized from its own dry run; one that would be refused is dropped —
    // it was never the user's call, so it must never block theirs.
    const side: { action: string; payload: string; rcLimit: number; intents: unknown[] }[] = [];
    for (const sc of (opts?.sideCalls ?? []).slice(0, MaxSideCalls)) {
      const lim = await this.sizeRc(sc.entrypoint, sc.args, [], AiohaSigner.RC_LIMITS[sc.entrypoint] ?? this.rcLimit);
      if (typeof lim === "number") side.push({ action: sc.entrypoint, payload: sc.args, rcLimit: lim, intents: [] });
    }
    if (side.length > 0) {
      return this.wallet.broadcastCalls(
        [{ action: entrypoint, payload: args, rcLimit, intents }, ...side],
        this.contractId,
        keyType,
      );
    }

    const res = await this.wallet.aioha.vscCallContract(
      this.contractId,
      entrypoint,
      args,
      rcLimit,
      intents,
      keyType,
    );

    // A rejected transaction is a result the UI must show, not an exception to
    // swallow — the user needs to know the chain refused and why.
    return {
      ok: !!res.success,
      msg: res.success ? (res.result ?? "submitted") : (res.error ?? "rejected"),
      height: 0, // the node assigns this; read it back on the next refresh
      txId: res.success && typeof res.result === "string" ? res.result : undefined,
    };
  }
}

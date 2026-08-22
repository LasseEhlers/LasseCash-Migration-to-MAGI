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
import { BackendError, type Signer, type SubmitOptions } from "./backend.js";
import { commentMetadata, postMetadata } from "./hive-metadata.js";
import type { TxResult } from "./types.js";

export { KeyTypes, Providers };

/** Which wallets to offer. */
export interface AiohaOptions {
  /** The deployed LasseCash contract id on MAGI. */
  contractId: string;
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
    const tags = ["lassecash", ...input.tags.filter((t) => t !== "lassecash")].slice(0, 10);

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
   * Upload an image to Hive's own image server.
   *
   * `POST https://images.hive.blog/:username/:signature`, where the signature
   * is over sha256("ImageSigningChallenge" + imageData) with the POSTING key.
   * We use Hive's host rather than our own because every existing Hive post
   * depends on it staying up, so it is maintained far beyond anything we could
   * justify running.
   *
   * ⚠️ UNVERIFIED AGAINST A LIVE WALLET. The digest is computed here and passed
   * to `signMessage`; whether each provider signs the raw digest or re-hashes
   * it has to be confirmed against real Keychain/PeakVault before launch.
   */
  async uploadImage(file: Blob, username: string): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());

    const challenge = new TextEncoder().encode("ImageSigningChallenge");
    const payload = new Uint8Array(challenge.length + bytes.length);
    payload.set(challenge, 0);
    payload.set(bytes, challenge.length);

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");

    const signed = await this.aioha.signMessage(hex, KeyTypes.Posting);
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
    mint: 4_000,          // measured 2,401 (1,976 on the current build)
    claim_mint: 4_000,
    sweep_mint: 4_000,
    good_accounting: 800,
    set_duration: 400,
    settle_pending: 4_000, // drains up to MaxCurationDrain queue entries
    promote: 1_200,
    set_param: 800,
    post: 1_200,
    // A reply is the same write set as a post: one record, one threshold read.
    comment: 1_500,
    // Debit, burn to null, rewrite the post record. Unmeasured on a real
    // deploy — measure with simulateContractCalls before launch.
    promote_post: 1_500,
    vote: 2_500,          // includes PiggybackDrain curation settles
    payout: 2_500,
    claim_curation: 1_200,
    sweep_curation: 1_200,
    add_liquidity: 2_500,
    remove_liquidity: 2_500,
    claim_pool: 2_500,
    swap_lc_hbd: 2_000,
    swap_hbd_lc: 2_000,
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
    const rcLimit = opts?.rcLimit ?? AiohaSigner.RC_LIMITS[entrypoint] ?? this.rcLimit;

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
    };
  }
}

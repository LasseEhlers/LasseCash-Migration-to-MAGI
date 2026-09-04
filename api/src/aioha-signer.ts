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
import { Aioha, Asset as HiveAsset, KeyTypes, Providers } from "@aioha/aioha";
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
 * MAGI addresses are qualified (`hive:alice`, `did:pkh:…`); Aioha hands us a
 * bare Hive name. Every node query that names an account must qualify it —
 * the node either refuses a bare name outright (simulateContractCalls) or
 * answers a wrong-but-plausible zero for it (getAccountRC).
 */
export function qualifyAuth(account: string): string {
  return account.includes(":") ? account : `hive:${account}`;
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
   * Move HBD from Hive L1 onto MAGI.
   *
   * An ordinary Hive transfer to the gateway, with the memo that says whose
   * MAGI balance to credit. ACTIVE authority, because it moves real money on
   * Hive — the wallet asks at the moment it matters.
   */
  async depositHbd(amount: number, asset: "HBD" | "HIVE" = "HBD"): Promise<TxResult> {
    const user = this.aioha.getCurrentUser();
    if (!user) throw new BackendError("not signed in");
    // Same gateway, same memo, either asset — the gateway credits whatever it
    // is sent. BTC is NOT here: a mapped asset is deposited to an address the
    // network issues, not by a Hive transfer, and we do not guess at that.
    const res = await this.aioha.transfer(
      AiohaWallet.HBD_GATEWAY, amount,
      asset === "HIVE" ? HiveAsset.HIVE : HiveAsset.HBD, `to=${user}`,
    );
    return {
      ok: !!res.success,
      msg: res.success ? "submitted" : AiohaWallet.hiveReason(res.error),
      height: 0,
      txId: res.success && typeof res.result === "string" ? res.result : undefined,
    };
  }

  /**
   * Move HBD from MAGI back to Hive L1.
   *
   * `vscWithdraw` is Aioha's own supported call for this, so there is no
   * gateway memo to get wrong on the way out — the destination is a
   * parameter, not a string a user has to format.
   */
  async withdrawHbd(amount: number, to?: string, asset: "HBD" | "HIVE" = "HBD"): Promise<TxResult> {
    const user = this.aioha.getCurrentUser();
    if (!user) throw new BackendError("not signed in");
    const res = await this.aioha.vscWithdraw(
      to || user, amount, asset === "HIVE" ? HiveAsset.HIVE : HiveAsset.HBD,
    );
    return {
      ok: !!res.success,
      msg: res.success ? "submitted" : AiohaWallet.hiveReason(res.error),
      height: 0,
      txId: res.success && typeof res.result === "string" ? res.result : undefined,
    };
  }

  /**
   * Withdraw mapped BTC to a real Bitcoin address.
   *
   * `unmap` on the mapping contract, whose interface is public in
   * vsc-eco/utxo-mapping: {amount, to, deduct_fee?, max_fee?} with the amount
   * in satoshis. The caller's DID goes in the json — that is the shape the
   * contract expects, and it is why this call builds its own op rather than
   * reusing the generic one.
   *
   * `deduct_fee` is sent ALWAYS. The Bitcoin miner fee has to come from
   * somewhere, and taking it out of the amount is the only version a user can
   * reason about: they get slightly less than they asked for, rather than a
   * call that fails because their balance was exactly what they typed.
   */
  async withdrawBtc(sats: bigint, toAddress: string): Promise<TxResult> {
    const user = this.aioha.getCurrentUser();
    if (!user) throw new BackendError("not signed in");
    const json = JSON.stringify({
      net_id: this.#netId,
      caller: `hive:${user}`,
      contract_id: AiohaWallet.BTC_MAPPING_CONTRACT,
      action: "unmap",
      payload: { amount: sats.toString(), to: toAddress, deduct_fee: true },
      rc_limit: 10_000,
    });
    return this.#broadcast(
      [["custom_json", {
        required_auths: [user],
        required_posting_auths: [],
        id: "vsc.call",
        json,
      }]],
      KeyTypes.Active,
    );
  }

  /**
   * Send HBD or HIVE to another MAGI account.
   *
   * Aioha's own `vscTransfer` — MAGI's native asset move, not our contract's.
   * Nothing crosses to Hive here: this is MAGI-side, like handing someone a
   * note in the same room.
   */
  async sendNative(to: string, amount: number, asset: "HBD" | "HIVE", memo = ""): Promise<TxResult> {
    if (!this.aioha.getCurrentUser()) throw new BackendError("not signed in");
    const res = await this.aioha.vscTransfer(
      to, amount, asset === "HIVE" ? HiveAsset.HIVE : HiveAsset.HBD, memo,
    );
    return {
      ok: !!res.success,
      msg: res.success ? "submitted" : AiohaWallet.hiveReason(res.error),
      height: 0,
      txId: res.success && typeof res.result === "string" ? res.result : undefined,
    };
  }

  /**
   * Send mapped BTC to another MAGI account.
   *
   * The mapping contract's own `transfer` — {amount, to} in satoshis, to a
   * MAGI address. NOT `unmap`: this stays on MAGI, where `unmap` leaves for
   * Bitcoin. Sending to a Bitcoin address here would simply fail, which is
   * the safe direction for that mistake.
   */
  async sendBtc(toDid: string, sats: bigint): Promise<TxResult> {
    const user = this.aioha.getCurrentUser();
    if (!user) throw new BackendError("not signed in");
    const json = JSON.stringify({
      net_id: this.#netId,
      caller: `hive:${user}`,
      contract_id: AiohaWallet.BTC_MAPPING_CONTRACT,
      action: "transfer",
      payload: { amount: sats.toString(), to: toDid },
      rc_limit: 2_000,
    });
    return this.#broadcast(
      [["custom_json", { required_auths: [user], required_posting_auths: [], id: "vsc.call", json }]],
      KeyTypes.Active,
    );
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
  async simulate(
    account: string, action: string, payload: string, intents: unknown[], probeRcLimit = 100_000,
  ): Promise<
    { ok: true; gas: number } | { ok: false; msg: string; gasLimitHit: boolean }
  > {
    // ⚠️ QUALIFY THE NAME, exactly as availableRc below must. Aioha hands us
    // a bare Hive name, and the node REFUSES a bare `required_auths` ("must
    // start with hive: or did:") — as a GraphQL error, which this method
    // surfaces as a throw, which sizeRc catches by falling back to the table.
    // So a bare name here doesn't fail loudly: it silently turns EVERY dry
    // run off, and every call goes out at its table value. That is how three
    // registering votes (real cost ~4,800 RC) died at the vote table's 4,000
    // on 2026-09-02 — and how their targets then vanished from the feed.
    //
    // ⚠️ probeRcLimit POISONS THE HBD-DRAW CHECK IF LEFT AT THE DEFAULT. Traced
    // in the real node source (execution-context.go PullBalance, 2026-09-04):
    // an HBD-drawing call reserves `exclusion = requestedRcLimit -
    // freeRcRemaining` ON TOP OF the draw, before checking the balance covers
    // it — so probing at 100,000 (no real HBD-drawing call ever needs that
    // much) manufactures a huge phantom reservation with nothing to do with
    // the real call. Proved on-chain: the SAME 5.302 HBD swap failed
    // "insufficient balance" probed at 100,000 and succeeded cleanly probed
    // at 3,000. sizeRc passes a small probeRcLimit for HBD_DRAW_OPS; every
    // other caller keeps the generous default, which genuinely-expensive
    // calls (a big mint, a long accrual walk) still need to avoid a false
    // gasLimitHit.
    const addr = qualifyAuth(account);
    const res = await fetch(this.#chainUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($i: SimulateContractCallsInput!) {
          simulateContractCalls(input: $i) { success err_msg gas_used } }`,
        variables: { i: {
          tx_id: "sim", required_auths: addr,
          calls: [{ contract_id: this.#contractId, action, payload, rc_limit: probeRcLimit, intents }],
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
    // MAGI addresses are qualified; Aioha hands us a bare Hive name.
    const addr = qualifyAuth(account);
    try {
      const res = await fetch(this.#chainUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query($a: String!) { getAccountRC(account: $a) { amount max_rcs } }`,
          variables: { a: addr },
        }),
      });
      const body = (await res.json()) as {
        data?: { getAccountRC?: { amount: number; max_rcs: number } | null };
      };
      const rc = body.data?.getAccountRC;
      // A 0/0 answer means the node did not recognise the address, NOT that
      // the account is broke — see MagiBackend.resourceCredits. Treating it
      // as a real reading would make the preflight refuse every call the
      // account ever tries.
      if (rc && typeof rc.amount === "number" && rc.max_rcs) return rc.amount;
      return AiohaWallet.FREE_RC;
    } catch {
      return null;
    }
  }
  /**
   * The Hive account that bridges HBD between Hive L1 and MAGI.
   *
   * VERIFIED against its own history, 2026-09-01: deposits are ordinary Hive
   * transfers to this account carrying the memo `to=<hive username>`, and
   * withdrawals come back out of it. Not guessed — read from real transfers
   * by real accounts, including the 12 HBD that funded @lassecashmagi.
   *
   * ⚠️ THE MEMO IS THE ADDRESS. A deposit without it, or with the wrong name
   * in it, is a transfer to a stranger — there is no refund path and no
   * support desk. Every caller here builds the memo from the signed-in
   * account rather than from anything a user typed.
   */
  static readonly HBD_GATEWAY = "vsc.gateway";

  /** The contract that holds mapped BTC (vsc-eco/utxo-mapping). */
  static readonly BTC_MAPPING_CONTRACT = "vsc1BdrQ6EtbQ64rq2PkPd21x4MaLnVRcJj85d";

  /**
   * Bitcoin's dust threshold, from the contract's own constant. An output
   * below this cannot be spent, so the contract refuses it — better to say so
   * before the wallet opens than to let the chain say it afterwards.
   */
  static readonly BTC_DUST_SATS = 546n;

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
    calls: { action: string; payload: string; rcLimit: number; intents: unknown[]; contractId?: string }[],
    contractId: string,
    keyType: KeyTypes,
    hiveOps: unknown[] = [],
  ): Promise<TxResult> {
    // A call may name its own contract — one signature can then carry, e.g.,
    // a mapping contract's increaseAllowance beside the router's swap.
    return this.#broadcast(
      [...hiveOps, ...calls.map((c) => this.#vscOp(c, c.contractId ?? contractId, keyType))], keyType);
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
      msg: res.success ? "submitted" : AiohaWallet.hiveReason(res.error),
      height: 0,
      txId: res.success && typeof res.result === "string" ? res.result : undefined,
    };
  }

  /**
   * Hive's rejection, in words a user can act on.
   *
   * A LasseCash vote carries the Hive vote in the SAME transaction, so when
   * Hive refuses, the contract call dies with it — nothing registers here.
   * Hive's own text arrives wrapped in assert markup ("Your transaction
   * returned an error <br/><br/>Error: ...") and names conditions in
   * consensus terms, which reads as a site bug rather than as a thing the
   * user can fix.
   *
   * Translated only where the fix is unambiguous; anything else is passed
   * through, because a wrong explanation is worse than a raw one.
   */
  static hiveReason(raw: string | undefined): string {
    const err = (raw ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!err) return "rejected";
    // The single most common one: the first attempt's Hive half succeeded
    // while its MAGI half failed (RC), so the retry is an identical re-vote.
    // Hive refuses those, and the refusal kills the bundled contract call —
    // which is precisely the vote the user is trying to land. Changing the
    // weight is the whole fix. Seen in production 2026-09-01.
    if (/identical to this vote|vote is the same/i.test(err)) {
      return "you have already voted on this at that weight on Hive — move the slider to a different weight and cast again. A vote is replaced by re-voting, never removed.";
    }
    if (/only.*vote.*once|cannot vote again|vote_regeneration/i.test(err)) {
      return "Hive is rate-limiting your votes — wait a few seconds and cast again.";
    }
    if (/exceeded.*bandwidth|resource credits|insufficient rc/i.test(err)) {
      return "your Hive account is out of resource credits for now. Hive RC refills on its own over the next hours.";
    }
    if (/comment.*same as before|Comment already exists/i.test(err)) {
      return "this text is identical to what you already published — change something and try again.";
    }
    if (/missing required (posting|active) authority/i.test(err)) {
      return "your wallet did not grant the authority this needs. Sign in again, or unlock the wallet and retry.";
    }
    return err;
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
    // The four permissionless housekeeping calls — sweep_mint, sweep_curation,
    // claim_curation and sweep_tranche — are deliberately NOT here. None can
    // move the CALLER's money: each pays its subject, never the person who
    // triggered it, and each refuses unless the position is already dead.
    // Demanding an active key would add friction to exactly the altruistic
    // action the protocol wants people taking. Decided 2026-08-22, after
    // sweep_tranche was briefly added here and left the four inconsistent —
    // and this list is frozen at the key burn.
    //
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
   * rc_limit PER ENTRYPOINT, RE-MEASURED ON MAINNET 2026-09-01 via
   * simulateContractCalls (100,000 gas = 1 RC), carrying ~2.5x headroom.
   *
   * ⚠️ THE FIRST VERSION OF THIS TABLE WAS MEASURED ON THE LOCAL DEVNET AND
   * WAS WRONG BY ~3x. A transfer costs 285 RC there and 872 here, so the old
   * 600 could not pay for one: @tibfox's transfer died with "cost limit
   * exceeded" on 2026-09-01 and he reported it. The devnet does not weigh
   * state writes the way settlement does, so ANY number taken from it is a
   * floor, not an estimate. Re-measure here, against this contract.
   *
   * These values are the FALLBACK: `sizeRc` normally dry-runs the exact call
   * and takes max(table, 3x simulated), so the table only decides when the
   * simulation cannot be reached. That is precisely when being wrong is
   * least recoverable, which is why it now errs high — a refused call
   * freezes its rc_limit for the same five days a successful one does, so
   * under-sizing costs exactly as much as over-sizing and buys nothing.
   *
   * Two failure modes bracket this table, and both are silent in production:
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
    transfer: 2_500,      // mainnet 872. The devnet said 285 and 600 was not enough: @tibfox, 2026-09-01.
    burn: 600,            // mainnet 167
    // MEASURED 1,271 gas-RC on mainnet 2026-09-02 with a VALID payload — the
    // earlier "38" came from a probe that refused before doing the accrual
    // walk, which is the same mistake that left set_param unable to succeed.
    settle: 2_000,
    advance: 10_000,      // FLOOR only: a full MaxRetirePerWalk slice measured 20,903 RC on the devnet (2026-08-22); sizeRc raises it from a dry run for accounts that can afford it, never above what they hold
    mint: 7_000,          // measured 2,401 on the devnet, 3,142 simulated on mainnet — and a REAL mint hit gas_limit_hit at 4,000 when a day-step landed inside it (2026-08-22). Mainnet weighs writes 19x; keep ~2x headroom.
    claim_mint: 7_000,
    sweep_mint: 7_000,
    good_accounting: 800,
    set_duration: 400,
    settle_pending: 6_000, // drains up to MaxCurationDrain queue entries
    // MEASURED FAILING ON MAINNET 2026-09-02: set_param at 800 died with
    // gas_limit_hit on a real threshold change. Simulation says ~2 RC, which is
    // why the floor matters more than the dry run here — settlement weighs a
    // state write 19x and the simulator does not. Both of these read gov_board
    // and every member's shares before writing, so they cost more than the
    // transfer they were sized against (2,500, measured 872).
    promote: 3_000,
    set_param: 3_000,
    post: 3_000,          // mainnet 1,098
    // A reply is the same write set as a post plus the queue append, and it
    // measures HIGHER than a post on mainnet: 1,974 against 1,098.
    comment: 5_000,      // mainnet 1,974
    // Debit, burn to null, rewrite the post record. Unmeasured on a real
    // deploy — measure with simulateContractCalls before launch.
    promote_post: 2_500,  // mainnet 833
    // An ordinary vote is 904 on mainnet — but a FIRST vote on an outside
    // tagged post also REGISTERS it (record write, author-stake check,
    // curation-queue seed): 4,818 RC simulated against production 2026-09-03.
    // Three of those died at the old 4,000 on 2026-09-02 (the silvertop
    // incident), and their targets vanished from the feed. The dry run sizes
    // the real case; this floor must survive it when the dry run cannot.
    vote: 7_000,
    payout: 4_000,
    claim_curation: 1_200,
    sweep_curation: 1_200,
    add_liquidity: 4_000,
    remove_liquidity: 4_000,
    claim_pool: 4_000,    // mainnet 463
    // Same shape as claim_pool (settles the owner's rewards first) plus the
    // bleed's share/weight rewrite — unmeasured, modeled on remove_liquidity.
    sweep_tranche: 4_000,
    swap_lc_hbd: 3_000,   // mainnet 206
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

  /**
   * A swap on one of MAGI's own pools.
   *
   * Same machinery as our own calls — a `vsc.call` custom_json with an
   * ACTIVE key — pointed at a DIFFERENT contract. That is the whole
   * difference, and it is why this is a frontend feature rather than a new
   * trust assumption: the transaction is identical to the one Altera sends,
   * and if MAGI ever changes the interface the call is REFUSED rather than
   * mis-executed.
   */
  async magiSwap(input: {
    router: string; payload: string; intents: unknown[]; rcLimit: number;
    approve?: { contractId: string; payload: string; rcLimit: number };
  }): Promise<TxResult> {
    const user = this.wallet.aioha.getCurrentUser();
    if (!user) throw new BackendError("not signed in");
    const calls: { action: string; payload: string; rcLimit: number; intents: unknown[]; contractId?: string }[] = [];
    if (input.approve) {
      calls.push({
        action: "increaseAllowance", payload: input.approve.payload,
        rcLimit: input.approve.rcLimit, intents: [], contractId: input.approve.contractId,
      });
    }
    calls.push({ action: "execute", payload: input.payload, rcLimit: input.rcLimit, intents: input.intents });
    return this.wallet.broadcastCalls(calls, input.router, KeyTypes.Active);
  }

  /** Bridging HBD is the wallet's job; the signer just exposes it. */
  depositHbd(amount: number, asset?: "HBD" | "HIVE"): Promise<TxResult> { return this.wallet.depositHbd(amount, asset); }
  withdrawBtc(sats: bigint, to: string): Promise<TxResult> { return this.wallet.withdrawBtc(sats, to); }
  sendNative(to: string, amount: number, asset: "HBD" | "HIVE", memo?: string): Promise<TxResult> { return this.wallet.sendNative(to, amount, asset, memo); }
  sendBtc(to: string, sats: bigint): Promise<TxResult> { return this.wallet.sendBtc(to, sats); }
  withdrawHbd(amount: number, to?: string, asset?: "HBD" | "HIVE"): Promise<TxResult> { return this.wallet.withdrawHbd(amount, to, asset); }

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
    // HBD-drawing calls: probe at RC_CEILING (30,000), not the 100,000 default.
    // No real rc_limit is ever sized above RC_CEILING, and probing higher than
    // that only manufactures a bigger phantom exclusion against the HBD draw
    // for no benefit — see the warning on AiohaWallet.simulate.
    const probeRcLimit = entrypoint in AiohaSigner.HBD_DRAW_OPS ? AiohaSigner.RC_CEILING : undefined;
    try {
      sim = await this.wallet.simulate(this.account, entrypoint, args, intents, probeRcLimit);
    } catch {
      // The node could not simulate, so the table is the only estimate — but
      // admission still checks rc_limit against AVAILABLE RC, so a broadcast
      // the account cannot cover is known doomed even without a dry run.
      const avail = await this.wallet.availableRc(this.account);
      if (avail !== null && avail < tableLimit) return AiohaSigner.rcRefusal(tableLimit, avail);
      return tableLimit;
    }
    if (!sim.ok) {
      if (sim.gasLimitHit) {
        return { ok: false, msg: "this call would exceed the per-call gas ceiling — call advance first to close the accrual gap", height: 0 };
      }
      // THE NODE SAYS "insufficient balance" WHEN IT MEANS THE METER. On an
      // HBD-drawing call, admission needs available RC >= draw + rc_limit —
      // the @daneamanda wall — so a drained meter refuses a draw the balance
      // easily covers, and the raw message reads as a lie ("insufficient
      // balance when it's not", Lasse, 2026-09-03, on a 1 HBD buy against an
      // 18 HBD balance). Translate it where it can only mean the meter.
      if (entrypoint in AiohaSigner.HBD_DRAW_OPS && /insufficient balance/i.test(sim.msg)) {
        return {
          ok: false, height: 0,
          msg: "Not enough RC — hold more HBD on MAGI, it's free RC.",
        };
      }
      return { ok: false, msg: sim.msg, height: 0 };
    }
    const need = Math.ceil(sim.gas / AiohaSigner.GAS_PER_RC);
    const sized = Math.min(AiohaSigner.RC_CEILING, Math.max(tableLimit, need * AiohaSigner.RC_HEADROOM));
    // Never ask for more than the account has: the limit is admission-checked
    // against AVAILABLE RC ("minimum RC requirement is not met"), so a fresh
    // account's 10,000 must be able to carry a claim. Headroom gives way
    // first — but only down to a floor the call can actually survive.
    //
    // The floor CANNOT come from the simulation alone: settlement weighs
    // state writes 19x and the simulator does not, so a write-heavy call
    // simulates at a small fraction of its real cost. The first production
    // casualty (2026-09-01): a comment simulated ~80 RC, squeaked past the
    // old 1.3x-of-simulated floor with 82 RC available, broadcast at
    // rc_limit 82, and died with "cost limit exceeded" — after publishing
    // its Hive half, leaving an orphan. The TABLE is measured real cost
    // plus ~60% headroom, so refusing below ~60% of it refuses only calls
    // that measurement says cannot fit. `advance` is exempt: it is sized
    // to affordable slices by design ("never above what they hold").
    const tableFloor = entrypoint === "advance" ? 0 : Math.ceil(tableLimit * 0.6);
    const avail = await this.wallet.availableRc(this.account);
    if (avail !== null && sized > avail) {
      const floor = Math.max(Math.ceil(need * 1.3), tableFloor);
      if (avail < floor) return AiohaSigner.rcRefusal(floor, avail);
      return avail;
    }
    return sized;
  }

  /** The one wording for "you are out of RC", so every path explains the meter. */
  static rcRefusal(needed: number, avail: number): TxResult {
    // 1 RC == 1 milli-HBD in capacity terms (capacity = HBD milli + 10,000
    // free), so the gap converts to an exact HBD figure — telling someone
    // "you need ~10,468" means nothing if they have never touched HBD;
    // "deposit about 0.47 more HBD" is something they can actually go do.
    const gapHbd = (Math.ceil((needed - avail) / 10) / 100).toFixed(2);
    return {
      ok: false, height: 0,
      msg: `Not enough resource credits (needs ~${needed.toLocaleString()}, you have `
        + `${avail.toLocaleString()}). Deposit about ${gapHbd} more HBD to your MAGI `
        + `balance — Wallet → Move funds between Hive and MAGI — then try again; it `
        + `takes effect immediately.`,
    };
  }

  /**
   * Claim several of the SAME entrypoint (one `<id>` argument each) in one
   * signed transaction — "Claim All" for pool tranches or matured mints.
   * Each id is dry-run and sized on its own, same discipline as preCalls: an
   * id that would be refused stops the batch there rather than aborting
   * everything already confirmed affordable, so a partial claim is honest
   * about exactly how far it got. Capped at MaxClaimAllBatch, a sanity bound
   * — nobody has hundreds of tranches or mints today, and if that changes
   * this can loop calls rather than needing raising blindly.
   *
   * SAFETY: the caller is responsible for `ids` containing ONLY positions
   * that are actually safe to close right now (e.g. `mature === true` for
   * mints) — this function has no opinion on that, and claim_mint on a mint
   * that has not matured is an EARLY END, not a claim: it slashes principal
   * and forfeits yield. Never pass an id here on the caller's behalf without
   * that filter already applied.
   */
  static readonly MaxClaimAllBatch = 12;

  async claimAllOf(entrypoint: string, ids: number[]): Promise<TxResult> {
    const keyType = AiohaSigner.ACTIVE_OPS.has(entrypoint) ? KeyTypes.Active : KeyTypes.Posting;
    const tableLimit = AiohaSigner.RC_LIMITS[entrypoint] ?? this.rcLimit;
    const batch = ids.slice(0, AiohaSigner.MaxClaimAllBatch);

    const calls: { action: string; payload: string; rcLimit: number; intents: unknown[] }[] = [];
    let firstRefusal: TxResult | null = null;
    for (const id of batch) {
      const payload = String(id);
      const lim = await this.sizeRc(entrypoint, payload, [], tableLimit);
      if (typeof lim !== "number") {
        if (calls.length === 0) firstRefusal = lim; // nothing affordable at all
        break; // stop here: send what is confirmed affordable, claim the rest later
      }
      calls.push({ action: entrypoint, payload, rcLimit: lim, intents: [] });
    }

    if (calls.length === 0) {
      return firstRefusal ?? { ok: false, height: 0, msg: "nothing to claim" };
    }
    const res = await this.wallet.broadcastCalls(calls, this.contractId, keyType);
    const skipped = ids.length - calls.length;
    if (res.ok && skipped > 0) {
      return { ...res, msg: `claimed ${calls.length} of ${ids.length} — the rest ` +
        `refused for RC and can be claimed once it recovers, or after depositing more HBD` };
    }
    return res;
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

    // Accrual catch-up slices go FIRST, each its own MAGI transaction.
    const pre: { action: string; payload: string; rcLimit: number; intents: unknown[] }[] = [];
    for (const pc of opts?.preCalls ?? []) {
      const lim = await this.sizeRc(pc.entrypoint, pc.args, [], AiohaSigner.RC_LIMITS[pc.entrypoint] ?? this.rcLimit);
      if (typeof lim !== "number") break; // cannot afford more slices: send what we can
      pre.push({ action: pc.entrypoint, payload: pc.args, rcLimit: lim, intents: [] });
    }

    // Per-entrypoint limit from measurement; the constructor's value is only
    // the fallback for an entrypoint this table does not know.
    const tableLimit = opts?.rcLimit ?? AiohaSigner.RC_LIMITS[entrypoint] ?? this.rcLimit;
    const rcLimit = await this.sizeRc(entrypoint, args, intents, tableLimit);
    if (typeof rcLimit !== "number") {
      // The chain would refuse the user's call. If that is because accrual is
      // behind and we have slices to send, send ONLY the slices: the user's
      // click still pushes the chain forward, and the next click will go
      // through. Otherwise say so, no popup.
      if (pre.length > 0 && /accrual is behind/i.test(rcLimit.msg)) {
        const r = await this.wallet.broadcastCalls(pre, this.contractId, keyType);
        return r.ok
          ? { ...r, ok: false, msg: `the chain is catching up on matured mints — this transaction advanced it ${pre.length} step${pre.length > 1 ? "s" : ""}; press again` }
          : r;
      }
      return rcLimit;
    }

    // Side calls (settlements riding along) go in the same transaction. Each
    // is sized from its own dry run; one that would be refused is dropped —
    // it was never the user's call, so it must never block theirs.
    const side: { action: string; payload: string; rcLimit: number; intents: unknown[] }[] = [];
    for (const sc of (opts?.sideCalls ?? []).slice(0, MaxSideCalls)) {
      const lim = await this.sizeRc(sc.entrypoint, sc.args, [], AiohaSigner.RC_LIMITS[sc.entrypoint] ?? this.rcLimit);
      if (typeof lim === "number") side.push({ action: sc.entrypoint, payload: sc.args, rcLimit: lim, intents: [] });
    }
    // A LasseCash vote is ALSO a Hive vote at the same weight, in the same
    // transaction — Lasse 2026-08-22: "for consistency", this is how the
    // Hive-Engine tribe behaved (the Hive vote WAS the vote; Scot read it).
    // One confirm. Both land or neither does: Hive refuses an identical
    // re-vote ("already voted in a similar way"), in which case the contract
    // call is not broadcast either — the page reports Hive's reason.
    const hiveOps: unknown[] = [];
    if (entrypoint === "vote") {
      const [author = "", permlink = "", weightPct = "0"] = args.split("|");
      hiveOps.push(["vote", {
        voter: this.account.replace(/^hive:/, ""),
        author: author.replace(/^hive:/, ""),
        permlink,
        weight: Math.max(0, Math.min(100, Number(weightPct))) * 100, // Hive: basis points; 0 withdraws
      }]);
    }

    if (pre.length > 0 || side.length > 0 || hiveOps.length > 0) {
      return this.wallet.broadcastCalls(
        [...pre, { action: entrypoint, payload: args, rcLimit, intents }, ...side],
        this.contractId,
        keyType,
        hiveOps,
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
      msg: res.success ? (res.result ?? "submitted") : AiohaWallet.hiveReason(res.error),
      height: 0, // the node assigns this; read it back on the next refresh
      txId: res.success && typeof res.result === "string" ? res.result : undefined,
    };
  }
}

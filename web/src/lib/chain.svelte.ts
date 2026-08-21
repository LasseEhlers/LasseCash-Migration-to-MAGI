/**
 * Shared chain state for the app.
 *
 * ONE client, ONE engine instance, shared by every component. Loading the
 * engine per-component would ship the same 104KB repeatedly and lose the
 * shared cache of chain state.
 *
 * Svelte 5 runes. `$state` here is UI state — the values inside came from the
 * chain or the engine, never from arithmetic in this file.
 */
import {
  AiohaWallet, DevBackend, DevSigner, LasseCashClient, MagiBackend,
  engineReady, loadEngine,
  type AccountView, type ChainInfo, type Providers,
} from "$api/index.js";

const DEV_URL = import.meta.env.VITE_CHAIN_URL ?? "http://localhost:8080";

/**
 * The deployed LasseCash contract id on MAGI.
 *
 * Absent means "no contract yet", which is the honest state today — so the app
 * talks to the dev chain and offers the fake sign-in. The mode is derived from
 * this, NOT from a toggle: a switch that could put fake auth in front of a real
 * chain is a footgun waiting for a bad day.
 */
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID ?? "";

/** True when there is a real chain and real wallets to sign with. */
export const WALLET_MODE = CONTRACT_ID !== "";

const backend = WALLET_MODE
  ? new MagiBackend({ contractId: CONTRACT_ID })
  : new DevBackend({ url: DEV_URL });

/**
 * One wallet instance for the whole app.
 *
 * Aioha holds session state; a second instance would silently disagree with the
 * first about who is signed in.
 */
// Constructed only in the BROWSER: Aioha touches window/localStorage at
// construction, and Vite's dev server evaluates this module during SSR too.
export const wallet = WALLET_MODE && typeof window !== "undefined"
  ? new AiohaWallet({
      contractId: CONTRACT_ID,
      netId: import.meta.env.VITE_MAGI_NET_ID,
    })
  : null;

export const client = new LasseCashClient({ backend });

class ChainStore {
  /** Global chain position. Null until the first load completes. */
  info = $state<ChainInfo | null>(null);
  /** The signed-in account's full view. */
  me = $state<AccountView | null>(null);
  /** Who is signed in. The dev chain takes a name; MAGI will take a signature. */
  account = $state<string | null>(null);
  /** True once the browser engine is callable — previews stay disabled until then. */
  ready = $state(false);
  error = $state<string | null>(null);
  busy = $state(false);

  async init() {
    try {
      // The engine and the chain load in parallel; neither depends on the other.
      await Promise.all([
        // The engine build must match the CONTRACT's clock: against a
        // TESTWINDOWS deployment (240x days) the mainnet engine's maturity
        // math is 240x wrong. Set VITE_TESTWINDOWS=1 alongside the test
        // contract id in .env.magi.
        loadEngine(
          import.meta.env.VITE_TESTWINDOWS === "1"
            ? "/engine-testwindows.wasm"
            : "/engine.wasm",
        ).then(() => { this.ready = engineReady(); }),
        this.refresh(),
      ]);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async refresh() {
    try {
      this.info = await client.chain();
      if (this.account) this.me = await client.accountOf(this.account);
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.#maybeSettleForNewMonth();
  }

  /**
   * Settle when the calendar month turns, not just when someone signs in.
   *
   * A tab left open for weeks would otherwise never settle, because sign-in
   * happens once and never again. Fire-and-forget so a refresh is never held up
   * by housekeeping.
   */
  #maybeSettleForNewMonth() {
    const epoch = this.info?.epoch ?? 0;
    if (!this.account || epoch === 0 || epoch === this.#settledEpoch) return;
    this.#settledEpoch = epoch;
    void this.settleOwed();
  }

  /**
   * Sign in with a real Hive wallet.
   *
   * The key never reaches us — Aioha asks the user's wallet, which shows them
   * what they are signing and returns a signature.
   */
  async signInWithWallet(provider: Providers, name: string) {
    if (!wallet) throw new Error("wallet mode is not enabled");
    const account = await wallet.login(provider, name);
    // Hive accounts are addressed as hive:<name> on MAGI.
    this.account = `hive:${account}`;
    client.setSigner(wallet.signer());
    await this.refresh();
  }

  async signIn(name: string) {
    const account = name.startsWith("hive:") ? name : `hive:${name}`;
    this.account = account;
    if (WALLET_MODE) throw new Error("dev sign-in is disabled against a real chain");
    client.setSigner(new DevSigner(account, backend as DevBackend));
    localStorage.setItem("lassecash:account", account);
    // refresh() settles for the current month via #maybeSettleForNewMonth.
    await this.refresh();
  }

  signOut() {
    if (wallet) void wallet.logout();
    this.#settledEpoch = 0;
    this.account = null;
    this.me = null;
    client.setSigner(undefined);
    localStorage.removeItem("lassecash:account");
  }

  /**
   * Run a transaction and refresh.
   *
   * Always refreshes, including on failure: a rejected transaction may still
   * mean our view of the chain was stale, and showing the user a fresh state is
   * more useful than preserving the one that led to the rejection.
   */
  async submit(fn: () => Promise<{ ok: boolean; msg: string }>): Promise<string | null> {
    this.busy = true;
    try {
      const res = await fn();
      await this.refresh();
      // Contract messages carry RAW BASE UNITS and are diagnostic. Surface the
      // failure reason, never the formatting.
      return res.ok ? null : res.msg;
    } catch (e) {
      await this.refresh();
      return e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  /** True when background settling stopped because RC ran low, not because it finished. */
  settleStoppedForRc = $state(false);

  /**
   * The month we last settled for. Zero means "not yet this session".
   *
   * Hive users stay signed in for months — a settle that only ran on sign-in
   * would almost never fire. So the trigger is the CALENDAR crossing, which is
   * also exactly when there is something to settle: the monthly mint.
   */
  #settledEpoch = 0;

  /**
   * Settle everything the signed-in account is owed.
   *
   * The chain caps each settle at MaxCurationDrain claims so no transaction
   * does unbounded work. That is a chain-side necessity, not something a user
   * should have to know about, so the app calls it repeatedly.
   *
   * BUT IT SPENDS THE USER'S RC. On MAGI there are no fees — RC is the cost of
   * everything — and draining it silently would leave someone unable to post,
   * vote or transfer, with no idea why. So the loop stops while a comfortable
   * majority of their meter is still intact, and says so rather than failing
   * quietly. Whatever is left stays owed and settles on the next visit.
   *
   * Failures are otherwise swallowed: this is housekeeping the user did not ask
   * for and must never raise an error dialog.
   */
  async settleOwed(maxRounds = 12): Promise<void> {
    if (!this.account) return;
    this.settleStoppedForRc = false;

    for (let i = 0; i < maxRounds; i++) {
      const before = this.me?.pending_curation ?? 0;
      if (before === 0) return;

      // Check BEFORE spending, not after — the point is to leave headroom.
      if (!(await client.hasRcHeadroom(0.25))) {
        this.settleStoppedForRc = true;
        return;
      }

      try {
        const res = await client.settlePending();
        if (!res.ok) return; // "not due yet" is the normal stopping point
      } catch {
        return;
      }
      await this.refresh();

      // Stop as soon as a round stops making progress, so a permanently stuck
      // entry cannot spin the loop.
      if ((this.me?.pending_curation ?? 0) >= before) return;
    }
  }

  /** Dev only: move the chain's clock, then refresh. */
  async advanceDays(days: number) {
    this.busy = true;
    try {
      await client.advanceDays(days);
      await this.refresh();
    } finally {
      this.busy = false;
    }
  }
}

export const chain = new ChainStore();

/** Restore a previous session — a wallet session if there is one, else dev. */
export function restoreSession() {
  if (wallet) {
    const user = wallet.restore();
    if (user) {
      chain.account = `hive:${user}`;
      client.setSigner(wallet.signer());
      void chain.refresh();
    }
    return;
  }
  const saved = localStorage.getItem("lassecash:account");
  if (saved) void chain.signIn(saved);
}

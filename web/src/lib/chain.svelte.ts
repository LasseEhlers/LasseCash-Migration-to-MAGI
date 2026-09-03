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
import { SITE_URL } from "$lib/site.js";

const DEV_URL = import.meta.env.VITE_CHAIN_URL ?? "http://localhost:8080";

/**
 * The deployed LasseCash contract id on MAGI.
 *
 * Absent means "no contract yet", which is the honest state today — so the app
 * talks to the dev chain and offers the fake sign-in. The mode is derived from
 * this, NOT from a toggle: a switch that could put fake auth in front of a real
 * chain is a footgun waiting for a bad day.
 */
export const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID ?? "";

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
      chainUrl: import.meta.env.VITE_CHAIN_URL,
      // The origin every published post declares as its canonical home. The
      // indexer must not know the site's address; the site tells it.
      siteUrl: SITE_URL,
    })
  : null;

export const client = new LasseCashClient({ backend });

/**
 * A node refusal, said in words someone can act on.
 *
 * MAGI answers in its own vocabulary — "cost limit exceeded", "ledger_error",
 * "minimum RC requirement is not met" — and showing that verbatim tells a
 * newcomer nothing. Nearly every one of them is the same subject underneath:
 * resource credits, which on MAGI are simply the HBD held on the account.
 *
 * Seen on real people in the first two days: three "cost limit exceeded" and
 * two "RCs available: 0", none of whom could have known what to do next.
 *
 * The raw text is KEPT at the end. Someone debugging needs the node's own
 * words, and hiding them makes a failure harder to report than it already is.
 */
function chainRefusal(raw?: string): string {
  const e = (raw ?? "").toLowerCase();
  const tail = raw ? ` (${raw})` : "";

  if (e.includes("cost limit") || e.includes("gas_limit")) {
    return "Not enough resource credits. More HBD on MAGI fixes it instantly.";
  }
  if (e.includes("minimum rc") || e.includes("rcs available")) {
    return "Out of resource credits. More HBD on MAGI fixes it instantly.";
  }
  if (e.includes("insufficient balance") && e.includes("ledger")) {
    return "MAGI would not release the HBD for this. Your HBD is also your resource credits, so not "
      + `all of it can go out at once — try a smaller amount, or deposit more.${tail}`;
  }
  if (e.includes("below the minimum required")) {
    return "The chain refused this swap due to slippage.";
  }
  if (e.includes("no caller intent")) {
    return `This call needed permission to draw HBD and the wallet did not grant it.${tail}`;
  }
  if (!raw) return "The chain refused this call.";
  return `The chain refused this: ${raw}`;
}

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
  /**
   * True while a signed call has left the wallet but the chain has not yet
   * shown its effect. Keychain returns as soon as Hive L1 accepts the
   * custom_json; MAGI executes it 30–90 s later, so the first re-read after a
   * wallet submit is usually still the OLD state. Found on the real chain
   * 2026-08-22: two claims landed exactly, and the page showed zeros until F5.
   */
  confirming = $state(false);

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
  async submit(
    fn: () => Promise<{ ok: boolean; msg: string; txId?: string }>,
    /**
     * Set for calls that move real HBD (every pool action).
     *
     * The node keeps HBD in its own LEDGER, indexed separately from contract
     * state, and it lands a beat later. So a swap's LASSECASH side updates,
     * the generic "did anything change?" wait is satisfied, and the HBD
     * balance on screen is still the pre-swap figure — 86.14 after the launch
     * swap, 2026-08-31. Waiting on the HBD figure itself is the only honest
     * way to know the ledger caught up.
     */
    opts?: { movesHbd?: boolean },
  ): Promise<string | null> {
    this.busy = true;
    try {
      const before = JSON.stringify(this.me);
      const hbdBefore = this.me?.hbd;
      const res = await fn();
      if (!res.ok) {
        await this.refresh();
        // Contract messages carry RAW BASE UNITS and are diagnostic. Surface
        // the failure reason, never the formatting.
        return res.msg;
      }
      if (WALLET_MODE && res.txId) {
        // On a real chain "ok" only means Hive accepted the transaction. The
        // contract's verdict arrives 30–90 s later; wait for it so a refusal
        // is SHOWN, not silently swallowed.
        const verdict = await this.awaitVerdict(res.txId, before);
        if (verdict === null && opts?.movesHbd) await this.#awaitHbd(hbdBefore);
        return verdict;
      }
      await this.refresh();
      return null;
    } catch (e) {
      await this.refresh();
      return e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Follow a broadcast call to its verdict: poll the transaction status until
   * CONFIRMED or FAILED (up to ~4 minutes), then keep refreshing until the
   * account view actually changes. `confirming` drives the banner. A refusal
   * returns the chain's error text; nobody should have to press F5 or guess.
   */
  async awaitVerdict(txId: string, before: string): Promise<string | null> {
    this.confirming = true;
    try {
      let verdict: Awaited<ReturnType<typeof client.txStatus>> = { status: "PENDING" };
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        try { verdict = await client.txStatus(txId); } catch { /* node hiccup: keep waiting */ }
        if (verdict.status === "CONFIRMED" || verdict.status === "FAILED") break;
      }
      await this.refresh();
      if (verdict.status === "FAILED") {
        return chainRefusal(verdict.error);
      }
      if (verdict.status !== "CONFIRMED") {
        return "Still waiting for MAGI to include this transaction — the figures update when it lands.";
      }
      // Confirmed; the indexed state can lag the verdict by a block or two.
      for (let i = 0; i < 6 && JSON.stringify(this.me) === before; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        await this.refresh();
      }
      // One more read: the ledger (HBD) can land a block after contract
      // state, and the first change seen is not always the whole effect.
      await new Promise((r) => setTimeout(r, 10_000));
      await this.refresh();
      return null;
    } finally {
      this.confirming = false;
    }
  }

  /**
   * Keep refreshing until the HBD ledger catches up, or give up quietly.
   *
   * The contract's verdict does not mean the node's balance index has been
   * written; those are different stores and HBD lands a beat later. Giving up
   * silently is deliberate — the figure is right the next time anything
   * refreshes, and an error dialog about a number that is merely late would
   * be worse than the lateness.
   */
  async #awaitHbd(before: number | undefined) {
    for (let i = 0; i < 6; i++) {
      if (this.me?.hbd !== before) return;
      await new Promise((r) => setTimeout(r, 5_000));
      await this.refresh();
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

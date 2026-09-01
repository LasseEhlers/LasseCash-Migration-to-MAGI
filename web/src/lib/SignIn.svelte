<script lang="ts">
  /**
   * Sign in.
   *
   * Two modes, and the difference is stated plainly rather than hidden:
   *
   *  - DEV: type any account name. No signature, no wallet. Only ever points at
   *    the local dev chain, so there is nothing to steal.
   *  - WALLET: Hive Keychain, PeakVault or HiveAuth via Aioha. The key stays in
   *    the user's wallet; we never see it.
   *
   * The mode is decided by which chain the app is talking to, not by a toggle —
   * a "use fake login" switch that could be flipped against a real chain is a
   * footgun waiting for a bad day.
   */
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { chain, client, WALLET_MODE, wallet } from "$lib/chain.svelte.js";
  import type { Providers } from "$api/index.js";

  let username = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let open = $state(false);

  const wallets = $derived(WALLET_MODE && wallet ? wallet.wallets() : []);

  async function signInWith(provider: Providers) {
    const name = username.trim().replace(/^@/, "");
    if (!name) {
      error = "Enter your Hive account name first";
      return;
    }
    busy = true;
    error = null;
    try {
      await chain.signInWithWallet(provider, name);
      open = false;
      await landAfterSignIn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /**
   * Signing in moves you in exactly one case: you have not claimed yet.
   *
   * UNCLAIMED GOES TO MINT, from wherever they signed in, no exception. Not
   * merely a nudge toward the month's one errand — an unclaimed account holds
   * no L-Shares, so there is nothing it can usefully do on any other page.
   * Even the reader who followed a Hive link to vote on a post cannot vote
   * until they claim, so leaving them there would leave them somewhere that
   * does not work.
   *
   * A CLAIMED account is left exactly where it stands. It can act on any page
   * here, so the page it chose is the right one — signing in is something you
   * do IN ORDER TO use the page you are on, and throwing it away to show a
   * feed nobody asked for is the kind of helpfulness that reads as a bug.
   *
   * Failure is silent: this is a convenience, and a redirect that throws must
   * never look like a failed sign-in.
   */
  async function landAfterSignIn() {
    try {
      if (await client.migrationRecord(chain.account!)) return; // claimed: stay put
      if (page.url.pathname !== "/mint") await goto("/mint");
    } catch { /* a convenience, never an error */ }
  }

  async function signInDev(e: Event) {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    busy = true;
    try {
      await chain.signIn(name);
    } finally {
      busy = false;
    }
  }
</script>

{#if !WALLET_MODE}
  <!-- Dev chain: no wallet exists, so asking for one would be theatre. -->
  <form onsubmit={signInDev}>
    <input placeholder="account" bind:value={username} disabled={busy} />
    <button type="submit" disabled={busy}>sign in</button>
  </form>
{:else if !open}
  <button onclick={() => (open = true)}>sign in</button>
{:else}
  <div class="sheet">
    <div class="head">
      <strong>Sign in with your Hive wallet</strong>
      <button class="ghost small" onclick={() => (open = false)}>✕</button>
    </div>

    <label class="field">
      <span>Hive account</span>
      <input placeholder="lasseehlers" bind:value={username} disabled={busy} autocomplete="username" />
    </label>

    <div class="wallets">
      {#each wallets as w (w.id)}
        <button
          class="ghost"
          disabled={busy || !w.available}
          onclick={() => signInWith(w.id)}
        >
          {w.label}
          {#if !w.available}<small>not installed</small>{/if}
        </button>
      {/each}
    </div>

    {#if error}<p class="err">{error}</p>{/if}

    <p class="note">
      Your key never leaves your wallet. LasseCash asks for
      <strong>posting</strong> authority only — enough to publish and vote, and
      it cannot move funds. Anything that touches value asks for active
      authority separately, at the moment you do it.
    </p>
  </div>
{/if}

<style>
  form { display: flex; gap: 0.35rem; }
  form input { width: 9rem; }

  .sheet {
    position: absolute; right: 1rem; top: 3.4rem; z-index: 40;
    width: min(22rem, calc(100vw - 2rem));
    background: var(--panel); border: 1px solid var(--gold-dim);
    border-radius: var(--r); padding: 0.9rem;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
  }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.7rem; }
  .head strong { font-size: var(--t-sm); font-family: var(--mono); }

  .wallets { display: grid; gap: 0.4rem; }
  .wallets button { width: 100%; justify-content: flex-start; text-align: left; }
  .wallets small { display: block; font-size: var(--t-micro); opacity: 0.6; font-weight: 500; }

  .err { color: var(--red); font-size: var(--t-sm); margin: 0.6rem 0 0; }
  .note { margin: 0.75rem 0 0; font-size: var(--t-tiny); color: var(--dim); line-height: 1.55; }
</style>

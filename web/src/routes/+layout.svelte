<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { chain, restoreSession } from "$lib/chain.svelte.js";
  import { hbdPref } from "$lib/hbd.svelte.js";
  import SignIn from "$lib/SignIn.svelte";
  import { displayName } from "$lib/format.js";
  import "../app.css";

  let { children } = $props();

  // Keep in sync with the same literal in routes/admin/+page.svelte (the
  // soft page gate) — this constant is not worth centralizing for one string.
  const FOUNDER = "hive:lasseehlers";
  // Governance is for EVERYONE: the top 10 is a public fact, and the value in
  // force for every governable parameter is readable by anyone. The founder's
  // private console is the MIGRATION console — named for what it does, so
  // "Admin" never reads as a set of powers over the protocol that nobody has.
  const navLinks = $derived([
    ["/feed", "Feed"], ["/compose", "Write"], ["/", "Mint"], ["/pool", "Pool"],
    ["/chain", "Chain"], ["/governance", "Governance"], ["/about", "About"],
    ...(chain.account === FOUNDER ? [["/admin", "Migration"]] : []),
  ]);

  /**
   * Decimal comma → dot, site-wide. Danish (and most European) keyboards
   * type "," for decimals; every amount on this site is parsed with a ".".
   * Rather than a validation error, the comma becomes a dot as it is typed,
   * caret preserved. Applies to every <input inputmode="decimal">. Runs in
   * the capture phase so the field's own oninput sees the corrected value.
   */
  function decimalComma(e: Event) {
    const el = e.target as HTMLInputElement | null;
    if (!el || el.tagName !== "INPUT" || el.inputMode !== "decimal") return;
    if (!el.value.includes(",")) return;
    const pos = el.selectionStart;
    el.value = el.value.replace(/,/g, ".");
    if (pos !== null) el.setSelectionRange(pos, pos);
    // Let Svelte's bind:value pick up the corrected string.
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  onMount(async () => {
    document.addEventListener("input", decimalComma, true);
    hbdPref.restore();
    await chain.init();
    // Dev convenience: ?as=alice signs in without a wallet. Harmless against a
    // real node, where the signer will require an actual Hive signature.
    const as = new URLSearchParams(location.search).get("as");
    if (as) void chain.signIn(as);
    else restoreSession();
  });
</script>

<div class="shell">
  <header>
    <a class="brand" href="/">
      <span class="mark">L</span>
      <span class="name">LASSECASH</span>
      <span class="tag">ANCAP SOCIETY TOOLS</span>
    </a>

    <nav>
      {#each navLinks as [href, label] (href)}
        <a {href} aria-current={page.url.pathname === href ? "page" : undefined}>{label}</a>
      {/each}
    </nav>

    <div class="session">
      {#if chain.account}
        <span class="who">{displayName(chain.account)}</span>
        <button class="ghost" onclick={() => chain.signOut()}>sign out</button>
      {:else}
        <SignIn />
      {/if}
    </div>
  </header>

  {#if chain.confirming}
    <div class="confirming" role="status">
      <span class="dot"></span> Signed — waiting for MAGI to confirm. The figures update by themselves.
    </div>
  {/if}
  {#if chain.error}
    <div class="banner error">
      <strong>Chain unreachable.</strong> {chain.error}
      <span class="hint">Start it with <code>./build.sh node</code></span>
    </div>
  {:else if !chain.ready}
    <div class="banner">Loading engine…</div>
  {/if}

  <main>{@render children()}</main>

  <footer>
    <span>What you see is what the chain pays — every figure comes from the contract itself.</span>
    <!-- LASSECASH is the unit of account here; the HBD line is a sanity check
         beside it. Some people want it and some find it noise, so it is a
         preference — on by default, remembered per browser. -->
    <button
      class="ghost small hbdtoggle"
      onclick={() => hbdPref.toggle()}
      aria-pressed={hbdPref.show}
      title="Show an approximate HBD value beside LASSECASH figures, at the pool's current price"
    >{hbdPref.show ? "≈ HBD on" : "≈ HBD off"}</button>
    {#if chain.info}
      <span class="mono">height {chain.info.height.toLocaleString()}</span>
    {/if}
  </footer>
</div>

<style>
  /* Pinned to the viewport: a status the user cannot see is no status, and
     the Publish button sits at the bottom of a long page. */
  .confirming {
    position: fixed; left: 50%; bottom: 3.2rem; transform: translateX(-50%);
    z-index: 50; max-width: min(92vw, 720px); padding: 0.5rem 0.9rem;
    background: var(--panel); border: 1px solid var(--cyan); border-radius: var(--r-sm);
    box-shadow: 0 0 18px rgba(0, 229, 255, 0.25);
    color: var(--cyan); font-family: var(--mono); font-size: var(--t-sm);
    display: flex; align-items: center; gap: 0.5rem;
  }
  .confirming .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--cyan);
    animation: blink 1.2s ease-in-out infinite;
  }
  @keyframes blink { 50% { opacity: 0.2; } }

  /* The footer is a space-between row; the toggle sits between the note and
     the height rather than pushing either off the line. */
  .hbdtoggle {
    font-size: var(--t-micro); padding: 0.12rem 0.45rem; letter-spacing: 0.06em;
  }
  .hbdtoggle[aria-pressed="true"] { color: var(--cyan); border-color: var(--line-hot); }
</style>

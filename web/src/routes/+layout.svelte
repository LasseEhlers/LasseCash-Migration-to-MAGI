<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { chain, restoreSession } from "$lib/chain.svelte.js";
  import { hbdPref } from "$lib/hbd.svelte.js";
  import SignIn from "$lib/SignIn.svelte";
  import { displayName } from "$lib/format.js";
  import { PRELAUNCH } from "$lib/site.js";
  import "../app.css";

  let { children } = $props();

  // Thresholds is for EVERYONE: the top 10 is a public fact, and the value in
  // force for every governable parameter is readable by anyone. Named
  // "Thresholds" rather than "Governance" deliberately — every value this
  // page tunes is literally a bound (a minimum L-Shares to post, a minimum
  // burn to promote, a ramp's start/end), and "governance" carries a state
  // connotation this protocol has no reason to invite.
  // The founder's private console is the MIGRATION console — named for what
  // it does, so "Admin" never reads as a set of powers over the protocol
  // that nobody has.
  // Pre-launch the nav is the two pages that are actually true today. See
  // +layout.ts — the rest redirect, so linking them would be a dead end.
  const navLinks = $derived(PRELAUNCH ? [["/check", "Snapshot"], ["/about", "About"]] : [
    ["/", "Feed"], ["/compose", "Write"], ["/mint", "Mint"], ["/pool", "Pool"],
    // Chart sits beside Pool: one is where you trade, the other is what
    // trading has done to the price.
    ["/chart", "Chart"],
    // Wallet sits after the places you DO things, because it is where you
    // check what those things did — and whether you can afford the next one.
    ["/wallet", "Wallet"],
    ["/chain", "Chain"], ["/thresholds", "Thresholds"],
    // WAS "Snapshot" -> /check. Before launch the roll call was the most
    // important page on the site; after it, the frozen record matters less
    // than what has happened since — who claimed, what they earned, whether
    // anyone is using the thing. So the nav points at the live page and the
    // snapshot is one click inside it.
    //
    // /check is still the claim funnel and the claim window runs to 30
    // September, so Stats links to it ABOVE the fold, not in a footer. A page
    // reached only by scrolling is a page nobody reaches.
    ["/stats", "Stats"], ["/about", "About"],
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

  /**
   * Phone-width honesty note. Whether it SHOWS at all is CSS (narrow
   * viewports only — a desktop never renders it), this state only remembers
   * a dismissal per browser. Starts hidden so the server-rendered HTML never
   * flashes it on a desktop before the CSS loads.
   */
  let showMobileNote = $state(false);
  function dismissMobileNote() {
    showMobileNote = false;
    try { localStorage.setItem("lc_mobile_note", "1"); } catch { /* fine */ }
  }

  onMount(async () => {
    try { showMobileNote = !localStorage.getItem("lc_mobile_note"); } catch { showMobileNote = true; }
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

    <!-- LASSECASH IS THE UNIT OF ACCOUNT HERE, and this switch is what makes
         that a choice rather than an assertion. Pricing everything in dollars
         quietly says the dollar is the money and this is a thing that
         converts to it — so the HBD line is a translation for people who
         still need one, and anybody who would rather think in LASSECASH can
         turn it off for good.
         It lived in the footer, where a preference nobody finds is a
         preference nobody has. -->
    <button
      class="unit"
      onclick={() => hbdPref.toggle()}
      aria-pressed={hbdPref.show}
      title={hbdPref.show
        ? "Showing an approximate HBD value beside LASSECASH amounts. Click to show amounts in LASSECASH only."
        : "Showing amounts in LASSECASH only. Click to show an approximate HBD value beside each amount."}
    >
      <!-- "amounts", not "prices": this toggle adds ≈HBD beside LASSECASH
           AMOUNTS (payouts, balances, rewards). The site's actual prices —
           the pool tile and the chart — are always in HBD regardless. -->
      <span class="unitlabel">amounts in</span>
      <span class="unitval">{hbdPref.show ? "LASSECASH + HBD" : "LASSECASH only"}</span>
    </button>

    <div class="session">
      {#if chain.account}
        <span class="who">{displayName(chain.account)}</span>
        <button class="ghost" onclick={() => chain.signOut()}>sign out</button>
      {:else}
        <!-- Hidden pre-launch: signing in would connect a real wallet to a
             TESTWINDOWS throwaway contract that is abandoned at genesis. -->
        {#if !PRELAUNCH}<SignIn />{/if}
      {/if}
    </div>
  </header>

  {#if showMobileNote}
    <div class="mobile-note" role="note">
      <span>Built desktop-first for now — everything works on a phone, but the
        layout is not polished yet. A proper mobile layout is coming.</span>
      <button class="mobile-note-dismiss" onclick={dismissMobileNote} aria-label="dismiss">×</button>
    </div>
  {/if}

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
    <span class="mono">
      <a href="https://discord.gg/5JW2w9t" target="_blank" rel="noopener">Discord</a>
      ·
      <a href="https://www.youtube.com/@LasseCashNews" target="_blank" rel="noopener">Crypto World News</a>
      ·
      <a href="https://lassemusic.com" target="_blank" rel="noopener">Lasse Music</a>
    </span>
    {#if chain.info}
      <span class="mono">height {chain.info.height.toLocaleString()}</span>
    {/if}
  </footer>
</div>

<style>
  /* Rendered always, SHOWN only at phone width — the media query is the
     switch, so no user-agent sniffing and no JS resize listener. Cyan
     machine chrome, not red: nothing is broken, it is a status report. */
  .mobile-note { display: none; }
  @media (max-width: 700px) {
    .mobile-note {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 8px 14px; font-family: var(--mono); font-size: var(--t-sm);
      color: var(--cyan); background: rgba(46, 230, 214, 0.06);
      border-bottom: 1px solid rgba(46, 230, 214, 0.3);
    }
    .mobile-note-dismiss {
      background: none; border: none; color: var(--cyan);
      font-size: 1.1rem; line-height: 1; cursor: pointer; padding: 2px 6px;
    }
  }

  /* A display preference, in the chrome where display preferences live. */
  .unit {
    display: inline-flex; align-items: baseline; gap: 0.35rem;
    background: none; border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: 0.25rem 0.5rem; cursor: pointer; color: var(--dim);
    font-family: var(--mono); font-size: var(--t-micro);
  }
  .unit:hover { border-color: var(--gold-dim); color: var(--ink); }
  .unitlabel { letter-spacing: 0.08em; text-transform: uppercase; }
  .unitval { color: var(--gold); font-weight: 700; }
  @media (max-width: 640px) { .unitlabel { display: none; } }


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
</style>

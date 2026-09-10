<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { chain, restoreSession, WALLET_MODE } from "$lib/chain.svelte.js";
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

  /**
   * The day-30 note. Every migration position is a 30-day mint from the same
   * genesis, so until 30 September almost nothing is liquid, the pool is thin
   * and the yield figures are extreme because very few L-Shares exist. A
   * visitor who does not know that reads the numbers as broken or as a scam.
   *
   * Lasse's framing, and it is the right one: the 30 days are not a slow
   * start to apologise for, they are the migration mechanism working. The
   * duration was chosen (2026-08-21) so that everyone becomes liquid on the
   * same day and re-decides, rather than the founder holding unchosen shares
   * for six months.
   *
   * It states MECHANICS, not a forecast. "Everything will look more
   * attractive" and "mints expected to pay a lot" are predictions about a
   * price; a protocol that puts those on every page is doing something other
   * than explaining itself, and a reader who checks the figures afterwards
   * would be right to hold it against us. The facts are the better argument.
   *
   * Disappears by itself once the cliff has passed — nothing to remember to
   * remove.
   */
  let dismissedDay30 = $state(false);
  const CLIFF_DAY = 30;
  const day30Passed = $derived.by(() => {
    const g = chain.info?.genesis_height ?? 0;
    const h = chain.info?.height ?? 0;
    if (!g || !h) return true; // say nothing until we know
    return (h - g) / 28_800 >= CLIFF_DAY;
  });
  const showDay30 = $derived(WALLET_MODE && !dismissedDay30 && !day30Passed);
  /**
   * Dismissal LAPSES after three days, it is not permanent.
   *
   * The note explains why every figure on the site looks the way it does, and
   * it only exists until 30 September. A permanent dismissal means someone who
   * closes it on day 8 never sees it again while it is still the explanation
   * for everything they are reading; showing it every visit is nagging. Three
   * days is quiet enough to respect the click and short enough that the note
   * is on screen again as the cliff approaches. Lasse asked 2026-09-08 after
   * dismissing it and finding no way back.
   */
  const DAY30_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

  /**
   * The Feed is the least finished part of the site, and a visitor cannot tell
   * "unfinished frontend" from "broken money" by looking. So say it plainly:
   * the payouts settle on chain and are proven, the page around them is not
   * where the rest of the site is. Same snooze as the day-30 note — a click
   * is respected, but a temporary notice that never comes back is a notice
   * nobody sees when it matters. Delete this block when the Feed is done.
   */
  let dismissedFeedNote = $state(false);
  const showFeedNote = $derived(WALLET_MODE && !dismissedFeedNote);
  function dismissFeedNote() {
    dismissedFeedNote = true;
    try { localStorage.setItem("lc_feed_note", String(Date.now())); } catch { /* fine */ }
  }
  function dismissDay30() {
    dismissedDay30 = true;
    try { localStorage.setItem("lc_day30_note", String(Date.now())); } catch { /* fine */ }
  }

  onMount(async () => {
    try { showMobileNote = !localStorage.getItem("lc_mobile_note"); } catch { showMobileNote = true; }
    try {
      const feedAt = Number(localStorage.getItem("lc_feed_note") || 0);
      dismissedFeedNote = feedAt > 0 && Date.now() - feedAt < DAY30_SNOOZE_MS;
      const at = Number(localStorage.getItem("lc_day30_note") || 0);
      // A pre-existing "1" from the first build parses to 1 ms since epoch,
      // which is long lapsed — so those browsers simply see it once more.
      dismissedDay30 = at > 0 && Date.now() - at < DAY30_SNOOZE_MS;
    } catch { /* fine */ }
    document.addEventListener("input", decimalComma, true);
    hbdPref.restore();
    await chain.init();
    // Dev convenience: ?as=alice signs in without a wallet. Harmless against a
    // real node, where the signer will require an actual Hive signature.
    const as = new URLSearchParams(location.search).get("as");
    if (as) void chain.signIn(as);
    else restoreSession();
  });

  // Nothing polled chain.info before this — a tab just froze at whatever the
  // reserves were on its last load, no matter how much trading happened
  // elsewhere, with no visual sign anything was stale. Found live, 2026-09-04:
  // a Pool tab left open showed a swap quote against reserves that were two
  // large sells (150,000 LC) out of date. A 30s poll fixes the steady case;
  // the visibilitychange listener fixes the worse one — switching back to a
  // tab that sat backgrounded for an hour now refreshes immediately instead
  // of waiting up to 30s more on top of however long it was already stale.
  onMount(() => {
    function tick() {
      if (document.visibilityState === "visible") void chain.refresh();
    }
    const interval = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
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
        <!-- Exact match is not enough: /about has sub-routes (/about/short,
             /about/full), and an exact-only check left it permanently unlit
             the moment you were on either tab (found live 2026-09-04). Every
             other nav target is a single page with no sub-routes today, so
             this only ever WIDENS the match for /about; guard on href !== "/"
             so Feed's "/" does not light up for every page on the site. -->
        <a
          {href}
          aria-current={page.url.pathname === href ||
            (href !== "/" && page.url.pathname.startsWith(href + "/"))
            ? "page" : undefined}
        >{label}</a>
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

  {#if showDay30}
    <div class="day30" role="note">
      <span>
        <strong>The first 30 days are the migration itself, by design.</strong>
        Every snapshot position is a 30-day mint, so little is liquid and
        the pool yield looks high. On <strong>30 September</strong> they all
        mature at once — that is where price discovery becomes effective. A 100%
        free-market product.
        <a href="/about">How it works</a>
      </span>
      <button class="day30-dismiss" onclick={dismissDay30} aria-label="dismiss">×</button>
    </div>
  {/if}

  {#if showFeedNote}
    <div class="day30 feednote" role="note">
      <span>
        <strong>The Feed still needs work.</strong>
        Posts and payouts settle correctly on chain — that part is proven and
        the figures are real — but the Feed's frontend is not where the rest of
        the site is yet, and it is not the priority right now. Apologies for the
        rough edges. Everything else is close to done, the core has been tested
        endlessly, and <strong>your funds are safe</strong>.
      </span>
      <button class="day30-dismiss" onclick={dismissFeedNote} aria-label="dismiss">×</button>
    </div>
  {/if}
  {#if chain.confirming}
    <div class="confirming" role="status">
      <span class="dot"></span> Signed — waiting for MAGI to confirm. The figures update by themselves.
    </div>
  {/if}
  {#if chain.outage}
    <div class="banner error">
      {#if WALLET_MODE}
        <strong>MAGI's node is not answering.</strong>
        {chain.info ? "Showing the last figures loaded — retrying every 30 seconds." : "Retrying every 30 seconds."}
      {:else}
        <strong>Chain unreachable.</strong> {chain.error}
        <span class="hint">Start it with <code>./build.sh node</code></span>
      {/if}
    </div>
  {:else if !chain.ready}
    <div class="banner">Loading engine…</div>
  {/if}

  <main>{@render children()}</main>

  <footer>
    <span>What you see is what the chain pays — every figure comes from the contract itself.</span>
    <span class="mono">
      <a href="https://discord.gg/wNhQrG44DC" target="_blank" rel="noopener">Discord</a>
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
  .day30 {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid color-mix(in srgb, var(--gold) 28%, transparent);
    background: color-mix(in srgb, var(--gold) 7%, var(--panel));
    color: var(--fg);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .day30 strong { color: var(--gold); }
  .day30 a { color: var(--gold); }
  .feednote { border-top: 0; }
  .day30-dismiss {
    margin-left: auto;
    background: none;
    border: 0;
    color: var(--dim);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .day30-dismiss:hover { color: var(--fg); }

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

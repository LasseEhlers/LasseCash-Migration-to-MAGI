<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { chain, restoreSession } from "$lib/chain.svelte.js";
  import SignIn from "$lib/SignIn.svelte";
  import { displayName } from "$lib/format.js";
  import "../app.css";

  let { children } = $props();

  // Keep in sync with the same literal in routes/admin/+page.svelte (the
  // soft page gate) — this constant is not worth centralizing for one string.
  const FOUNDER = "hive:lasseehlers";
  const navLinks = $derived([
    ["/feed", "Feed"], ["/compose", "Write"], ["/", "Mint"], ["/pool", "Pool"],
    ["/chain", "Chain"], ["/about", "About"],
    ...(chain.account === FOUNDER ? [["/admin", "Admin"]] : []),
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
    {#if chain.info}
      <span class="mono">height {chain.info.height.toLocaleString()}</span>
    {/if}
  </footer>
</div>

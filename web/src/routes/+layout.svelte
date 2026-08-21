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
    ["/feed", "Feed"], ["/compose", "Write"], ["/", "Mint"], ["/pool", "Pool"], ["/chain", "Chain"],
    ...(chain.account === FOUNDER ? [["/admin", "Admin"]] : []),
  ]);

  onMount(async () => {
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

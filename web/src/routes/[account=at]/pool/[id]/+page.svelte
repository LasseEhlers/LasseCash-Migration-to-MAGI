<script lang="ts">
  /**
   * ONE POOL POSITION (tranche), ITS WHOLE LIFE. Same rules as the mint card:
   * deposits, reward claims and the withdrawal are the contract's own return
   * values; an open position's value and pending reward are the engine's live
   * reading, labelled as such. No ranking.
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { lc, mult, shortDate } from "$lib/format.js";
  import Hbd from "$lib/Hbd.svelte";
  import Seo from "$lib/Seo.svelte";
  import { SITE_URL } from "$lib/site.js";
  import {
    fromUnits, lcToHbd, reservesAt, toBaseUnitArg, toUnits, trancheStory,
    type Amount, type PoolTrade, type TrancheStory, type TrancheView,
  } from "$api/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let story = $state<TrancheStory | null>(null);
  let live = $state<TrancheView | null>(null);
  let trades = $state<PoolTrade[]>([]);
  let error = $state<string | null>(null);
  let loaded = $state(false);

  async function load() {
    try {
      const [calls, view, pool] = await Promise.all([
        client.positionCalls(data.account),
        client.accountOf(data.account),
        client.poolTrades().catch(() => ({ trades: [] as PoolTrade[] })),
      ]);
      live = view.tranches.find((t) => t.id === data.id) ?? null;
      const s = trancheStory(data.id, calls);
      if (!live && !s.depositTxId) { error = "This pool position does not exist."; return; }
      story = s;
      trades = pool.trades;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loaded = true;
    }
  }
  $effect(() => { if (chain.ready && chain.info && !loaded) void load(); });

  function hbdAt(amount: Amount | null, height: number | null): Amount | null {
    if (!amount || height === null) return null;
    const r = reservesAt(trades, height);
    if (!r) return null;
    try { return lcToHbd(toBaseUnitArg(amount), toBaseUnitArg(r.lc), toBaseUnitArg(r.hbd)); }
    catch { return null; }
  }

  const closed = $derived(!!story?.withdrawTxId || !!live?.closed);
  /** Each claim priced at its own moment, then added — what the rewards were worth when taken. */
  const claimedHbd = $derived.by(() => {
    if (!story || !story.claims.length) return null;
    let total = 0n;
    for (const c of story.claims) {
      const v = hbdAt(c.amount, c.height);
      if (v === null) return null;
      total += toUnits(v);
    }
    return fromUnits(total);
  });
  const tx = (id: string) => `https://vsc.techcoderx.com/tx/${id}`;
</script>

<Seo
  title={`Pool position #${data.id} by @${data.handle}`}
  description={`One LASSECASH:HBD liquidity position by @${data.handle}, read from the chain.`}
  canonical={`${SITE_URL}/@${data.handle}/pool/${data.id}`}
/>

<p class="crumbs"><a href="/@{data.handle}">← @{data.handle}</a></p>
<h1>Pool position #{data.id} <span class="dim">by @{data.handle}</span></h1>

{#if error}
  <div class="panel"><p>{error}</p></div>
{:else if !story}
  <div class="panel"><p class="dim">Reading the chain…</p></div>
{:else}
  <p class="origin dim">LASSECASH:HBD liquidity · <span class="pill">{closed ? "Withdrawn" : "Open"}</span></p>

  <div class="panel grid">
    <div><dt>Deposited</dt>
      <dd class="mono">{story.depositLc ? lc(story.depositLc, 2) : "—"} <span class="unit">LASSECASH</span></dd>
      <dd class="mono">{story.depositHbd ? lc(story.depositHbd, 3) : "—"} <span class="unit">HBD</span></dd>
      <dd class="dim">{story.depositTime ? shortDate(story.depositTime) : ""}</dd></div>
    <div><dt>Rewards claimed</dt><dd class="mono gold">{lc(story.claimedTotal, 2)}</dd>
      <dd class="dim">{story.claims.length} claim{story.claims.length === 1 ? "" : "s"}{#if claimedHbd}&nbsp;· ≈ {lc(claimedHbd, 3)} HBD when claimed{/if}</dd></div>
    {#if story.withdrawTxId}
      <div><dt>Withdrawn</dt>
        <dd class="mono">{lc(story.withdrawLc!, 2)} <span class="unit">LASSECASH</span></dd>
        <dd class="mono">{lc(story.withdrawHbd!, 3)} <span class="unit">HBD</span></dd>
        <dd class="dim">{story.withdrawTime ? shortDate(story.withdrawTime) : ""} · includes rewards not yet claimed</dd></div>
    {/if}
  </div>

  {#if live && !live.closed}
    <section class="panel">
      <h2>Live <span class="dim">— changes every block</span></h2>
      <div class="grid">
        <div><dt>Worth now</dt><dd class="mono">{lc(live.value_lc, 2)} <span class="unit">LASSECASH</span></dd>
          <dd class="mono">{lc(live.value_hbd, 3)} <span class="unit">HBD</span></dd></div>
        <div><dt>Reward waiting</dt><dd class="mono gold">{lc(live.pending_reward, 2)}</dd>
          <dd><Hbd amount={live.pending_reward} /></dd></div>
        <div><dt>Loyalty</dt><dd class="mono">{mult(live.loyalty_multiplier)}</dd>
          <dd class="dim">day {live.age_days}; +1% a day up to 90 days</dd></div>
      </div>
      <p class="note dim">The position's share of the pool is fixed; what it is worth moves with every trade.</p>
    </section>
  {/if}

  <p class="links dim">
    {#if story.depositTxId}<a href={tx(story.depositTxId)} target="_blank" rel="noopener">Deposit ↗</a>{/if}
    {#each story.claims as c, i} · <a href={tx(c.txId)} target="_blank" rel="noopener">Claim {i + 1} ↗</a>{/each}
    {#if story.withdrawTxId} · <a href={tx(story.withdrawTxId)} target="_blank" rel="noopener">Withdrawal ↗</a>{/if}
  </p>
{/if}

<style>
  .crumbs { margin: 0 0 .4rem; font-size: .8rem; }
  h1 { margin: 0 0 .3rem; }
  h1 .dim { font-weight: normal; font-size: .7em; }
  h2 { font-size: 1rem; margin: 0 0 .75rem; }
  .origin { margin: 0 0 1rem; font-size: .9rem; }
  .pill { display: inline-block; padding: .05rem .5rem; border: 1px solid var(--gold-dim); color: var(--gold);
          border-radius: 3px; font-size: .75rem; letter-spacing: .04em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 1rem; }
  .panel { margin-bottom: 1rem; }
  dt { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  dd { margin: .2rem 0 0; }
  dd.mono { font-size: 1.2rem; font-variant-numeric: tabular-nums; }
  dd.dim { font-size: .75rem; }
  .unit { font-size: .7rem; color: var(--dim); }
  .gold { color: var(--gold); }
  .note { font-size: .8rem; margin: .9rem 0 0; }
  .links { font-size: .85rem; }
  .links a, .crumbs a { text-decoration: underline; text-underline-offset: 2px; }
</style>

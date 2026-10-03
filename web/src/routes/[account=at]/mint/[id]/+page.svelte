<script lang="ts">
  /**
   * ONE MINT, ITS WHOLE LIFE. Its own address so it can be shared, and a
   * finished mint's figures are settled — true today and in ten years.
   *
   * Settled figures come from the chain's own record and the claim's return
   * value (position-history.ts). An open mint's figures are the engine's live
   * reading, and say so. HBD values at a past moment use the pool's reserves
   * as the last trade before that moment left them — post-migration prices
   * only, by decision of 2026-10-03.
   *
   * No ranking anywhere: a card is about one position, never "best mints".
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { lc, shortDate } from "$lib/format.js";
  import Hbd from "$lib/Hbd.svelte";
  import Seo from "$lib/Seo.svelte";
  import { SITE_URL } from "$lib/site.js";
  import {
    lcToHbd, mintStory, reservesAt, toBaseUnitArg,
    type Amount, type MintStory, type MintView, type PoolTrade,
  } from "$api/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let story = $state<MintStory | null>(null);
  let live = $state<MintView | null>(null);
  let trades = $state<PoolTrade[]>([]);
  let error = $state<string | null>(null);
  let loaded = $state(false);

  async function load() {
    try {
      const info = chain.info!;
      const key = `mint_${data.account}_${data.id}`;
      const [st, calls, view, pool] = await Promise.all([
        client.state([key]),
        client.positionCalls(data.account),
        client.accountOf(data.account),
        client.poolTrades().catch(() => ({ trades: [] as PoolTrade[] })),
      ]);
      if (!st[key]) { error = "This mint does not exist."; return; }
      story = mintStory(data.id, st[key]!, calls, info.genesis_height);
      live = view.mints.find((m) => m.id === data.id) ?? null;
      trades = pool.trades;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loaded = true;
    }
  }
  $effect(() => { if (chain.ready && chain.info && !loaded) void load(); });

  /** HBD value of `amount` at the pool price in force at `height`. */
  function hbdAt(amount: Amount | null, height: number | null): Amount | null {
    if (!amount || height === null) return null;
    const r = reservesAt(trades, height);
    if (!r) return null;
    try { return lcToHbd(toBaseUnitArg(amount), toBaseUnitArg(r.lc), toBaseUnitArg(r.hbd)); }
    catch { return null; }
  }

  const ORIGIN = {
    migration: "Migration mint — LASSECASH POWER carried over from Hive-Engine",
    capital: "Minted by hand",
    earnings: "Monthly mint of post and curation earnings",
  } as const;

  const status = $derived(
    !story ? "" :
    story.paidOut !== null ? (story.endedEarly ? "Ended early" : "Claimed") :
    story.ended ? "Closed" :
    live?.claimable ? "Ready to claim" :
    live?.mature ? "Matured" : "Locked",
  );
  const startHbd = $derived(story ? hbdAt(story.principal, story.startHeight) : null);
  const endHbd = $derived(story ? hbdAt(story.paidOut, story.claimHeight) : null);
  const tx = (id: string) => `https://vsc.techcoderx.com/tx/${id}`;
  const pct = (n: number | null) => n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
</script>

<Seo
  title={`Mint #${data.id} by @${data.handle}`}
  description={`One LasseCash mint by @${data.handle}: what went in, what came out, read from the chain.`}
  canonical={`${SITE_URL}/@${data.handle}/mint/${data.id}`}
/>

<p class="crumbs"><a href="/@{data.handle}">← @{data.handle}</a></p>
<h1>Mint #{data.id} <span class="dim">by @{data.handle}</span></h1>

{#if error}
  <div class="panel"><p>{error}</p></div>
{:else if !story}
  <div class="panel"><p class="dim">Reading the chain…</p></div>
{:else}
  <p class="origin dim">{ORIGIN[story.origin]} · <span class="pill">{status}</span></p>

  <div class="panel grid">
    <div><dt>Principal</dt><dd class="mono">{lc(story.principal, 2)}</dd>
      {#if startHbd}<dd class="dim mono">≈ {lc(startHbd, 3)} HBD then</dd>{/if}</div>
    <div><dt>Term</dt><dd class="mono">{story.days} days</dd>
      <dd class="dim">{story.startTime ? shortDate(story.startTime) : `height ${story.startHeight.toLocaleString()}`}</dd></div>
    <div><dt>L-Shares</dt><dd class="mono">{lc(story.shares, 2)}</dd>
      <dd class="dim">{story.ended ? "ended with the mint" : "voting weight and yield weight"}</dd></div>
  </div>

  {#if story.paidOut !== null}
    <section class="panel settled">
      <h2>Settled <span class="dim">— final, read from the claim</span></h2>
      <div class="grid">
        <div><dt>Paid out</dt><dd class="mono gold">{lc(story.paidOut, 2)}</dd>
          {#if endHbd}<dd class="dim mono">≈ {lc(endHbd, 3)} HBD at the time</dd>{/if}</div>
        <div><dt>{story.endedEarly ? "Result" : "Yield"}</dt>
          <dd class="mono" class:gold={(story.gainPct ?? 0) >= 0}>{lc(story.gain!, 2)}</dd>
          <dd class="dim mono">{pct(story.gainPct)} over {story.heldDays} days</dd></div>
        <div><dt>Annualised</dt><dd class="mono">{pct(story.annualisedPct)}</dd>
          <dd class="dim">this mint's own result scaled to a year — not a forecast</dd></div>
      </div>
      <p class="note dim">
        Claimed {story.claimTime ? shortDate(story.claimTime) : ""}.
        {#if story.endedEarly}Ended before maturity, so part of the principal went to the reward pool.{/if}
        Paid in LASSECASH; HBD figures are at the pool price of that moment.
      </p>
    </section>
  {:else if live && !live.ended}
    <section class="panel">
      <h2>Live <span class="dim">— changes every block</span></h2>
      <div class="grid">
        <div><dt>Yield so far</dt><dd class="mono gold">{lc(live.pending_yield, 2)}</dd>
          <dd><Hbd amount={live.pending_yield} /></dd></div>
        <div><dt>If claimed now</dt><dd class="mono">{lc(live.if_claimed_now, 2)}</dd>
          <dd><Hbd amount={live.if_claimed_now} /></dd></div>
        <div><dt>Matures</dt><dd class="mono">{shortDate(live.maturity_time)}</dd>
          <dd class="dim">{live.claimable ? "claimable now" : live.mature ? "claimable once the maturity day closes" : "yield stops at maturity"}</dd></div>
      </div>
      <p class="note dim">An estimate from the engine: the yield depends on emission and on how many others mint.</p>
    </section>
  {:else if story.ended}
    <div class="panel"><p class="dim">Closed without a claim by its owner — swept after it had bled to zero.</p></div>
  {/if}

  <p class="links dim">
    {#if story.startTxId}<a href={tx(story.startTxId)} target="_blank" rel="noopener">{story.origin === "migration" ? "Claim of the migration" : "Mint transaction"} ↗</a>{/if}
    {#if story.claimTxId} · <a href={tx(story.claimTxId)} target="_blank" rel="noopener">Claim transaction ↗</a>{/if}
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
  .gold { color: var(--gold); }
  .note { font-size: .8rem; margin: .9rem 0 0; }
  .links { font-size: .85rem; }
  .links a, .crumbs a { text-decoration: underline; text-underline-offset: 2px; }
</style>

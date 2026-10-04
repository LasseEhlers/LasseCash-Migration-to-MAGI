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
    HEIGHTS_PER_DAY, MIN_YEAR_DAYS, dailyRewards, estimateRewardShare, fromUnits, lcToHbd, mintStory, reservesAt, toBaseUnitArg, toUnits,
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
  /** Which day of its term an open mint is on: heights are 3 s, 28,800 a day. */
  const dayOf = $derived(
    story && !story.ended && chain.info
      ? Math.min(story.days, Math.floor((chain.info.height - story.startHeight) / 28_800) + 1)
      : null,
  );
  /** What an open mint has earned so far, as a share of its principal —
   *  presentation of two engine figures, scaled to a year only from day 7. */
  const pace = $derived.by(() => {
    if (!story || !live || live.ended || !chain.info) return null;
    const p = toUnits(story.principal);
    if (p === 0n) return null;
    const heights = chain.info.height - story.startHeight;
    if (heights <= 0) return null;
    const pctNow = Number((toUnits(live.pending_yield) * 1_000_000n) / p) / 10_000;
    const days = heights / HEIGHTS_PER_DAY;
    return {
      pct: pctNow,
      days: Math.round(days * 10) / 10,
      perYear: days >= MIN_YEAR_DAYS ? Math.round((pctNow * 365 / days) * 100) / 100 : null,
    };
  });
  /**
   * FORWARD: what these shares earn at TODAY's share base — the same engine
   * figure the Mint page shows for a new mint (dailyRewards' L-Share slice,
   * split by estimateRewardShare), except this mint is already in the total.
   * A mint made before the 30 September cliff reads low on "pace so far",
   * because it shared with every migration mint; this is the fair picture of
   * the choice today. Labelled an estimate: it falls as others mint.
   */
  const ahead = $derived.by(() => {
    const info = chain.info;
    if (!story || !live || live.ended || live.mature || !info || !chain.ready) return null;
    try {
      const daily = dailyRewards(info.genesis_height, info.height).lshare;
      const mine = toBaseUnitArg(story.shares);
      const total = toBaseUnitArg(info.total_shares);
      if (BigInt(total) <= 0n) return null;
      const perDay = estimateRewardShare(toBaseUnitArg(daily), mine, total);
      const perYear = fromUnits(toUnits(perDay) * 365n);
      const p = toUnits(story.principal);
      const pctYear = p > 0n ? Number((toUnits(perYear) * 10_000n) / p) / 100 : null;
      // BY MATURITY: what is already earned plus today's daily rate for the
      // days left. For a short mint this is the honest headline — a 7-day
      // mint never runs a year, so its yearly figure is hypothetical.
      const left = Math.max(0, live.maturity_height - info.height) / HEIGHTS_PER_DAY;
      const byEnd = toUnits(live.pending_yield) + (toUnits(perDay) * BigInt(Math.round(left * 1000))) / 1000n;
      const pctEnd = p > 0n ? Number((byEnd * 10_000n) / p) / 100 : null;
      return { perDay, perYear, pctYear, byEnd: fromUnits(byEnd), pctEnd };
    } catch { return null; }
  });
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
      {#if startHbd}<dd class="dim mono">≈ {lc(startHbd, 3)} HBD when minted</dd>{/if}</div>
    <div><dt>Term</dt><dd class="mono">{story.days} days</dd>
      <dd class="dim">{story.startTime ? shortDate(story.startTime) : `height ${story.startHeight.toLocaleString()}`}{#if dayOf} · day {dayOf} of {story.days}{/if}</dd></div>
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
        <div><dt>If it ran a year</dt><dd class="mono">{pct(story.annualisedPct)} <span class="unit">a year</span></dd>
          {#if story.annualisedGain}<dd class="dim mono">≈ {lc(story.annualisedGain, 0)} LASSECASH a year on {lc(story.principal, 0)}</dd>{/if}
          <dd class="dim">at the pace this mint earned — not a forecast</dd></div>
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
        <div><dt>Pace so far</dt>
          {#if pace}
            <dd class="mono">{pct(pace.pct)} <span class="unit">in {pace.days} days</span></dd>
            {#if pace.perYear !== null}<dd class="dim mono">≈ {pct(pace.perYear)} a year at this pace</dd>
            {:else}<dd class="dim">a yearly figure appears from day {MIN_YEAR_DAYS}</dd>{/if}
            <dd class="dim">backward-looking; the rate falls as others mint</dd>
          {:else}<dd class="dim">—</dd>{/if}</div>
        <div><dt>At today's share base</dt>
          {#if ahead}
            <dd class="mono gold">{pct(ahead.pctYear)} <span class="unit">a year</span></dd>
            <dd class="dim mono">≈ {lc(ahead.perYear, 0)} LASSECASH a year · {lc(ahead.perDay, 2)} a day</dd>
            <dd class="mono">by maturity ≈ {lc(ahead.byEnd, 0)} <span class="unit">LASSECASH</span> ({pct(ahead.pctEnd)})</dd>
            <dd class="dim">estimate — falls as others mint</dd>
          {:else}<dd class="dim">—</dd>{/if}</div>
        <div><dt>Matures</dt><dd class="mono">{shortDate(live.maturity_time)}</dd>
          <dd class="dim">{live.claimable ? "claimable now" : live.mature ? "claimable once the maturity day closes" : "yield stops at maturity"}</dd></div>
      </div>
      <p class="note dim">
        An estimate from the engine: the yield depends on emission and on how many others mint.
        Yield is credited as each day closes, and the chain writes that down with the next
        transaction anyone makes — so a fresh mint can read 0 for a while without anything being lost.
      </p>
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
  .unit { font-size: .7rem; color: var(--dim); }
  .note { font-size: .8rem; margin: .9rem 0 0; }
  .links { font-size: .85rem; }
  .links a, .crumbs a { text-decoration: underline; text-underline-offset: 2px; }
</style>

<script lang="ts">
  /** LasseMint — the dashboard. */
  import { chain } from "$lib/chain.svelte.js";
  import { displayName, lc, lcShort, durationWords } from "$lib/format.js";
  import MintForm from "$lib/MintForm.svelte";
  import MintCard from "$lib/MintCard.svelte";
  import RateChart from "$lib/RateChart.svelte";
  import {
    constants, dailyRewards, estimateRewardShare, shareRate, shareRateHbd, toBaseUnitArg,
  } from "$api/index.js";

  const me = $derived(chain.me);
  const openMints = $derived((me?.mints ?? []).filter((m) => !m.ended));

  /** Bleeding positions are losing money right now — surface them first. */
  const alarming = $derived(
    openMints.filter((m) => m.bleed_remaining_pct !== "1.00000000" && m.bleed_remaining_pct !== "0.00000000"),
  );
  const matured = $derived(openMints.filter((m) => m.mature && m.bleed_remaining_pct === "1.00000000"));

  /**
   * The next mint to come due.
   *
   * Anything already mature is claimable NOW, so it takes priority — reporting
   * "no open mints" while a matured position sits in the table (as an earlier
   * version did) is worse than useless.
   */
  const claimableNow = $derived(openMints.filter((m) => m.mature));
  const nextUp = $derived.by(() => {
    const future = openMints.filter((m) => !m.mature);
    if (future.length === 0) return null;
    return future.reduce((a, b) => (a.maturity_height < b.maturity_height ? a : b));
  });

  const height = $derived(chain.info?.height ?? 0);

  /**
   * Today's mint rewards: the L-Share slice of today's emission — a constant
   * within an era — and the caller's cut of it at the current share split.
   * Both from the engine. The cut is an ESTIMATE only in that total shares
   * move as others mint and mature.
   */
  const todaysLShare = $derived.by(() => {
    if (!chain.ready || !chain.info) return null;
    return dailyRewards(chain.info.genesis_height, chain.info.height).lshare;
  });
  const myDailyCut = $derived.by(() => {
    if (!todaysLShare || !me || !chain.info) return null;
    if (me.shares === "0.00000000" || chain.info.total_shares === "0.00000000") return null;
    return estimateRewardShare(
      toBaseUnitArg(todaysLShare), toBaseUnitArg(me.shares), toBaseUnitArg(chain.info.total_shares),
    );
  });
  const genesis = $derived(chain.info?.genesis_height ?? 0);

  /** Current L-Share rate. EXACT — a pure function of height. */
  const currentRate = $derived(
    chain.ready && chain.info ? shareRate(genesis, height) : null,
  );

  /** Same rate at today's pool price. ESTIMATE — null while the pool is unseeded. */
  const currentRateHbd = $derived.by(() => {
    if (!chain.ready || !chain.info) return null;
    return shareRateHbd(
      genesis, height,
      toBaseUnitArg(chain.info.amm_lc), toBaseUnitArg(chain.info.amm_hbd),
    );
  });

  const RATE_CHART_YEARS = 10;
  const RATE_CHART_POINTS = 80;

  /** Where "now" sits on the charts' x-axis, in years since genesis. */
  const nowYears = $derived.by(() => {
    if (!chain.ready || !chain.info) return 0;
    const heightsPerYear = Number(constants().heightsPerYear);
    return heightsPerYear > 0 ? (height - genesis) / heightsPerYear : 0;
  });

  /**
   * Sampled series for both charts, genesis to genesis+10yr. Both curves come
   * straight from the engine at each sampled height — plotting the numbers is
   * presentation, but every number plotted is one the engine computed.
   */
  const rateSeries = $derived.by(() => {
    if (!chain.ready || !chain.info) return null;
    const heightsPerYear = Number(constants().heightsPerYear);
    const span = RATE_CHART_YEARS * heightsPerYear;
    const lcReserve = toBaseUnitArg(chain.info.amm_lc);
    const hbdReserve = toBaseUnitArg(chain.info.amm_hbd);

    const lcPoints: { x: number; y: number }[] = [];
    const hbdPoints: { x: number; y: number }[] = [];
    let hbdSeeded = true;

    for (let i = 0; i < RATE_CHART_POINTS; i++) {
      const t = i / (RATE_CHART_POINTS - 1);
      const h = genesis + Math.round(t * span);
      const years = t * RATE_CHART_YEARS;

      lcPoints.push({ x: years, y: Number(shareRate(genesis, h)) });

      if (hbdSeeded) {
        const v = shareRateHbd(genesis, h, lcReserve, hbdReserve);
        if (v === null) hbdSeeded = false;
        else hbdPoints.push({ x: years, y: Number(v) });
      }
    }

    return { lcPoints, hbdPoints: hbdSeeded ? hbdPoints : null };
  });
</script>

<div class="grid">
  {#if alarming.length > 0}
    <div class="alarm-bar">
      <strong>{alarming.length} mint{alarming.length > 1 ? "s are" : " is"} bleeding.</strong>
      Value is draining every block. Claim below.
    </div>
  {/if}

  <section class="stats">
    <div class="panel stat">
      <div class="label">Liquid</div>
      <div class="value">{me ? lcShort(me.balance) : "—"}</div>
      <div class="sub">LASSECASH</div>
    </div>
    <div class="panel stat">
      <div class="label">L-Shares</div>
      <div class="value gold">{me ? lcShort(me.shares) : "—"}</div>
      <div class="sub">voting power &amp; yield weight</div>
    </div>
    <div class="panel stat">
      <div class="label">Pending rewards</div>
      <div class="value">{me ? lcShort(me.pending) : "—"}</div>
      <div class="sub">
        mints on the 1st{#if me && me.pending_curation > 0}
          · {me.pending_curation} curation claim{me.pending_curation > 1 ? "s" : ""} queued
        {/if}
      </div>
      {#if chain.settleStoppedForRc}
        <div class="sub amber">
          Paused — your resource credits are low. The rest settles once they
          recharge; nothing is lost.
        </div>
      {/if}
    </div>
    <div class="panel stat">
      <div class="label">Next payday</div>
      {#if claimableNow.length > 0}
        <div class="value green">Ready</div>
        <div class="sub">
          {claimableNow.length} mint{claimableNow.length > 1 ? "s" : ""} claimable now
        </div>
      {:else if nextUp}
        <div class="value green">{durationWords(nextUp.maturity_height - height)}</div>
        <div class="sub">{lc(nextUp.principal)} LC matures</div>
      {:else if openMints.length > 0}
        <div class="value dim">—</div>
        <div class="sub">nothing due</div>
      {:else}
        <div class="value dim">—</div>
        <div class="sub">no open mints</div>
      {/if}
    </div>
  </section>

  <div class="row layout">
    <section class="mints panel">
      <h2>
        Your mints
        {#if matured.length}<span class="pill warn">{matured.length} ready to claim</span>{/if}
      </h2>

      {#if !chain.account}
        <p class="empty">
          <strong>Sign in to see your positions.</strong>
          Your L-Shares are your voting power and your claim on the yield pool.
        </p>
      {:else if openMints.length === 0}
        <p class="empty">
          <strong>No open mints.</strong>
          Lock LASSECASH to earn L-Shares. Longer locks and larger amounts each
          pay up to 1.5x — and they multiply, so the maximum is 2.25x.
        </p>
      {:else}
        <div class="mintlist">
          {#each openMints as mint (mint.id)}
            <MintCard {mint} />
          {/each}
        </div>
      {/if}
    </section>

    <aside class="side">
      <MintForm />

      {#if chain.info}
        <div class="panel">
          <h2>Mint rewards</h2>
          <dl>
            <dt>Today's mint rewards</dt>
            <dd class="mono gold">{todaysLShare ? lc(todaysLShare) : "—"} <span class="dim">/ day</span></dd>
            {#if myDailyCut}
              <dt class="sub">your cut</dt>
              <dd class="mono sub">{lc(myDailyCut)} <span class="dim">/ day</span></dd>
            {/if}
            <dt>Unclaimed rewards</dt><dd class="mono">{lc(chain.info.pool_lshare)}</dd>
            <dt>Network L-Shares</dt>
            <dd class="mono">{lcShort(chain.info.total_shares)}{#if me && me.shares !== "0.00000000"} <span class="dim">· you {lcShort(me.shares)}</span>{/if}</dd>
            <dt>Emitted so far</dt><dd class="mono">{lcShort(chain.info.total_emitted)} <span class="dim">of 20M</span></dd>
          </dl>
          <small class="dim">
            Every day the L-Share slice of emission is shared across all live
            L-Shares. Your yield accrues to your mint and is paid in full when
            you claim at maturity. Penalties and bleed from other mints sweep in too.
          </small>
        </div>
      {/if}
    </aside>
  </div>

  {#if chain.info}
    <section class="panel rate-panel">
      <h2>L-Share rate</h2>

      <div class="rate-top">
        <div class="hero">
          <div class="value gold">{currentRate ? lc(currentRate, 5) : "—"}</div>
          <div class="sub">LC per share</div>
        </div>
        {#if currentRateHbd}
          <p class="hbd-est dim">
            ≈ <span class="mono">{lc(currentRateHbd, 6)}</span> HBD per share at
            today's pool price
            <span class="pill info">estimate</span>
          </p>
        {/if}
      </div>

      {#if rateSeries}
        <div class="charts">
          <RateChart
            title="Rate in LASSECASH"
            subtitle="EXACT — the ratchet is deterministic, +7% a year, never down"
            points={rateSeries.lcPoints}
            nowX={nowYears}
            yFormat={(y) => y.toFixed(2)}
          />
          {#if rateSeries.hbdPoints}
            <RateChart
              title="Rate in HBD"
              subtitle="ESTIMATE — today's pool price held constant"
              points={rateSeries.hbdPoints}
              nowX={nowYears}
              yFormat={(y) => y.toFixed(6)}
            />
          {:else}
            <div class="chart-panel panel empty-chart">
              <h2>Rate in HBD</h2>
              <p class="dim">Pool not seeded yet.</p>
            </div>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .alarm-bar {
    background: #3a1618; border: 1px solid #5a2226; color: #ffc9c9;
    border-radius: var(--radius); padding: 0.8rem 1rem;
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
  @media (max-width: 720px) {
    /* Two-up rather than one tall column per figure. */
    .stats { grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  }
  .layout { align-items: flex-start; }
  .mints { flex: 1 1 620px; }
  .side { flex: 0 1 340px; display: flex; flex-direction: column; gap: 1rem; }
  .mintlist { display: grid; gap: 0.8rem; }
  h2 { display: flex; align-items: center; gap: 0.6rem; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.45rem 1rem; margin: 0 0 0.7rem; }
  dt { color: var(--dim); font-size: 0.85rem; }
  dd { margin: 0; text-align: right; }
  dt.sub, dd.sub { font-size: 0.78rem; padding-left: 0.8rem; opacity: 0.9; }

  .rate-top {
    display: flex; align-items: flex-end; gap: 1.4rem; flex-wrap: wrap;
    margin-bottom: 1.1rem;
  }
  .hero .value {
    font-family: var(--mono); font-size: var(--t-hero); font-weight: 800;
    font-variant-numeric: tabular-nums; line-height: 1.15;
    text-shadow: var(--glow-gold);
  }
  .hero .sub {
    color: var(--dim); font-size: var(--t-micro); letter-spacing: 0.13em;
    text-transform: uppercase; font-weight: 700; font-family: var(--mono);
    margin-top: 0.15rem;
  }
  .hbd-est {
    margin: 0 0 0.25rem; font-size: var(--t-sm);
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  }
  .charts { display: flex; gap: 1rem; flex-wrap: wrap; }
  .charts > :global(.chart-panel) { flex: 1 1 320px; min-width: 0; }
  .empty-chart { display: flex; flex-direction: column; justify-content: center; min-height: 150px; }
</style>

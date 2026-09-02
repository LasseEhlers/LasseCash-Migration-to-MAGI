<script lang="ts">
  /** Mint — the dashboard. */
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, lc, lcShort, durationWords } from "$lib/format.js";
  import ClaimMigration from "$lib/ClaimMigration.svelte";
  import MintForm from "$lib/MintForm.svelte";
  import MintCard from "$lib/MintCard.svelte";
  import RateChart from "$lib/RateChart.svelte";
  import Hbd from "$lib/Hbd.svelte";
  import Seo from "$lib/Seo.svelte";
  import { SITE_DESCRIPTION, SITE_NAME, SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";
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
  // Plain state, seeded from the chain when the control is opened — a derived
  // value cannot be bound to a range input, and mixing "the chain's number"
  // with "what the user is dragging" in one expression made durLocal read
  // before it was declared.
  let durOpen = $state(false);
  let durSaving = $state(false);
  let durErr = $state<string | null>(null);
  let durDays = $state(1095);
  /** What the chain currently holds, so Save can be disabled when unchanged. */
  const durSaved = $derived(chain.me?.mint_duration_days || 1095);
  function openDuration() {
    durDays = durSaved;
    durErr = null;
    durOpen = !durOpen;
  }
  async function saveDuration() {
    durErr = null; durSaving = true;
    durErr = await chain.submit(() => client.setMintDuration(durDays));
    durSaving = false;
    if (!durErr) durOpen = false;
  }

  const nowYears = $derived.by(() => {
    if (!chain.ready || !chain.info) return 0;
    const heightsPerYear = Number(constants().heightsPerYear);
    return heightsPerYear > 0 ? (height - genesis) / heightsPerYear : 0;
  });

  /**
   * WHAT AN L-SHARE HAS ACTUALLY COST, in HBD, at every real trade.
   *
   * Replaces a projection of the same curve in different units. The old
   * right-hand chart held today's price constant and drew the ratchet again,
   * so it was the left chart scaled — two panels asserting one fact, and it
   * answered a question nobody has ("what if the price never moved?").
   *
   * This answers the one a minter does have: am I buying shares cheap or
   * expensive right now? Every input is a fact — the ratchet is exact, the
   * reserves are what the pool held at that block, the heights come from the
   * chain's own `anchr_height`. Nothing is forecast.
   *
   * It will track the price chart for a long time, and that is honest rather
   * than redundant: the rate moves 0.02% a day while the pool moved 91% on a
   * single 5 HBD buy. Two days in, the share cost sits 0.034% above the raw
   * price. The ratchet only separates them over years — by which point it has
   * doubled the cost on its own.
   */
  let shareHistory = $state<{ x: number; y: number }[] | null>(null);
  $effect(() => {
    if (!chain.ready || !chain.info) return;
    const g = genesis;
    const perDay = Number(constants().heightsPerDay) || 28800;
    void client.poolTrades(500)
      .then(({ trades }) => {
        const pts = trades
          .filter((t) => t.shareHbd && t.height)
          .map((t) => ({ x: (t.height - g) / perDay, y: Number(t.shareHbd) }));
        shareHistory = pts.length > 1 ? pts : null;
      })
      .catch(() => (shareHistory = null));
  });
  const historyNowX = $derived(shareHistory?.length ? shareHistory[shareHistory.length - 1]!.x : 0);

  /**
   * Sampled series for both charts, genesis to genesis+10yr. Both curves come
   * straight from the engine at each sampled height — plotting the numbers is
   * presentation, but every number plotted is one the engine computed.
   */
  const rateSeries = $derived.by(() => {
    if (!chain.ready || !chain.info) return null;
    const heightsPerYear = Number(constants().heightsPerYear);
    const span = RATE_CHART_YEARS * heightsPerYear;
    // ONE projected curve now, not two. The HBD projection held today's price
    // constant, which made it this same curve scaled — replaced by the real
    // history above, which uses prices that actually happened.
    const lcPoints: { x: number; y: number }[] = [];
    for (let i = 0; i < RATE_CHART_POINTS; i++) {
      const t = i / (RATE_CHART_POINTS - 1);
      lcPoints.push({
        x: t * RATE_CHART_YEARS,
        y: Number(shareRate(genesis, genesis + Math.round(t * span))),
      });
    }
    return { lcPoints };
  });
</script>

<Seo
  title="LasseMint"
  description={SITE_DESCRIPTION}
  canonical={`${SITE_URL}/`}
  image={SITE_OG_IMAGE}
  schema={{
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
  }}
/>

<div class="grid">
  <!-- FIRST, above everything. An unclaimed migration position is on a clock
       that started at genesis: it matures on day 30 and bleeds to nothing by
       day 150 whether or not anyone looks. The panel hides itself when there
       is nothing to claim. -->
  <ClaimMigration />

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
      <div class="sub">LASSECASH&nbsp;{#if me}<Hbd amount={me.balance} />{/if}</div>
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
        mints on the 1st&nbsp;{#if me}<Hbd amount={me.pending} />{/if}{#if me && me.pending_curation > 0}
          · {me.pending_curation} curation claim{me.pending_curation > 1 ? "s" : ""} queued
        {/if}
      </div>
      <!-- "Mints on the 1st" raised the question and never answered it: FOR HOW
           LONG. The contract has always taken a per-account length and defaults
           to the MAXIMUM three years when none is set — and nothing could set
           one, so every account was heading for a 1,095-day lock on 1 October
           without being asked.
           It belongs here rather than on a settings page: one setting does not
           earn a nav slot, and this is the tile that poses the question. The
           control only unfolds when asked for, so the tile stays a figure. -->
      {#if me}
        <div class="sub locklen">
          locked for <b>{durationWords(durSaved * Number(constants().heightsPerDay))}</b>
          <button class="linky" onclick={openDuration}>
            {durOpen ? "close" : "change"}
          </button>
        </div>
        {#if durOpen}
          <div class="durbox">
            <!-- Deliberately NOT the word "Duration": the mint form on this
                 same page has its own duration slider, for the mint you are
                 creating now. Different words and different place, so the two
                 are never mistaken for each other. -->
            <input type="range" min="1" max="1095" step="1" bind:value={durDays} />
            <div class="durrow">
              <span class="mono">{durDays} days</span>
              <button class="ghost small" onclick={saveDuration}
                      disabled={chain.busy || durSaving || durDays === durSaved}>
                {durSaving ? "Saving…" : "Save"}
              </button>
            </div>
            {#if durErr}<p class="err small">{durErr}</p>{/if}
            <!-- THERE IS NO DEADLINE, and saying so is the point. The contract
                 reads this value at the moment the mint is created, and that
                 moment is LAZY — the mint is made the first time the account is
                 touched after the calendar month turns, not at a fixed instant.
                 So there is nothing to grey out and no cutoff to miss, and a
                 change made on the 1st still counts.
                 Left unsaid, the natural assumption is a deadline somewhere. -->
            <p class="durnote dim">
              Applies to the mint the chain creates from your post and curation
              earnings — not to mints you open yourself. Longer earns more, up
              to 1.50x at three years, and a mint's length is frozen once it is
              created.
              <br />
              <b>No deadline.</b> The value set here when the mint is made is the
              one used, and the mint is made the first time your account is
              touched after the month turns — so a change on the 1st still counts.
            </p>
          </div>
        {/if}
      {/if}
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
        <div class="sub">{lc(nextUp.principal)} LASSECASH matures</div>
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
            <dd class="mono gold">
              {todaysLShare ? lc(todaysLShare) : "—"} <span class="dim">/ day</span>
              {#if todaysLShare}<Hbd amount={todaysLShare} block />{/if}
            </dd>
            {#if myDailyCut}
              <dt class="sub">your cut</dt>
              <dd class="mono sub">
                {lc(myDailyCut)} <span class="dim">/ day</span>
                <Hbd amount={myDailyCut} block />
              </dd>
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
      <!-- BOTH CURRENT VALUES ON ONE LINE, above the charts they belong to.
           The LASSECASH rate sat in the section header while the HBD figure sat
           inside its chart panel, so the page's two headline numbers were at
           different heights and read as unrelated. They are the same fact in
           two units — Lasse's layout, and it is the right one. -->
      <div class="heads">
        <div class="head">
          <h2>L-Share rate</h2>
          <div class="value gold">{currentRate ? lc(currentRate, 5) : "—"}</div>
          <div class="sub">LASSECASH per share</div>
        </div>
        <div class="head">
          <h2>What one L-Share has cost</h2>
          <div class="value gold">{currentRateHbd ? lc(currentRateHbd, 6) : "—"}</div>
          <div class="sub">HBD per share, now</div>
        </div>
      </div>

      {#if rateSeries}
        <div class="charts">
          <RateChart
            title=""
            subtitle="EXACT — the ratchet is deterministic, +7% a year, never down"
            points={rateSeries.lcPoints}
            nowX={nowYears}
            yFormat={(y) => y.toFixed(2)}
          />
          {#if shareHistory}
            <RateChart
              title=""
              subtitle="Every trade since the pool opened — the rate underneath rises 7% a year; what moves is the pool price"
              points={shareHistory}
              nowX={historyNowX}
              yFormat={(y) => y.toFixed(6)}
            />
          {:else}
            <div class="chart-panel panel empty-chart">
              <p class="dim">Not enough trades yet.</p>
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

  /* Same two-column shape as .charts below, so each value sits over its own
     chart at every width. */
  .locklen { margin-top: 0.35rem; }
  .locklen b { color: var(--fg); }
  .linky { background: none; border: 0; padding: 0 0 0 0.35rem; font: inherit;
           color: var(--gold); text-decoration: underline; cursor: pointer; }
  .durbox { margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px solid var(--line); }
  .durbox input[type="range"] { width: 100%; }
  .durrow { display: flex; align-items: center; justify-content: space-between;
            gap: 0.5rem; margin-top: 0.3rem; }
  .durnote { font-size: var(--t-micro); line-height: 1.5; margin: 0.45rem 0 0; }
  .heads { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .head { flex: 1 1 320px; min-width: 0; }
  .head h2 { margin: 0 0 0.35rem; }
  .head .value { font-size: 2rem; line-height: 1.1; font-family: var(--mono); }
  .head .sub { font-size: var(--t-tiny); color: var(--dim); }
  .charts { display: flex; gap: 1rem; flex-wrap: wrap; }
  .charts > :global(.chart-panel) { flex: 1 1 320px; min-width: 0; }
  .empty-chart { display: flex; flex-direction: column; justify-content: center; min-height: 150px; }
</style>

<script lang="ts">
  /**
   * The dormancy clock for one liquidity tranche.
   *
   * A mint has an obvious maturity date; a tranche has nothing but a
   * last-claim height, so the clock is invisible unless this component makes
   * it loud. Mirrors MintTimeline: the two phases have very different real
   * durations (90 quiet days beside a 90-day warning), and the marker is
   * positioned proportionally *within* its own phase so it still tells the
   * truth about where you are.
   *
   * IMPORTANT — this is NOT a countdown to a loss. When a dormant position is
   * evicted, its LASSECASH and its HBD go back to the owner WHOLE. Nothing is
   * confiscated. What a dormant provider forfeits is future rewards they were
   * not there to claim, and the loyalty age they spent 90 days building. So
   * the palette is deliberately NOT the mint bleed's red: CLAUDE.md reserves
   * red for value actively being lost, and nothing is being lost here. Gold
   * for "act soon", never alarm.
   *
   * EXACT: trancheHealth is a pure function of the tranche's own last-touch
   * height and the current chain height, run through the SAME engine the
   * contract uses — never re-derived here. See CLAUDE.md, golden rule.
   *
   * Claiming resets the clock, so every phase's call to action is the same
   * one: claim.
   */

  /**
   * The caller (the pool page) computes `health` once via `trancheHealth`
   * and passes it in, rather than this component calling the bridge again —
   * the page needs the same phase to drive its "claim" call to action, so
   * there is one source of truth per tranche instead of two engine calls
   * agreeing with each other by coincidence.
   */
  let { health: h }: {
    health: { phase: 0 | 1 | 2; daysUntilEvict: number; dormantDays: number };
  } = $props();

  /** Fixed segment widths (%): 90 healthy days, then 90 warning days. */
  const W = { healthy: 55, warning: 45 };
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

  const markerLeft = $derived.by(() => {
    if (h.phase === 2) return 100;
    if (h.phase === 1) {
      // Inside the final 90 days: 90 days left = start of the warning band.
      return W.healthy + clamp01((90 - h.daysUntilEvict) / 90) * W.warning;
    }
    // 180 days left = just claimed; 90 days left = end of the healthy band.
    return clamp01((180 - h.daysUntilEvict) / 90) * W.healthy;
  });

  const label = $derived.by(() => {
    switch (h.phase) {
      case 2:
        return `dormant ${h.dormantDays} days — claim to keep this position`;
      case 1:
        return `claim within ${h.daysUntilEvict} days to keep this position`;
      default:
        return `next check-in in ${h.daysUntilEvict} days`;
    }
  });
</script>

<div class="clock" class:warn={h.phase === 1} class:due={h.phase === 2}>
  <div class="bar">
    <div class="seg healthy" style="width:{W.healthy}%"></div>
    <div class="seg warning" style="width:{W.warning}%"></div>
    <div class="marker" style="left:{markerLeft}%"></div>
  </div>
  <div class="label mono">{label}</div>
  {#if h.phase === 2}
    <div class="note">
      Anyone may return this liquidity to your wallet. You keep every
      LASSECASH and every HBD — you stop earning pool rewards, and the
      loyalty bonus starts again from 1.00x.
    </div>
  {/if}
</div>

<style>
  .clock { display: flex; flex-direction: column; gap: 0.3rem; min-width: 11rem; }
  .bar {
    position: relative; display: flex; height: 6px; border-radius: 3px;
    overflow: hidden; background: #111;
  }
  .seg { height: 100%; }
  .seg.healthy { background: #1f6f4a; }
  .seg.warning { background: #7a6320; }
  .marker {
    position: absolute; top: -2px; width: 2px; height: 10px;
    background: var(--gold, #f5c518); transform: translateX(-1px);
  }
  .label { font-size: 0.72rem; color: #9aa0a6; font-variant-numeric: tabular-nums; }
  .warn .label { color: var(--gold, #f5c518); }
  .due .label { color: var(--gold, #f5c518); font-weight: 600; }
  .due .marker { animation: pulse 1.6s ease-in-out infinite; }
  .note { font-size: 0.68rem; color: #9aa0a6; line-height: 1.35; max-width: 22rem; }
  @keyframes pulse { 50% { opacity: 0.35; } }
</style>

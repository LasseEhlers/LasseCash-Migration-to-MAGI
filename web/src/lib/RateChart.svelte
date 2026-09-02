<script lang="ts">
  /**
   * A small inline SVG line chart. No charting library — the app only ever
   * needs to plot values the engine already computed, and a dependency is not
   * worth it for one shape.
   *
   * Plotting here is PRESENTATION ONLY: `points` arrive pre-computed from the
   * engine (see CLAUDE.md golden rule); this file only maps them to pixels.
   * `Number(...)` on an engine-computed string is fine for that — it never
   * produces a DISPLAYED number, only a coordinate.
   */
  interface Point { x: number; y: number; }

  let {
    title,
    subtitle,
    points,
    nowX,
    yFormat,
    headline = null,
    headlineUnit = "",
  }: {
    title: string;
    subtitle?: string;
    points: Point[];
    nowX: number;
    yFormat: (y: number) => string;
    /** The current value this chart is about, shown above it. */
    headline?: string | null;
    headlineUnit?: string;
  } = $props();

  const W = 460;
  const H = 220;
  const padL = 60;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xMin = $derived(points.length ? points[0].x : 0);
  const xMax = $derived(points.length ? points[points.length - 1].x : 1);
  const yMinRaw = $derived(points.length ? Math.min(...points.map((p) => p.y)) : 0);
  const yMaxRaw = $derived(points.length ? Math.max(...points.map((p) => p.y)) : 1);
  // Headroom so the curve never touches the frame.
  const yPad = $derived((yMaxRaw - yMinRaw) * 0.1 || Math.abs(yMaxRaw) * 0.05 || 1);
  // NEVER BELOW ZERO on a series that has none. The padding pushed the axis
  // negative on the share-cost chart, which labelled a price -0.000098 HBD —
  // a figure that cannot exist and that makes a reader doubt the rest.
  const yLo = $derived(yMinRaw >= 0 ? Math.max(0, yMinRaw - yPad) : yMinRaw - yPad);
  const yHi = $derived(yMaxRaw + yPad);

  function px(x: number): number {
    const span = xMax - xMin || 1;
    return padL + ((x - xMin) / span) * plotW;
  }
  function py(y: number): number {
    const span = yHi - yLo || 1;
    return padT + plotH - ((y - yLo) / span) * plotH;
  }

  const linePath = $derived(
    points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x).toFixed(2)},${py(p.y).toFixed(2)}`).join(" "),
  );
  const areaPath = $derived(
    points.length
      ? `${linePath} L${px(xMax).toFixed(2)},${(padT + plotH).toFixed(2)} ` +
        `L${px(xMin).toFixed(2)},${(padT + plotH).toFixed(2)} Z`
      : "",
  );

  const X_TICKS = 6;
  const xTicks = $derived.by(() => {
    const ticks: number[] = [];
    for (let i = 0; i < X_TICKS; i++) ticks.push(xMin + ((xMax - xMin) * i) / (X_TICKS - 1));
    return ticks;
  });

  /**
   * Enough decimals to tell the ticks apart.
   *
   * Fixed at zero decimals, five ticks across two days read "0 0 1 1 2" — the
   * same label three times, which says nothing about where you are on the
   * axis. A projection spanning ten years still wants whole numbers, so the
   * precision follows the span rather than being chosen once.
   */
  const xDecimals = $derived.by(() => {
    const span = xMax - xMin;
    if (span >= X_TICKS) return 0;
    if (span >= X_TICKS / 10) return 1;
    return 2;
  });

  const Y_TICKS = 5;
  const yTicks = $derived.by(() => {
    const ticks: number[] = [];
    for (let i = 0; i < Y_TICKS; i++) ticks.push(yLo + ((yHi - yLo) * i) / (Y_TICKS - 1));
    return ticks;
  });

  const nowPx = $derived(nowX >= xMin && nowX <= xMax ? px(nowX) : null);
</script>

<div class="chart-panel panel">
  <h2>{title}</h2>
  <!-- Each panel now shows a DIFFERENT thing — one projects the exact ratchet,
       the other replays what shares actually cost — so each carries its own
       current value rather than sharing one figure in the section header. -->
  {#if headline}
    <p class="headline">
      <strong class="mono gold">{headline}</strong>
      {#if headlineUnit}<span class="dim">{headlineUnit}</span>{/if}
    </p>
  {/if}
  {#if subtitle}<p class="subtitle dim">{subtitle}</p>{/if}
  <svg viewBox="0 0 {W} {H}" class="chart" role="img" aria-label="{title}: {subtitle ?? ''}">
    {#each yTicks as t (t)}
      <line x1={padL} x2={W - padR} y1={py(t)} y2={py(t)} class="grid" />
      <text x={padL - 8} y={py(t) + 3} class="tick y" text-anchor="end">{yFormat(t)}</text>
    {/each}
    {#each xTicks as t (t)}
      <line x1={px(t)} x2={px(t)} y1={padT} y2={padT + plotH} class="grid" />
      <text x={px(t)} y={H - 8} class="tick x" text-anchor="middle">{t.toFixed(xDecimals)}</text>
    {/each}

    <path d={areaPath} class="area" />

    {#if nowPx !== null}
      <line x1={nowPx} x2={nowPx} y1={padT} y2={padT + plotH} class="now-line" />
      <text x={nowPx} y={padT - 3} class="now-label" text-anchor="middle">now</text>
    {/if}

    <path d={linePath} class="curve" />
  </svg>
</div>

<style>
  .chart-panel { min-width: 0; }
  .subtitle { font-size: var(--t-tiny); margin: -0.5rem 0 0.7rem; line-height: 1.4; }
  .headline { margin: -0.35rem 0 0.15rem; font-size: 1.35rem; line-height: 1.2; }
  .headline span { font-size: var(--t-tiny); margin-left: 0.35rem; }
  .chart { width: 100%; height: auto; display: block; overflow: visible; }

  .grid { stroke: var(--line-soft); stroke-width: 1; }
  .area { fill: rgba(255, 210, 63, 0.08); stroke: none; }
  .curve { fill: none; stroke: var(--gold); stroke-width: 1.7; stroke-linejoin: round; }

  .now-line { stroke: var(--cyan); stroke-width: 1; stroke-dasharray: 3 3; }
  .now-label {
    fill: var(--cyan); font-family: var(--mono); font-size: 8px;
    letter-spacing: 0.08em; text-transform: uppercase;
  }

  .tick {
    fill: var(--dim); font-family: var(--mono); font-size: 8.5px;
    font-variant-numeric: tabular-nums;
  }
</style>

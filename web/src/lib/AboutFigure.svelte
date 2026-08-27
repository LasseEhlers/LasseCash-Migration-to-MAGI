<script lang="ts">
  /**
   * The three diagrams in the About document.
   *
   * WHY THEY LIVE HERE AND NOT IN THE MARKDOWN. docs/ABOUT.md is one text
   * rendered three ways — this page, `/about.md` for AI readers, and the
   * GitHub README — through the same escape-first renderer every post uses.
   * That renderer permits only absolute http(s) image URLs (safeUrl), on
   * purpose: post bodies are attacker-controlled and a relative or `javascript:`
   * src is an execution vector. Rather than weaken it for three pictures, the
   * markdown keeps a `[figure: …]` line that DESCRIBES the diagram — which is
   * what a text-only reader wants anyway — and the page swaps that line for the
   * drawing.
   *
   * Colour follows CLAUDE.md and is not decoration: gold is the protocol, dim
   * is time passing harmlessly, and RED appears only where value is actively
   * being lost — the bleed. Using red anywhere else would train people to
   * ignore it where it is real.
   */
  let { kind }: { kind: "emission" | "claim" | "mint" } = $props();

  /**
   * Cumulative emission, closed form. Each era halves, so after n eras the
   * total is 20M x (1 - 2^-n) — the curve approaches the cap and never
   * reaches it, which is the whole point of the schedule.
   */
  const ERAS = 25;
  const CAP = 20_000_000;
  const pts = Array.from({ length: ERAS + 1 }, (_, n) => ({
    year: n * 3,
    total: CAP * (1 - Math.pow(0.5, n)),
  }));
  const W = 640, H = 200, PAD = { l: 56, r: 16, t: 14, b: 28 };
  const px = (year: number) => PAD.l + (year / 75) * (W - PAD.l - PAD.r);
  const py = (total: number) => H - PAD.b - (total / CAP) * (H - PAD.t - PAD.b);
  const curve = pts.map((p, i) => `${i ? "L" : "M"}${px(p.year).toFixed(1)},${py(p.total).toFixed(1)}`).join(" ");
  const area = `${curve} L${px(75).toFixed(1)},${H - PAD.b} L${PAD.l},${H - PAD.b} Z`;
</script>

<figure class="fig">
  {#if kind === "emission"}
    <svg viewBox="0 0 {W} {H}" role="img"
         aria-label="Cumulative LASSECASH emission: 20,000,000 issued over 75 years, each three-year era half the previous one, approaching the cap without reaching it.">
      <!-- the cap: the line the curve never touches -->
      <line x1={PAD.l} y1={py(CAP)} x2={W - PAD.r} y2={py(CAP)} class="cap" />
      <text x={PAD.l} y={py(CAP) - 5} class="lbl gold">20,000,000 cap — never reached</text>
      <path d={area} class="area" />
      <path d={curve} class="curve" />
      {#each [0, 1, 2, 3] as n}
        <circle cx={px(pts[n + 1].year)} cy={py(pts[n + 1].total)} r="3" class="dot" />
      {/each}
      {#each [{ y: 0, t: "genesis" }, { y: 3, t: "yr 3" }, { y: 6, t: "yr 6" }, { y: 12, t: "yr 12" }, { y: 30, t: "yr 30" }, { y: 75, t: "yr 75" }] as m}
        <text x={px(m.y)} y={H - 10} class="lbl axis" text-anchor="middle">{m.t}</text>
      {/each}
      <text x={PAD.l - 8} y={py(CAP) + 4} class="lbl axis" text-anchor="end">20M</text>
      <text x={PAD.l - 8} y={py(CAP / 2) + 4} class="lbl axis" text-anchor="end">10M</text>
      <text x={PAD.l - 8} y={H - PAD.b + 4} class="lbl axis" text-anchor="end">0</text>
    </svg>
    <figcaption>
      Half of everything ever issued arrives in the first three years, and each
      era pays half the last. Emission stops in year 75.
    </figcaption>

  {:else if kind === "claim"}
    <svg viewBox="0 0 640 108" role="img"
         aria-label="The claim window: days 0 to 30 a real mint, days 30 to 120 grace, days 120 to 210 a bleed to zero, after 210 refused.">
      <!-- drawn TO SCALE: 30 / 90 / 90 are comparable, so honest proportions
           are more informative than equal boxes -->
      <rect x="8"    y="30" width="86"  height="30" class="seg mint" />
      <rect x="94"   y="30" width="258" height="30" class="seg grace" />
      <rect x="352"  y="30" width="258" height="30" class="seg bleed" />
      <text x="51"  y="50" class="in" text-anchor="middle">a real mint</text>
      <text x="223" y="50" class="in" text-anchor="middle">full amount, straight to liquid</text>
      <text x="481" y="50" class="in bleedtxt" text-anchor="middle">bleeds to zero</text>
      {#each [{ x: 8, t: "day 0" }, { x: 94, t: "30" }, { x: 352, t: "120" }, { x: 610, t: "210" }] as m}
        <line x1={m.x} y1="24" x2={m.x} y2="66" class="tick" />
        <text x={m.x} y="18" class="lbl axis" text-anchor={m.x < 20 ? "start" : m.x > 600 ? "end" : "middle"}>{m.t}</text>
      {/each}
      <text x="51"  y="82" class="lbl axis sub" text-anchor="middle">earns and votes</text>
      <text x="223" y="82" class="lbl axis sub" text-anchor="middle">no yield</text>
      <text x="481" y="82" class="lbl axis sub" text-anchor="middle">what is left, shrinking every block</text>
      <text x="610" y="100" class="lbl axis sub" text-anchor="end">after day 210 the claim is refused</text>
    </svg>
    <figcaption>
      Claim in the first 30 days and the staked half becomes a mint that earns
      and votes. After that it is only a race against the bleed.
    </figcaption>

  {:else}
    <svg viewBox="0 0 640 108" role="img"
         aria-label="The life of a mint: the lock, then maturity, then 90 days of grace, then a 90-day bleed, then zero.">
      <!-- FIXED widths, not to scale. A 1,095-day lock beside a 90-day bleed
           would squash the bleed into a sliver exactly where it matters most. -->
      <rect x="8"   y="30" width="240" height="30" class="seg lock" />
      <rect x="248" y="30" width="180" height="30" class="seg grace" />
      <rect x="428" y="30" width="182" height="30" class="seg bleed" />
      <text x="128" y="50" class="in" text-anchor="middle">locked — earning yield</text>
      <text x="338" y="50" class="in" text-anchor="middle">90-day grace</text>
      <text x="519" y="50" class="in bleedtxt" text-anchor="middle">90-day bleed</text>
      {#each [{ x: 8, t: "start" }, { x: 248, t: "maturity" }, { x: 428, t: "+90d" }, { x: 610, t: "+180d" }] as m}
        <line x1={m.x} y1="24" x2={m.x} y2="66" class="tick" />
        <text x={m.x} y="18" class="lbl axis" text-anchor={m.x < 20 ? "start" : m.x > 600 ? "end" : "middle"}>{m.t}</text>
      {/each}
      <text x="128" y="82" class="lbl axis sub" text-anchor="middle">1 to 1,095 days, your choice</text>
      <text x="338" y="82" class="lbl axis sub" text-anchor="middle">no yield · nothing lost</text>
      <text x="519" y="82" class="lbl axis sub" text-anchor="middle">100% → 0%, per block</text>
      <text x="610" y="100" class="lbl axis sub" text-anchor="end">worth nothing · sweepable by anyone</text>
    </svg>
    <figcaption>
      Not to scale: the lock can be twelve times the bleed, and drawing it
      honestly would hide the part that costs people money.
    </figcaption>
  {/if}
</figure>

<style>
  .fig { margin: 1.4rem 0; padding: 0; }
  svg { width: 100%; max-width: 760px; height: auto; display: block; }
  figcaption {
    margin-top: 0.5rem; font-size: 0.82rem; color: var(--dim); line-height: 1.5;
  }
  .cap { stroke: var(--gold); stroke-width: 1; stroke-dasharray: 4 4; opacity: 0.65; }
  .area { fill: var(--gold); opacity: 0.13; }
  .curve { fill: none; stroke: var(--gold); stroke-width: 2; }
  .dot { fill: var(--gold); }
  .lbl { font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lbl.axis { fill: var(--dim); }
  .lbl.gold { fill: var(--gold); }
  .tick { stroke: var(--line); stroke-width: 1; }
  .seg { rx: 3; }
  .seg.mint, .seg.lock { fill: var(--gold); opacity: 0.85; }
  .seg.grace { fill: var(--panel-2); stroke: var(--line); stroke-width: 1; }
  /* RED only here. This is the one place in the diagram where value is
     actively being lost, and CLAUDE.md reserves the colour for exactly that. */
  .seg.bleed { fill: var(--red); opacity: 0.28; stroke: var(--red); stroke-width: 1; }
  .in { font-size: 11px; font-weight: 600; fill: #0d1117; }
  text.in { fill: var(--ink); }
  .in.bleedtxt { fill: var(--red); }
  /* A phone scales the 640-unit viewBox to ~330px, halving every label; the
     old rule shrank them further. Enlarge instead and drop the sub-labels,
     whose content the caption and the prose already carry. */
  @media (max-width: 560px) { .lbl, .in { font-size: 14px; } .sub { display: none; } }
</style>

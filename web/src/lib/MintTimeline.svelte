<script lang="ts">
  /**
   * A mint's whole life, as one bar.
   *
   * The three phases have wildly different real durations — a lock can be 1095
   * days while the bleed is 90 — so the segments are drawn at FIXED widths
   * rather than to scale. Drawing to scale would squash the bleed into a sliver
   * exactly when it matters most. The marker is positioned proportionally
   * *within* its own phase, so it still tells the truth about where you are.
   */
  import { durationWords } from "$lib/format.js";
  import { constants } from "$api/index.js";
  import { chain } from "$lib/chain.svelte.js";
  import type { MintView } from "$api/index.js";

  let { mint, height }: { mint: MintView; height: number } = $props();

  const C = $derived(chain.ready ? constants() : null);
  const HEIGHTS_PER_DAY = 28_800;

  const graceDays = $derived(
    mint.good_accounting ? (C?.goodAcctGrace ?? 1095) : (C?.graceDays ?? 30),
  );
  const bleedDays = $derived(C?.bleedDays ?? 90);

  const maturity = $derived(mint.maturity_height);
  const graceEnd = $derived(maturity + graceDays * HEIGHTS_PER_DAY);
  const zeroAt = $derived(graceEnd + bleedDays * HEIGHTS_PER_DAY);

  /** Which phase the mint is in, and how far through it. */
  const pos = $derived.by(() => {
    if (height < maturity) {
      const span = maturity - mint.start_height;
      const frac = span > 0 ? (height - mint.start_height) / span : 0;
      return { phase: "lock" as const, frac: Math.max(0, Math.min(1, frac)) };
    }
    if (height <= graceEnd) {
      const span = graceEnd - maturity;
      const frac = span > 0 ? (height - maturity) / span : 0;
      return { phase: "grace" as const, frac: Math.min(1, frac) };
    }
    const span = zeroAt - graceEnd;
    const frac = span > 0 ? (height - graceEnd) / span : 1;
    return { phase: "bleed" as const, frac: Math.min(1, frac) };
  });

  /** Fixed segment widths (%). Lock dominates but the bleed stays legible. */
  const W = { lock: 52, grace: 16, bleed: 32 };

  const markerLeft = $derived.by(() => {
    if (pos.phase === "lock") return pos.frac * W.lock;
    if (pos.phase === "grace") return W.lock + pos.frac * W.grace;
    return W.lock + W.grace + pos.frac * W.bleed;
  });

  const liquidated = $derived(height >= zeroAt);
  const label = $derived.by(() => {
    if (liquidated) return "liquidated — nothing left";
    if (pos.phase === "lock") return `${durationWords(maturity - height)} to maturity`;
    if (pos.phase === "grace") return `safe for ${durationWords(graceEnd - height)}`;
    return `bleeding — zero in ${durationWords(zeroAt - height)}`;
  });
</script>

<div class="tl" class:danger={pos.phase === "bleed" && !liquidated} class:dead={liquidated}>
  <div class="track">
    <div class="seg lock" style="width:{W.lock}%">
      <span>locked</span>
    </div>
    <div class="seg grace" style="width:{W.grace}%">
      <span>{mint.good_accounting ? "3y grace" : "grace"}</span>
    </div>
    <div class="seg bleed" style="width:{W.bleed}%">
      <span>bleed</span>
    </div>
    {#if !liquidated}
      <div class="marker" style="left:{markerLeft}%" aria-hidden="true"></div>
    {/if}
  </div>

  <div class="labels">
    <span class="dim">start</span>
    <span class="mid" class:now={pos.phase !== "lock"}>maturity</span>
    <span class="dim">zero</span>
  </div>

  <p class="state">{label}</p>
</div>

<style>
  .tl { --h: 22px; }
  .track {
    position: relative; display: flex; height: var(--h);
    border-radius: 5px; overflow: hidden; background: #0d1117;
    border: 1px solid var(--line);
  }
  .seg {
    display: grid; place-items: center; min-width: 0;
    font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: #0e131b; font-weight: 700;
  }
  .seg span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 0.2rem; }
  .seg.lock { background: linear-gradient(90deg, #3a4a63, #4d9fff); color: #eaf2ff; }
  .seg.grace { background: #2f4a3c; color: #bfe8d2; }
  .seg.bleed { background: linear-gradient(90deg, #6a2226, #ff5c5c); color: #fff0f0; }

  .marker {
    position: absolute; top: -4px; bottom: -4px; width: 2px;
    background: var(--gold); border-radius: 1px;
    box-shadow: 0 0 0 2px rgba(7, 9, 13, 0.9), 0 0 10px rgba(255, 210, 63, 0.7);
  }
  /* A head on the marker so it reads as a position, not a divider. */
  .marker::after {
    content: ""; position: absolute; left: 50%; top: -4px;
    width: 7px; height: 7px; margin-left: -3.5px;
    background: var(--gold); transform: rotate(45deg);
    box-shadow: 0 0 8px rgba(255, 210, 63, 0.8);
  }
  .tl.danger .marker { background: #fff; }

  .labels {
    display: flex; justify-content: space-between;
    font-size: 0.64rem; letter-spacing: 0.06em; text-transform: uppercase;
    margin-top: 0.3rem;
  }
  .labels .mid { color: var(--dim); }
  .labels .mid.now { color: var(--amber); font-weight: 700; }

  .state { margin: 0.35rem 0 0; font-size: 0.78rem; color: var(--dim); }
  .tl.danger .state { color: var(--red); font-weight: 600; }
  .tl.dead { opacity: 0.5; }
</style>

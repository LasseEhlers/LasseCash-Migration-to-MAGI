<script lang="ts">
  /**
   * A coin's mark, drawn inline.
   *
   * WHY THE COINS KEEP THEIR OWN COLOURS. Everything else on this site is
   * black and gold, and this is the one deliberate exception: a logo works by
   * being recognised, and a gold Bitcoin is not Bitcoin. So the chrome around
   * these is ours and the marks are theirs — which is also the honest signal,
   * since HIVE, HBD and BTC are not our assets.
   *
   * Drawn rather than fetched: an external image would be a request we cannot
   * make on a page that must work offline-ish and instantly, and a sprite
   * sheet for five glyphs is not worth a build step.
   */
  let { asset, size = 22 }: { asset: string; size?: number } = $props();

  const A = $derived(asset.toUpperCase());
  const ring = $derived(
    A === "BTC" ? "#f7931a" :
    A === "HIVE" ? "#e31337" :
    A === "HBD" ? "#37b06f" :
    A === "ETH" ? "#8a92b2" :
    "var(--gold)",
  );
</script>

<span class="coin" style="--ring:{ring}; width:{size}px; height:{size}px; font-size:{size * 0.52}px">
  {#if A === "BTC"}₿
  {:else if A === "ETH"}Ξ
  {:else if A === "HIVE"}H
  {:else if A === "HBD"}$
  {:else}L{/if}
</span>

<style>
  .coin {
    display: inline-grid; place-items: center; flex: none;
    border: 1.5px solid var(--ring); border-radius: 50%;
    color: var(--ring); font-family: var(--mono); font-weight: 800;
    line-height: 1; background: #0b0f16;
  }
</style>

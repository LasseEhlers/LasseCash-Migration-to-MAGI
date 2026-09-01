<script lang="ts">
  /**
   * A coin's own mark.
   *
   * THESE ARE THE ASSETS' BRAND LOGOS, not ours: Bitcoin's is public domain,
   * Hive's and HBD's are published by Hive for ecosystem use. Everything else
   * on this site is black and gold; these are the one deliberate exception,
   * because a logo works by being recognised and a gold Bitcoin is not
   * Bitcoin. It is also the honest signal — HIVE, HBD and BTC are not our
   * assets, and they should not wear our colours.
   *
   * LASSECASH and ETH fall back to a drawn mark: ours because the brand is
   * the gold L, ETH because we do not carry an ETH balance yet.
   */
  let { asset, size = 22 }: { asset: string; size?: number } = $props();

  const A = $derived(asset.toUpperCase());
  const file = $derived(
    A === "BTC" ? "/coins/btc.svg" :
    A === "HIVE" ? "/coins/hive.svg" :
    A === "HBD" ? "/coins/hbd.svg" :
    null,
  );
</script>

{#if file}
  <img class="coin" src={file} alt="" width={size} height={size} loading="lazy" />
{:else}
  <span
    class="coin glyph"
    style="--ring:{A === 'ETH' ? '#8a92b2' : 'var(--gold)'}; width:{size}px; height:{size}px; font-size:{size * 0.52}px"
  >{A === "ETH" ? "Ξ" : "L"}</span>
{/if}

<style>
  .coin { display: block; flex: none; border-radius: 50%; }
  .glyph {
    display: inline-grid; place-items: center;
    border: 1.5px solid var(--ring); color: var(--ring);
    font-family: var(--mono); font-weight: 800; line-height: 1; background: #0b0f16;
  }
</style>

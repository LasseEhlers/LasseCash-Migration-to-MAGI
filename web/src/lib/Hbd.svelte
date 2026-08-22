<script lang="ts">
  /**
   * The dim "≈ 3.52 HBD" that sits beside a LASSECASH figure.
   *
   * Renders NOTHING when there is no honest answer — the reader turned the
   * preference off, the engine has not loaded, or the pool is unseeded and
   * therefore has no price. A zero here would read as "worthless".
   *
   * Deliberately quiet: LASSECASH is the unit of account on this site, and the
   * dollar figure is a sanity check beside it, not a competing headline. No
   * glow, no gold, one size down.
   */
  import { hbdValue } from "$lib/hbd.svelte.js";
  import { lc } from "$lib/format.js";
  import type { Amount } from "$api/index.js";

  let {
    amount,
    decimals = 3,
    block = false,
  }: {
    amount: Amount | null | undefined;
    /** HBD is a dollar, so three decimals is a tenth of a cent. */
    decimals?: number;
    /** Render on its own line rather than inline. */
    block?: boolean;
  } = $props();

  const value = $derived(hbdValue(amount));
</script>

{#if value !== null}
  <span
    class="hbd mono"
    class:block
    title="Estimate at the LASSECASH:HBD pool's current price. The reserves move every block."
  >≈ {lc(value, decimals)} HBD</span>
{/if}

<style>
  .hbd {
    color: var(--dimmer);
    font-size: var(--t-micro);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .hbd.block { display: block; }
</style>

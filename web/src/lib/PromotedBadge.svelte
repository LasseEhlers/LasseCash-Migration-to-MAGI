<script lang="ts">
  /**
   * "PROMOTED — X LASSECASH burned".
   *
   * One component so the feed card and the post page make the SAME claim in the
   * same words. The point of promotion here, unlike Steem's, is that the cost
   * is public and irreversible — so the badge names the amount rather than just
   * saying "promoted", and it never appears for a post nobody paid for.
   */
  import { lc } from "$lib/format.js";
  import { isPositive, type Amount } from "$api/index.js";

  let { promoted, slot = false }: {
    promoted: Amount | undefined;
    /** True when this row is occupying a promoted SLOT in Trending. */
    slot?: boolean;
  } = $props();
</script>

{#if promoted && isPositive(promoted)}
  <span
    class="promoted mono"
    class:slot
    title="LASSECASH burned to @null to buy this post a labelled slot in Trending. Burned means destroyed — it is visible on-chain forever."
  >{slot ? "PROMOTED · " : "Promoted — "}<b>{lc(promoted, 0)}</b> LASSECASH burned</span>
{/if}

<style>
  .promoted {
    display: inline-flex; align-items: center; gap: 0.3rem;
    font-size: var(--t-micro); letter-spacing: 0.08em; font-weight: 700;
    color: var(--amber); background: rgba(255, 165, 63, 0.1);
    border: 1px solid rgba(255, 165, 63, 0.35);
    border-radius: var(--r-sm); padding: 0.12rem 0.45rem;
    text-transform: uppercase;
  }
  /* In the feed's slot the label is the row's explanation, so it carries more
     weight than the same fact shown on the post page. */
  .promoted.slot { letter-spacing: 0.12em; }
  .promoted b { font-weight: 800; }
</style>

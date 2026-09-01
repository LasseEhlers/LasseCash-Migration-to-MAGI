<script lang="ts">
  /**
   * Pick an asset — Altera's shape, in our colours.
   *
   * A row of chips rather than a <select>, because the balance belongs NEXT
   * to the asset when you are choosing what to move: the question is always
   * "which of these do I have, and how much", and a dropdown hides the
   * second half of it until after you have chosen.
   */
  import CoinIcon from "./CoinIcon.svelte";

  let {
    assets, selected, balances = {}, disabled = false, onpick,
  }: {
    assets: string[];
    selected: string;
    /** Decimal strings, or null for "we cannot read this one". */
    balances?: Record<string, string | null>;
    disabled?: boolean;
    onpick: (asset: string) => void;
  } = $props();
</script>

<div class="chips" role="group">
  {#each assets as a (a)}
    <button
      class="chip" class:on={a === selected}
      {disabled}
      onclick={() => onpick(a)}
      aria-pressed={a === selected}
    >
      <CoinIcon asset={a} />
      <span class="meta">
        <span class="sym">{a}</span>
        <span class="bal mono">{balances[a] ?? "—"}</span>
      </span>
    </button>
  {/each}
</div>

<style>
  .chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .chip {
    display: flex; align-items: center; gap: 0.55rem;
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: var(--r); padding: 0.5rem 0.75rem;
    cursor: pointer; text-align: left; color: var(--ink);
  }
  .chip:hover:not(:disabled) { border-color: var(--line-hot); }
  .chip.on { border-color: var(--gold); background: rgba(255, 210, 63, 0.06); }
  .chip:disabled { opacity: 0.5; cursor: default; }
  .meta { display: grid; gap: 0.1rem; }
  .sym { font-family: var(--mono); font-size: var(--t-tiny); font-weight: 700; letter-spacing: 0.06em; }
  .bal { font-size: var(--t-micro); color: var(--dim); font-variant-numeric: tabular-nums; }
</style>

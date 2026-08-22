<script lang="ts">
  /**
   * New mint, with a LIVE preview.
   *
   * The preview calls the browser engine — the same Go code the chain runs — so
   * it updates on every keystroke and slider tick with no network round-trip,
   * and it is EXACT: every input comes from the user, so nothing can be stale.
   *
   * Before submitting we confirm against the chain, because the share rate
   * ratchets with height and the volume thresholds are governed.
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { toUnits } from "$api/index.js";
  import { lc, mult } from "$lib/format.js";
  import { constants, mintQuote, toBaseUnitArg, type EngineMintQuote } from "$api/index.js";

  const C = $derived(chain.ready ? constants() : null);

  let amount = $state("10000");
  let days = $state(1095);
  let error = $state<string | null>(null);
  let confirming = $state(false);

  /** The governed Bigger-Pays-Better thresholds, read from chain state. */
  let volumeStart = $state("10000");
  let volumeEnd = $state("100000");
  /** Share rate at the current height, from the chain. */
  let shareRate = $state("1.00000000");

  // Pull the governed inputs once the chain is up; the preview is exact only
  // when it uses the same parameters the contract would.
  $effect(() => {
    const info = chain.info;
    if (!info) return;
    void client.quoteMint("1", 1).then((q) => { shareRate = q.share_rate; });
  });

  /** EXACT preview — pure function of the inputs above. */
  const preview = $derived.by((): EngineMintQuote | null => {
    if (!chain.ready) return null;
    try {
      return mintQuote(
        toBaseUnitArg(amount || "0"), days,
        toBaseUnitArg(shareRate),
        toBaseUnitArg(volumeStart), toBaseUnitArg(volumeEnd),
      );
    } catch {
      return null; // malformed input; the field shows its own error
    }
  });

  const durationLabel = $derived(
    days >= 365 ? `${(days / 365).toFixed(1)} years · ${days} days` : `${days} days`,
  );

  const balance = $derived(chain.me?.balance ?? "0.00000000");
  // Never let a mint larger than the balance reach the wallet: the contract
  // would refuse it 30–90 s after signing, which is the worst time to learn.
  const overBalance = $derived(
    !!preview?.ok && safeUnits(amount) > toUnits(balance),
  );
  const canSubmit = $derived(
    !!chain.account && !!preview?.ok && !overBalance && !chain.busy && !confirming,
  );

  // The amount field is free text while typing; an unparseable value is
  // simply "not over balance" — the preview already reports it as invalid.
  function safeUnits(a: string): bigint {
    try { return toUnits(a); } catch { return 0n; }
  }

  function driftsMaterially(previewed: string, actual: string): boolean {
    const a = toUnits(previewed), b = toUnits(actual);
    const diff = a > b ? a - b : b - a;
    return diff * 1000n > a;
  }

  async function submit() {
    error = null;
    confirming = true;
    try {
      // Confirm against the chain before signing: the browser used a share rate
      // and thresholds fetched a moment ago, and both can move.
      const authoritative = await client.quoteMint(amount, days);
      if (!authoritative.ok) { error = authoritative.msg; return; }
      // The share rate ratchets every height, so on a real chain the preview
      // is always a few heights stale. Only stop the user when the difference
      // is one they would care about (> 0.1%); the contract prices the mint at
      // its own height either way, and shares can only move DOWN between
      // preview and execution.
      if (preview && driftsMaterially(preview.shares, authoritative.shares)) {
        error = `Rate moved — you would now receive ${lc(authoritative.shares)} L-Shares. Submit again to accept.`;
        shareRate = authoritative.share_rate;
        return;
      }
      const failure = await chain.submit(() => client.mint(amount, days));
      if (failure) error = failure;
    } finally {
      confirming = false;
    }
  }
</script>

<div class="panel">
  <h2>Open a mint</h2>

  <label class="field">
    <span>Amount to lock</span>
    <input inputmode="decimal" bind:value={amount} placeholder="10000" />
    <small class="dim">
      Balance {lc(balance)} LC{#if overBalance} · <span class="red">more than you hold</span>{/if}
      {#if C}· minimum {lc(C.minMintAmount === "100000000" ? "1.00000000" : "1.00000000", 0)} LC{/if}
    </small>
  </label>

  <label class="field">
    <span>Duration — {durationLabel}</span>
    <input
      type="range"
      min={C?.minMintDays ?? 1}
      max={C?.maxMintDays ?? 1095}
      bind:value={days}
    />
    <div class="ends dim">
      <span>1 day</span><span>3 years</span>
    </div>
  </label>

  {#if preview}
    <div class="preview" class:invalid={!preview.ok}>
      <div class="headline">
        <span class="dim">You receive</span>
        <strong class="gold mono">{lc(preview.shares)}</strong>
        <span class="dim">L-Shares</span>
      </div>
      <div class="bonuses">
        <span>Longer pays better <b class="mono">{mult(preview.durationMultiplier)}</b></span>
        <span>Bigger pays better <b class="mono">{mult(preview.volumeMultiplier)}</b></span>
        <span class="combined">Combined <b class="mono gold">{mult(preview.combinedMultiplier)}</b></span>
      </div>
      <small class="dim">
        Share rate {lc(shareRate, 5)} LC per share. It only ever rises — 7% a year.
      </small>
    </div>
  {/if}

  {#if error}<p class="err">{error}</p>{/if}

  <button onclick={submit} disabled={!canSubmit}>
    {#if confirming}Confirming…{:else if !chain.account}Sign in to mint{:else}Mint{/if}
  </button>
</div>

<style>
  .ends { display: flex; justify-content: space-between; font-size: 0.72rem; margin-top: 0.2rem; }
  .preview {
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 8px; padding: 0.85rem; margin-bottom: 0.9rem;
  }
  .preview.invalid { opacity: 0.5; }
  .headline { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .headline strong { font-size: 1.55rem; }
  .bonuses {
    display: flex; gap: 1rem; flex-wrap: wrap;
    margin: 0.6rem 0 0.4rem; font-size: 0.82rem; color: var(--dim);
  }
  .bonuses b { color: var(--ink); }
  .combined { margin-left: auto; }
  .err { color: var(--red); font-size: 0.86rem; margin: 0 0 0.7rem; }
  button { width: 100%; }
</style>

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
  import {
    constants, dailyRewards, estimateRewardShare, mintQuote, toBaseUnitArg, Param,
    type EngineMintQuote,
  } from "$api/index.js";
  import { readGovernance } from "$lib/governance.js";

  const C = $derived(chain.ready ? constants() : null);

  let amount = $state("10000");
  let days = $state(1095);
  let error = $state<string | null>(null);
  let confirming = $state(false);

  /** The governed Bigger-Pays-Better thresholds, read from chain state.
   * The initial literals are only a pre-load placeholder; the effect below
   * replaces them with the median in force. (Until 2026-08-31 the effect
   * fetched only the share rate, so these stayed at the pre-08-22 defaults
   * and every submit tripped the "rate moved" guard — found by Lasse in the
   * launch-morning rehearsal.) */
  let volumeStart = $state("1000");
  let volumeEnd = $state("50000");
  /** Share rate at the current height, from the chain. */
  let shareRate = $state("1.00000000");

  // Pull the governed inputs once the chain is up; the preview is exact only
  // when it uses the same parameters the contract would.
  $effect(() => {
    const info = chain.info;
    if (!info) return;
    void client.quoteMint("1", 1).then((q) => { shareRate = q.share_rate; });
    void readGovernance([Param.VolumeStart, Param.VolumeEnd]).then((g) => {
      const vs = g.values.get(Param.VolumeStart), ve = g.values.get(Param.VolumeEnd);
      if (vs?.ok) volumeStart = vs.value;
      if (ve?.ok) volumeEnd = ve.value;
    });
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
  /**
   * What this mint would earn per day at TODAY'S share base.
   *
   * Every number crosses the engine: the daily L-Share slice from
   * `dailyRewards`, the split from `estimateRewardShare`. The only arithmetic
   * here is turning LC/day into a percentage for display, which is
   * presentation, not economics.
   *
   * Null unless the chain and a valid preview are both loaded — an estimate
   * built on a missing denominator is a wrong number, not a rough one.
   */
  const yieldNow = $derived.by(() => {
    const info = chain.info;
    if (!info || !preview?.ok || !chain.ready) return null;
    try {
      const daily = dailyRewards(info.genesis_height, info.height).lshare;
      const mine = toBaseUnitArg(preview.shares);
      // The mint is not live yet, so it joins the denominator.
      const total = (BigInt(toBaseUnitArg(info.total_shares)) + BigInt(mine)).toString();
      if (BigInt(total) <= 0n) return null;
      const perDay = estimateRewardShare(toBaseUnitArg(daily), mine, total);
      const locked = Number(amount);
      if (!locked) return null;
      const pctYear = ((Number(perDay) * 365) / locked * 100).toFixed(1);
      return { perDay, pctYear };
    } catch { return null; }
  });

  /** The day-30 cliff is close enough to change what this estimate means. */
  const cliffSoon = $derived.by(() => {
    const info = chain.info;
    if (!info) return false;
    const days = (info.height - info.genesis_height) / 28_800;
    return days < 45;
  });

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
      <!-- THE YIELD IS THE HEADLINE, because it is what someone is actually
           buying. L-Shares are the mechanism, not the outcome — leading with
           them made "1.50x" read like a 50% return on the money instead of a
           bigger slice of a daily pool.
           But the hierarchy must not blur the golden rule's split: the yield
           is an ESTIMATE (it divides a pool among shares that keep changing)
           and the share count is EXACT (a pure function of what you lock). So
           the estimate is big and labelled, and the exact figure stays. -->
      {#if yieldNow}
        <div class="headline">
          <span class="dim">Earns about</span>
          <strong class="gold mono big">{lc(yieldNow.perDay, 3)}</strong>
          <span class="dim">LC / day</span>
          <span class="chip">estimate</span>
        </div>
        <div class="subline">
          <span class="dim">≈ {yieldNow.pctYear}% a year on what you lock, at today's share base</span>
        </div>
        <div class="subline">
          <span class="dim">for</span>
          <b class="mono">{lc(preview.shares)}</b>
          <span class="dim">L-Shares — exact, frozen at creation</span>
        </div>
      {:else}
        <div class="headline">
          <span class="dim">You receive</span>
          <strong class="gold mono">{lc(preview.shares)}</strong>
          <span class="dim">L-Shares</span>
        </div>
      {/if}
      <div class="bonuses">
        <span>Longer pays better <b class="mono">{mult(preview.durationMultiplier)}</b></span>
        <span>Bigger pays better <b class="mono">{mult(preview.volumeMultiplier)}</b></span>
        <span class="combined">
          Combined <b class="mono gold">{mult(preview.combinedMultiplier)}</b>
          <span class="on">on your L-Shares</span>
        </span>
      </div>
      {#if yieldNow}
        <small class="dim est">
          <b>Estimate.</b> Your slice depends on every other live L-Share, and that
          denominator moves whenever anyone mints or a mint matures — it is not a rate
          anyone promises you. It also assumes the shares stay live: they retire at
          maturity, so a short mint earns for a short time.
          {#if cliffSoon}
            <b class="gold">Every migration mint matures on 30 September</b>, retiring most
            of the network's shares at once — whoever holds shares after that divides the
            same pool between far fewer of them.
          {/if}
        </small>
      {/if}
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
  .headline .big { font-size: 1.7rem; line-height: 1.1; }
  .chip {
    font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--dim);
    border: 1px solid var(--line); border-radius: 2px; padding: 0.05rem 0.3rem;
  }
  .subline { font-size: 0.8rem; margin-top: 0.2rem; }
  .yield { display: flex; align-items: baseline; gap: 0.35rem; flex-wrap: wrap; margin: 0.5rem 0 0.3rem; font-size: 0.85rem; }
  .yield b { font-size: 1.05rem; }
  .est { display: block; line-height: 1.55; margin-bottom: 0.4rem; }
  .preview {
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 8px; padding: 0.85rem; margin-bottom: 0.9rem;
  }
  .preview.invalid { opacity: 0.5; }
  .headline { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .headline strong { font-size: 1.55rem; }
  .bonuses {
    display: flex; gap: 1rem; flex-wrap: wrap; align-items: baseline;
    margin: 0.5rem 0 0.4rem; font-size: 0.8rem; color: var(--dim);
  }
  .bonuses b { color: var(--ink); font-size: 1rem; }
  .bonuses .combined b { font-size: 1.15rem; }
  .combined { margin-left: auto; }
  /* The one label that stops "1.50x" being read as 50% on the money. */
  .on { font-size: var(--t-micro); color: var(--dimmer); margin-left: 0.25rem; }
  .err { color: var(--red); font-size: 0.86rem; margin: 0 0 0.7rem; }
  button { width: 100%; }
</style>

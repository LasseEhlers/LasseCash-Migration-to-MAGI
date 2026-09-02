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
  import Hbd from "$lib/Hbd.svelte";
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

      // WHY the rate is what it is, from the chain rather than from a date.
      // "few have claimed yet" was true this week and would have quietly
      // stopped being true — most sharply on 30 September, when every
      // migration mint matures at once and the denominator collapses before
      // anyone re-mints. Participation is the thing that actually drives the
      // number, so participation is what the sentence reads.
      const claimable = Number(info.snapshot_total) - Number(info.snapshot_burned);
      const lockedNet = Number(info.total_shares);
      const share = claimable > 0 ? lockedNet / claimable : 0;
      const why =
        share < 0.25 ? "high because little of the supply is minted yet"
        : share < 0.6 ? "as much of the supply is minted, this keeps falling"
        : "most of the supply is minted, so this is near its floor";
      return { perDay, pctYear, why };
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
        <!-- The HBD line, through the SAME component and the same toggle as
             every other figure on this page. HBD is Hive's dollar, so this is
             the dollar value — writing "$" as well would be two units for one
             number. It respects the footer switch, so anyone who finds it
             noisy turns it off once and it stays off. -->
        <!-- The translation, not the figure. What the contract pays is the
             LASSECASH above; this is that number at today's pool price, and
             the price is the part that moves. -->
        <div class="hbdline"><Hbd amount={yieldNow.perDay} /> <span class="dim">per day</span></div>
        <!-- THE ACTION SITS UNDER THE NUMBER IT IS ABOUT, and above everything
             that explains it. The explanation below is good and honest, and it
             was four paragraphs tall — on a 1080p screen the Mint button was
             off the bottom of the page, so the primary action of the page was
             something you had to go looking for.
             Shrinking the prose would have punished the person who reads it to
             help the person who does not. Moving the button serves both: the
             figure they came for, then the button, then the detail for anyone
             who scrolls. -->
        <!-- THE PERCENTAGE IS THE MOST MISREADABLE FIGURE ON THE PAGE, so it
             carries its own caveat rather than borrowing the one below.
             The L-Share slice is FIXED — 833,333 LC a year in era 1 — so the
             rate is just that pool divided by the LASSECASH locked in mints.
             It is high today because few have claimed, and it falls toward
             about 7% as participation approaches the whole supply, halving
             again each era. Multipliers redistribute between minters; they
             cannot raise the aggregate.
             Saying that here costs nothing. Not saying it means every minter
             who locked for three years on today's number discovers it in year
             two, which is the expensive version. -->
      {/if}
    </div>
  {/if}

  <!-- THE ACTION SITS UNDER THE NUMBER IT IS ABOUT, and above everything that
       explains it. The explanation below is good and it was four paragraphs
       tall: on a 1080p screen the Mint button fell off the bottom, so the
       primary action of the page was something you had to go looking for.
       Shrinking the prose would punish the person who reads it to help the
       person who does not — moving the button serves both.
       It stays OUTSIDE the conditionals: with no preview, or signed out, the
       label is the thing worth showing. -->
  {#if error}<p class="err">{error}</p>{/if}
  <button onclick={submit} disabled={!canSubmit}>
    {#if confirming}Confirming…{:else if !chain.account}Sign in to mint{:else}Mint{/if}
  </button>

  {#if preview}
    <div class="preview detail" class:invalid={!preview.ok}>
      {#if yieldNow}
        <div class="subline">
          <span class="dim">≈</span>
          <b class="mono rate">{yieldNow.pctYear}%</b>
          <span class="dim">a year at today's share base —</span>
          <span class="falls">{yieldNow.why}</span>
        </div>
        <div class="subline">
          <span class="dim">
            Paid in LASSECASH, and the rate <b>falls as more people mint</b>.
            <a href="/about/full#4-mint--lassemint-and-l-shares">Why →</a>
          </span>
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
      <!-- Label left, number right. These are figures a reader COMPARES — is
           the duration bonus or the size bonus doing the work — and a column
           of right-aligned tabular digits is the only layout that lets them
           be compared at a glance. Inline values put each number at a
           different x position, which is what made this read as clutter. -->
      <dl class="bonuses">
        <div class="brow">
          <dt>Longer pays better</dt>
          <dd class="mono">{mult(preview.durationMultiplier)}</dd>
        </div>
        <div class="brow">
          <dt>Bigger pays better</dt>
          <dd class="mono">{mult(preview.volumeMultiplier)}</dd>
        </div>
        <div class="brow combined">
          <dt>Combined<small>on your L-Shares</small></dt>
          <dd class="mono gold">{mult(preview.combinedMultiplier)}</dd>
        </div>
      </dl>
      {#if yieldNow}
        <small class="dim est">
          <b>Estimate.</b> Your slice depends on every other live L-Share, and that
          denominator moves whenever anyone mints or a mint matures — it is not a rate
          anyone promises you. Shares retire at maturity, so a short mint earns for a
          short time.
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
  .hbdline { display: flex; align-items: baseline; gap: 0.35rem; margin-top: 0.25rem; }
  /* Left at the component's own size. It is a caption beside a LASSECASH
     figure on every other page, and emphasis only means something while it is
     scarce — a headline here would compete with the number it translates,
     which is backwards when LASSECASH is the unit of account. */
  .hbdline .dim { font-size: 0.78rem; }
  .rate { color: var(--ink); font-size: 0.95rem; }
  /* Not red: nothing is being lost. A rate that falls with success is the
     design working, not a warning. */
  .falls { color: var(--gold-dim); }
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
  /* The second half of the preview: everything that EXPLAINS the figure,
     below the button rather than between it and the number. */
  .preview.detail { margin-top: 0.9rem; }
  .bonuses { margin: 0.6rem 0 0.5rem; display: grid; gap: 0.3rem; }
  .brow {
    display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
    font-size: 0.8rem; color: var(--dim);
  }
  .brow dt { display: flex; flex-direction: column; }
  .brow dt small { font-size: var(--t-micro); color: var(--dimmer); }
  .brow dd { margin: 0; color: var(--ink); font-size: 1rem; font-variant-numeric: tabular-nums; }
  .brow.combined { border-top: 1px solid var(--line-soft); padding-top: 0.4rem; margin-top: 0.1rem; }
  .brow.combined dd { font-size: 1.2rem; }
  .err { color: var(--red); font-size: 0.86rem; margin: 0 0 0.7rem; }
  button { width: 100%; }
</style>

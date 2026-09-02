<script lang="ts">
  /**
   * LASSECASH:HBD pool.
   *
   * The swap figure runs the browser engine against last-fetched reserves — an
   * ESTIMATE, because reserves move between preview and broadcast. That is why
   * every submit carries a minOut: the user states the worst price they accept,
   * so a trade cannot be sandwiched into a far worse one.
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { fractionPct, lc, lcShort, mult, pct } from "$lib/format.js";
  import {
    estimateSwap, estimateLiquidity, toBaseUnitArg, toUnits, fromUnits, isZero,
    trancheHealth, dailyRewards, poolApy as poolApy_, type SwapDirection, type TrancheView,
  } from "$api/index.js";
  import Seo from "$lib/Seo.svelte";
  import Hbd from "$lib/Hbd.svelte";
  import TrancheHealth from "$lib/TrancheHealth.svelte";
  import { SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";

  let direction = $state<SwapDirection>("lc_hbd");
  let amountIn = $state("1000");
  let slippagePct = $state(1);
  let swapError = $state<string | null>(null);
  let lpError = $state<string | null>(null);

  const info = $derived(chain.info);
  const me = $derived(chain.me);
  const tranches = $derived((me?.tranches ?? []).filter((t) => !t.closed));

  /**
   * The dormancy clock for each open tranche. EXACT: a pure function of the
   * tranche's own last-touch height and the current chain height, run through
   * the browser engine — never re-derived here. Falls back to the tranche's
   * own last-touch height (phase 0, "just now") while the chain height has not
   * loaded yet, rather than guessing at a phase.
   */
  const healthOf = (t: TrancheView) =>
    trancheHealth(t.last_touch, info?.height ?? t.last_touch);
  const sellingLC = $derived(direction === "lc_hbd");
  const inSymbol = $derived(sellingLC ? "LASSECASH" : "HBD");
  const outSymbol = $derived(sellingLC ? "HBD" : "LASSECASH");

  /** Whether the pool already has reserves. Empty means this is the FIRST deposit. */
  const poolReady = $derived(!!info && !isZero(info.amm_lc) && !isZero(info.amm_hbd));

  /** ESTIMATE — reserves move between here and broadcast. */
  const quote = $derived.by(() => {
    if (!chain.ready || !info || !poolReady) return null;
    try {
      const resIn = sellingLC ? info.amm_lc : info.amm_hbd;
      const resOut = sellingLC ? info.amm_hbd : info.amm_lc;
      return estimateSwap(toBaseUnitArg(resIn), toBaseUnitArg(resOut),
        toBaseUnitArg(amountIn || "0"));
    } catch { return null; }
  });

  /** The floor we submit, from the user's slippage tolerance. */
  const minOut = $derived.by(() => {
    if (!quote?.ok) return "0";
    return (Number(quote.amountOut) * (1 - slippagePct / 100)).toFixed(8);
  });
  /**
   * HBD moves in 0.001 steps on MAGI (milli-units). A sell whose output is
   * below one milli cannot be paid; the contract refuses it atomically with
   * an opaque "HBD transfer failed". Say why BEFORE the wallet opens.
   * (Found in the launch-morning rehearsal, 2026-08-31, on a dust pool.)
   */
  const outBelowHbdStep = $derived(
    direction === "lc_hbd" && !!quote?.ok && Number(quote.amountOut) < 0.001,
  );

  /** 1 LASSECASH = M HBD — the same figure the header "Price" tile shows. */
  const spot = $derived(
    info && poolReady
      ? (Number(info.amm_hbd) / Number(info.amm_lc)).toFixed(8)
      : null,
  );

  /**
   * Pool APY for a deposit made right now, at 1.00x loyalty, before any bonus
   * — the honest number, not one inflated by blending in already-loyal
   * tranches sharing the same pool at up to 1.9x weight.
   *
   * The caption says "at 1.00x loyalty" and not "day one", which Lasse read
   * as the CHAIN's first day (2026-09-01). It is the DEPOSIT's first day, and
   * a phrase that has to be explained is a phrase that is wrong: the
   * multiplier says the same thing and cannot be read as a date.
   *
   * ESTIMATE, computed by `engine.PoolAPY` (the formula lives in Go, never
   * here): exact emission numerator, live reserves/weight denominator — the
   * same status every other figure on this page already carries.
   */
  const poolApy = $derived.by(() => {
    if (!chain.ready || !info || !poolReady) return null;
    const daily = dailyRewards(info.genesis_height, info.height).liquidity;
    return poolApy_(daily, info.amm_lc, info.amm_shares, info.amm_weight);
  });

  // --- Provide liquidity: two linked asset rows, Tribaldex-style -----------
  //
  // Reserves fix the deposit RATIO — adding liquidity is not a swap, it must
  // match the pool's current price or the contract rejects it — so hbdNeeded
  // is a straight (monotonic) function of lcIn. The engine only exposes that
  // one direction (estimateLiquidity: lc -> hbd). Rather than inverting the
  // ratio by hand in TypeScript, which is exactly the formula the golden rule
  // forbids, the HBD-driven direction below repeatedly ASKS the engine "what
  // would this lcIn need?" and narrows toward the answer by comparison only —
  // a search, not a calculation. It costs a handful of ~0.4ms engine calls.
  //
  // FIRST DEPOSIT has no pool ratio to consult yet — the depositor's own
  // numbers SET the market price for everyone. So this mode asks for an
  // explicit "Opening price" and feeds it to the SAME estimateLiquidity call
  // as a pair of SYNTHETIC reserves (1 LASSECASH : price HBD). That is still
  // the engine computing hbdNeeded = lcIn * price — not a division written
  // here — it just prices against a reserve pair the user chose instead of
  // one the chain already holds.

  /** Which field the user is actively typing into. */
  let driver = $state<"lc" | "hbd">("lc");
  let lcInput = $state("10000");
  let hbdInput = $state("");
  /** First-deposit only: HBD per 1 LASSECASH, as typed. */
  let openingPrice = $state("");

  const reserveArgs = $derived.by(() => {
    if (!info || !poolReady) return null;
    return {
      lc: toBaseUnitArg(info.amm_lc),
      hbd: toBaseUnitArg(info.amm_hbd),
      shares: toBaseUnitArg(info.amm_shares),
    };
  });

  /** Synthetic reserves standing in for the price the user is proposing. */
  const syntheticReserveArgs = $derived.by(() => {
    try {
      const priceUnits = toBaseUnitArg(openingPrice || "0");
      if (priceUnits === "0") return null;
      // 1 LASSECASH of synthetic reserve, priced at `priceUnits` HBD. Using
      // the SAME number for lcReserve and totalShares makes the synthetic
      // quote's `shares` field equal lcIn exactly — which is also the real
      // rule for an actual first deposit (LPSharesFor: shares = lcIn when
      // totalShares is 0), so the preview and the real chain rule agree.
      return { lc: "100000000", hbd: priceUnits, shares: "100000000" };
    } catch { return null; }
  });

  /** Whichever reserve pair is actually pricing the deposit right now. */
  const activeReserveArgs = $derived(poolReady ? reserveArgs : syntheticReserveArgs);

  /**
   * Search for the LASSECASH amount whose engine-computed hbdNeeded matches
   * `hbdTargetUnits`, by exponential-then-binary search over lcIn. Never
   * inverts the ratio directly — every candidate is checked by calling the
   * SAME engine quote the LC-driven field uses.
   */
  function reverseLcForHbd(
    hbdTargetUnits: bigint, lcReserve: string, hbdReserve: string, totalShares: string,
  ): bigint {
    if (hbdTargetUnits <= 0n) return 0n;
    const needFor = (lcUnits: bigint): bigint => {
      if (lcUnits <= 0n) return 0n;
      const q = estimateLiquidity(lcUnits.toString(), lcReserve, hbdReserve, totalShares);
      return q.ok && !q.isFirstDeposit ? toUnits(q.hbdNeeded) : 0n;
    };
    // hbdNeeded is a STAIRCASE (many lcIn values round up to the same
    // hbdNeeded), so this hunts for the LARGEST lcIn whose need still fits
    // the target — never the first crossing, which would silently under-fill
    // the deposit by however wide that step happens to be.
    let hi = 1n;
    for (let i = 0; i < 64 && needFor(hi) <= hbdTargetUnits; i++) hi *= 2n;
    let lo = 0n;
    for (let i = 0; i < 64 && hi - lo > 1n; i++) {
      const mid = (lo + hi) / 2n;
      if (needFor(mid) <= hbdTargetUnits) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * 1 HBD = N LASSECASH — the reciprocal of the price line's other half
   * (`spot` normally, `openingPrice` on a first deposit). Neither reserve pair
   * exposes a direct inverse, so this reuses the SAME search above against
   * whichever reserve pair is active: it asks the engine how much LC would
   * need exactly 1 HBD. ESTIMATE in normal mode; on a first deposit it is
   * exactly what the typed price implies, no more provisional than the price
   * itself.
   */
  const hbdToLcRate = $derived.by(() => {
    if (!chain.ready || !activeReserveArgs) return null;
    const args = activeReserveArgs;
    const lcForOneHbd = reverseLcForHbd(toUnits("1"), args.lc, args.hbd, args.shares);
    return lcForOneHbd > 0n ? fromUnits(lcForOneHbd) : null;
  });

  /** ESTIMATE — ties both deposit fields to the active price (pool ratio, or the typed opening price). */
  const lpQuote = $derived.by(() => {
    if (!chain.ready || !activeReserveArgs) return null;
    const args = activeReserveArgs;
    try {
      let lcBase: string;
      if (driver === "hbd") {
        lcBase = reverseLcForHbd(toUnits(hbdInput || "0"), args.lc, args.hbd, args.shares).toString();
      } else {
        lcBase = toBaseUnitArg(lcInput || "0");
      }
      const q = estimateLiquidity(lcBase, args.lc, args.hbd, args.shares);
      return { ...q, lcBase };
    } catch { return null; }
  });

  // Sync the non-driver field to what the engine quoted for the driver field.
  // Nothing to sync until a reserve pair exists — on a first deposit that
  // means not until a price has been typed.
  $effect(() => {
    if (!lpQuote?.ok) return;
    if (driver === "lc") hbdInput = lpQuote.hbdNeeded;
    else lcInput = fromUnits(BigInt(lpQuote.lcBase));
  });

  // First-deposit mode must never show a pre-filled, plausible-looking amount
  // sitting next to a price nobody has chosen yet — that is exactly the setup
  // that nearly opened the pool 8x too cheap. Blank both amount fields the
  // moment the pool is known to hold no reserves, whether that is true on
  // load or the pool drains to empty mid-session. `clearedForFirstDeposit` is
  // a plain closure variable, not $state — this must run once per transition,
  // not fight the user's typing on every re-render.
  let clearedForFirstDeposit = false;
  $effect(() => {
    if (!info) return; // wait for the first real read
    if (poolReady) { clearedForFirstDeposit = false; return; }
    if (!clearedForFirstDeposit) {
      lcInput = "";
      hbdInput = "";
      clearedForFirstDeposit = true;
    }
  });

  const hbdBalanceUnits = $derived(BigInt(Math.trunc(me?.hbd ?? 0)));
  const hbdBalance = $derived(fromUnits(hbdBalanceUnits));

  /**
   * ON MAGI, HBD AND RC ARE ONE POT — so the balance is NOT the ceiling.
   *
   * `max_rcs - hbd_milli` is exactly 10,000 on every account: capacity IS the
   * HBD balance plus the free allowance. Drawing HBD therefore spends RC one
   * for one, and the call's own `rc_limit` is reserved ON TOP of the draw:
   *
   *     available RC  >=  HBD drawn (milli)  +  rc_limit
   *
   * MEASURED 2026-09-01 on @daneamanda, to the milli. Holding 3,443 milli with
   * 6,460 RC available, a 1,000 LC deposit needing 2,665 was REFUSED by the
   * node (`ledger_error: insufficient balance`) while 500 LC needing 1,333 went
   * through moments later. Afterwards: 6,460 - 1,333 (draw) - 1,634 (rc used)
   * = 3,493, matching the meter exactly.
   *
   * She missed by about twenty cents while the page showed her 3.443 HBD. She
   * had it — she could not spend all of it in ONE call.
   *
   * The reserve is generous on purpose. The signer sizes each call at
   * max(table, 3x SIMULATED gas), so the figure is not fixed — on her deposit
   * it was about 4,902. Checked against her real meter:
   *
   *     reserve 4,000 -> offers 2,460 milli -> margin -902  REFUSED
   *     reserve 5,000 -> offers 1,460 milli -> margin    98  barely
   *     reserve 5,500 -> offers   960 milli -> margin   598  comfortable
   *
   * 5,500 it is. A tighter reserve buys a few hundred LC of headroom and
   * risks handing someone a "Max" the chain then refuses, which is the exact
   * failure this exists to prevent.
   *
   * If RC is unknown (dev chain, node down) this falls back to the balance
   * rather than blocking a deposit on a meter we cannot read.
   */
  /**
   * THE ANNOUNCED KEY-BURN HEIGHT — day 40 after genesis, 10 October 2026.
   *
   * The zero fee is already hardcoded: no parameter, no registry row, no
   * governance path, pinned by TestSwapTakesNoFee and
   * TestSwapFeeIsZeroAndNotGovernable. But "forever" is not true until the
   * owner key is destroyed, because until then a timelocked contract update
   * could still change it.
   *
   * That is the same standard that rejected "12 months of admin keys" as
   * disingenuous, so the page does not claim the word early. It says what is
   * true today, and starts saying "forever" on the day it becomes true.
   *
   * Height, not a date: the chain is the clock. Verify the burn actually
   * happened before trusting the wording — this switches on the ANNOUNCED
   * height, and an announcement is a plan until the transaction is published.
   */
  const KEY_BURN_HEIGHT = 110_664_118;
  const keysBurned = $derived(!!info && info.height >= KEY_BURN_HEIGHT);

  const RC_RESERVE_MILLI = 5_500;

  /**
   * EVERY tranche in the pool, not just this account's.
   *
   * Someone deciding whether to put money in deserves to see who else already
   * has — and until now the page could show you your own position and nothing
   * about the pool you were joining. Public by the same reasoning as the
   * snapshot: these are on-chain positions in a SHARED pool, and the emission
   * they divide is divided between exactly these rows.
   *
   * Rebuilt from the calls, because the contract cannot enumerate tranches any
   * more than it can enumerate accounts. See client.allTranches().
   */
  let allTranches = $state<Awaited<ReturnType<typeof client.allTranches>>>([]);
  $effect(() => {
    if (!chain.ready) return;
    void client.allTranches().then((t) => (allTranches = t)).catch(() => (allTranches = []));
  });
  /** One milli-HBD in the engine's 8dp base units. */
  const MILLI = 100_000n;

  let rcMeter = $state<{ amount: number; max: number } | null>(null);
  $effect(() => {
    const who = chain.account;
    if (!who) { rcMeter = null; return; }
    void client.resourceCredits().then((r) => (rcMeter = r)).catch(() => (rcMeter = null));
  });

  /** What the account can actually put into ONE deposit, balance and RC both. */
  const hbdSpendableUnits = $derived.by(() => {
    if (!rcMeter) return hbdBalanceUnits; // meter unreadable: do not block
    const spendableMilli = BigInt(Math.max(0, Math.trunc(rcMeter.amount) - RC_RESERVE_MILLI));
    const byRc = spendableMilli * MILLI;
    return byRc < hbdBalanceUnits ? byRc : hbdBalanceUnits;
  });
  /** True when RC, not the HBD balance, is what limits the deposit. */
  const rcIsBinding = $derived(hbdSpendableUnits < hbdBalanceUnits);

  /**
   * Largest deposit the account can actually afford: capped by whichever of
   * LASSECASH balance / HBD balance binds first, found by asking the engine —
   * "Max" on either field converges on this exact same point. On a first
   * deposit this respects the typed opening price; with no price yet there is
   * nothing to compute, so Max is disabled in the template until then.
   */
  function affordableDeposit(): { lc: bigint; hbd: bigint } | null {
    if (!me || !activeReserveArgs) return null;
    const args = activeReserveArgs;
    const lcBalance = toUnits(me.balance);
    const lcFromHbd = reverseLcForHbd(hbdSpendableUnits, args.lc, args.hbd, args.shares);
    const lcFinal = lcBalance < lcFromHbd ? lcBalance : lcFromHbd;
    const q = estimateLiquidity(lcFinal.toString(), args.lc, args.hbd, args.shares);
    const hbdFinal = q.ok ? toUnits(q.hbdNeeded) : 0n;
    return { lc: lcFinal, hbd: hbdFinal };
  }
  function maxLc() {
    const m = affordableDeposit();
    if (!m) return;
    driver = "lc";
    lcInput = fromUnits(m.lc);
    hbdInput = fromUnits(m.hbd);
  }
  function maxHbd() {
    const m = affordableDeposit();
    if (!m) return;
    driver = "hbd";
    hbdInput = fromUnits(m.hbd);
    lcInput = fromUnits(m.lc);
  }

  /**
   * What will actually be sent as the HBD argument. In normal mode that is
   * the quoted hbdNeeded (plus headroom on submit); on a first deposit there
   * is no real reserve to quote against, so the HBD field's own typed value
   * IS the number that sets the price — sending anything else here is how a
   * deposit went out with maxHbd=0 the first time this was tried live.
   */
  const sendHbdUnits = $derived.by(() => {
    try {
      return poolReady ? toUnits(lpQuote?.hbdNeeded ?? "0") : toUnits(hbdInput || "0");
    } catch { return 0n; }
  });

  /**
   * Why "Swap" is disabled, or null when it is ready to send.
   *
   * THE BALANCE CHECK IS THE POINT. Without it a swap larger than the
   * account holds reached the wallet, was signed, and was refused on-chain
   * with "insufficient LASSECASH" — @angeloextreme, 1,000 LC against a 900
   * balance, 2026-09-01. Nothing was lost (the contract is the backstop it
   * is supposed to be), but the user paid RC, waited 90 seconds and got an
   * error for something the page already knew was impossible. The mint form
   * grew the identical guard on 2026-08-22; the swap panel never did.
   *
   * Both directions: selling spends LASSECASH, buying spends real HBD.
   */
  const swapDisabledReason = $derived.by((): string | null => {
    if (!poolReady) return "Pool is empty";
    let inUnits: bigint;
    try { inUnits = toUnits(amountIn || "0"); } catch { return "Enter an amount"; }
    if (inUnits <= 0n) return "Enter an amount";
    if (!me) return null; // signed out: the button already says "Sign in to swap"
    if (sellingLC && inUnits > toUnits(me.balance)) return "Not enough LASSECASH";
    if (!sellingLC && inUnits > hbdBalanceUnits) return "Not enough HBD on MAGI";
    if (!quote?.ok) return "No quote";
    if (outBelowHbdStep) return "Too small — rounds to zero HBD";
    return null;
  });

  /** Why "Add liquidity" is disabled, or null when the deposit is ready to send. */
  const insufficientReason = $derived.by((): string | null => {
    if (!me) return null;
    try {
      if (!poolReady && (!openingPrice || toUnits(openingPrice) <= 0n)) {
        return "Set an opening price";
      }
    } catch {
      return "Set an opening price"; // still-typing a partial number, e.g. "0."
    }
    if (!lpQuote?.ok || BigInt(lpQuote.lcBase) <= 0n || sendHbdUnits <= 0n) {
      return "Enter an amount";
    }
    // LASSECASH IS CHECKED FIRST, and the order is the whole point.
    //
    // When both sides are short, whichever check runs first is the message the
    // user acts on — and "deposit HBD from Hive" sends them off-site to solve
    // a problem they do not have. 2026-09-01: @daneamanda typed 10,000 LC
    // holding 1,000 LC and 3.443 HBD. She had ample HBD for what she could
    // actually afford (1,000 LC needs 2.66); the binding side was her own
    // token, and the interface told her to go and buy the other one.
    //
    // You cannot fix "not enough LASSECASH" by depositing HBD, so it is named
    // first and points at Max, which already caps the deposit at whichever
    // side binds.
    if (BigInt(lpQuote.lcBase) > toUnits(me.balance)) {
      return "Not enough LASSECASH — press Max for the most you can add";
    }
    if (sendHbdUnits > hbdSpendableUnits) {
      // Naming the balance here would be a lie: they HAVE the HBD, they just
      // cannot spend all of it in one call while it is also backing their RC.
      // Three different situations, three different answers. Telling someone
      // to deposit HBD they already hold, or to press a Max that is zero, is
      // worse than saying nothing.
      if (hbdSpendableUnits <= 0n) {
        return "Not enough resource credits right now — they refill over 5 days, or instantly if you deposit more HBD to MAGI";
      }
      return rcIsBinding
        ? "Too much for one deposit — on MAGI your HBD is also your resource credits. Press Max, or add more HBD (it raises the meter)."
        : "Not enough HBD on MAGI — deposit from Hive first";
    }
    return null;
  });

  /** Whether to show the "Opening price" summary + caution above the button. */
  const showOpeningPricePreview = $derived(
    !poolReady && !!lpQuote?.ok && BigInt(lpQuote.lcBase) > 0n && sendHbdUnits > 0n,
  );

  // Every action on this page settles real HBD through the node's ledger,
  // which is indexed a beat behind contract state — so each one waits for the
  // HBD figure itself rather than for "something changed".
  async function doSwap() {
    swapError = null;
    swapError = await chain.submit(() => client.swap(direction, amountIn, minOut), { movesHbd: true });
  }
  async function addLiquidity() {
    lpError = null;
    if (!lpQuote?.ok) return;
    const lcAmount = fromUnits(BigInt(lpQuote.lcBase));
    const hbdArg = poolReady
      // Headroom: the ratio can shift between quote and send.
      ? (Number(lpQuote.hbdNeeded) * 1.01).toFixed(8)
      // First deposit: send exactly what the HBD field shows. There is no
      // chain-side quote to recompute from — this number IS the price.
      : hbdInput;
    lpError = await chain.submit(() => client.addLiquidity(lcAmount, hbdArg), { movesHbd: true });
  }
  async function claim(id: number) {
    // Rewards are LASSECASH, not HBD — nothing to wait on in the ledger.
    lpError = await chain.submit(() => client.claimPoolRewards(id));
  }
  async function exit(id: number) {
    lpError = await chain.submit(() => client.removeLiquidity(id), { movesHbd: true });
  }

</script>

<Seo
  title="LASSECASH:HBD Pool"
  description="Swap LASSECASH and HBD at zero fee, provide liquidity, and earn the loyalty bonus — up to +90% at 90 days."
  canonical={`${SITE_URL}/pool`}
  image={SITE_OG_IMAGE}
/>

<div class="grid">
  <section class="stats">
    <div class="panel stat">
      <div class="label">Pool APY</div>
      <div class="value gold">{poolApy !== null ? fractionPct(poolApy) : "—"}</div>
      <div class="sub">at 1.00x loyalty, before the bonus — estimate, moves with the pool</div>
    </div>
    <div class="panel stat">
      <div class="label">Pool reserves</div>
      <div class="value gold">{info ? lcShort(info.amm_lc) : "—"}</div>
      <div class="sub">LASSECASH</div>
    </div>
    <div class="panel stat">
      <div class="label">Paired with</div>
      <div class="value">{info ? lc(info.amm_hbd) : "—"}</div>
      <div class="sub">HBD</div>
    </div>
    <div class="panel stat">
      <div class="label">Price</div>
      <div class="value">{spot ?? "—"}</div>
      <div class="sub">HBD per LASSECASH</div>
    </div>
    <div class="panel stat">
      <div class="label">Swap fee</div>
      <div class="value green">0%</div>
      <div class="sub">{keysBurned ? "forever — the keys are burned" : "hardcoded · nobody can raise it"}</div>
    </div>
  </section>

  <div class="row layout">
    <section class="panel swap">
      <h2>Swap</h2>
      <div class="dir">
        <button class="ghost" class:active={sellingLC} onclick={() => (direction = "lc_hbd")}>Sell LASSECASH</button>
        <button class="ghost" class:active={!sellingLC} onclick={() => (direction = "hbd_lc")}>Buy LASSECASH</button>
      </div>

      <label class="field">
        <span>You pay — {inSymbol}</span>
        <input inputmode="decimal" bind:value={amountIn} />
      </label>

      {#if poolReady}
        {#if quote}
          <div class="quote" class:invalid={!quote.ok}>
            {#if quote.ok}
              <div class="headline">
                <span class="dim">You receive about</span>
                <strong class="gold mono">{lc(quote.amountOut, 3)}</strong>
                <span class="dim">{outSymbol}</span>
              </div>
              <div class="meta">
                <span>Rate <b class="mono">{lc(quote.rate, 8)}</b></span>
                <span class:amber={Number(quote.priceImpactPct) > 1} class:red={Number(quote.priceImpactPct) > 5}>
                  Price impact <b class="mono">{pct(quote.priceImpactPct)}</b>
                </span>
              </div>
              {#if outBelowHbdStep}
                <p class="estimate red">
                  Too small to pay out: HBD moves in 0.001 steps on MAGI and
                  this swap would pay {lc(quote.amountOut, 3)}. Increase the
                  amount.
                </p>
              {:else}
                <p class="estimate">
                  Estimate. Reserves move before this broadcasts — you receive at
                  least <b class="mono">{lc(minOut, 3)}</b> {outSymbol} or the swap is rejected.
                </p>
              {/if}
            {:else}
              <p class="dim">Not possible at this size.</p>
            {/if}
          </div>
          <label class="field">
            <span>Slippage tolerance — {slippagePct}%</span>
            <input type="range" min="0.1" max="5" step="0.1" bind:value={slippagePct} />
          </label>
        {/if}
      {:else}
        <div class="quote invalid"><p class="dim">Pool is empty — no price yet.</p></div>
      {/if}

      {#if swapError}<p class="err">{swapError}</p>{/if}
      <button onclick={doSwap} disabled={!chain.account || !!swapDisabledReason || chain.busy}>
        {chain.account ? (swapDisabledReason ?? "Swap") : "Sign in to swap"}
      </button>
    </section>

    <aside class="side">
      <div class="panel">
        <h2>Provide liquidity</h2>

        <!-- SAID BEFORE IT BITES, not after. On MAGI a deposit spends the same
             HBD that backs your resource credits, so an account can hold HBD it
             cannot put in the pool in one call. That reads as a broken site
             unless someone told you first — and it is the wall every new LP
             walks into after depositing, claiming and swapping in one sitting.
             Only shown when RC is actually the binding constraint, so it is
             information rather than noise. -->
        {#if rcIsBinding}
          <p class="rcnote">
            On MAGI your HBD is also your resource credits, so not all of it can
            go in at once. <b>Max</b> knows the difference. Holding more HBD on
            MAGI raises the meter — it is collateral, never spent.
          </p>
        {/if}

        {#if !poolReady}
          <div class="asset-field">
            <div class="asset-head">
              <span class="asset-name">Opening price</span>
            </div>
            <div class="price-input-row">
              <input inputmode="decimal" bind:value={openingPrice} placeholder="e.g. 0.00103" />
              <span class="dim mono price-unit">HBD / LASSECASH</span>
            </div>
            <small class="dim">
              Check the current Hive-Engine price before setting this. This ratio becomes the market price.
            </small>
          </div>
        {/if}

        <div class="asset-field">
          <div class="asset-head">
            <span class="asset-name">LASSECASH</span>
            <span class="asset-balance">
              Balance <b class="mono">{lc(me?.balance ?? "0.00000000")}</b>
              <button
                type="button" class="ghost small linklike"
                onclick={maxLc} disabled={!chain.account || !activeReserveArgs}
              >Max</button>
            </span>
          </div>
          <input
            inputmode="decimal" bind:value={lcInput} placeholder="0"
            oninput={() => (driver = "lc")}
          />
        </div>

        <div class="asset-field">
          <div class="asset-head">
            <span class="asset-name">HBD</span>
            <span class="asset-balance">
              Balance <b class="mono">{lc(hbdBalance, 3)}</b>
              <button
                type="button" class="ghost small linklike"
                onclick={maxHbd} disabled={!chain.account || !activeReserveArgs}
              >Max</button>
            </span>
          </div>
          <input
            inputmode="decimal" bind:value={hbdInput} placeholder="0.00000000"
            oninput={() => (driver = "hbd")}
          />
        </div>

        {#if poolReady && (hbdToLcRate || spot)}
          <p class="price-line dim mono">
            {#if hbdToLcRate}1 HBD = <b>{lc(hbdToLcRate, 4)}</b> LASSECASH{/if}
            {#if hbdToLcRate && spot} · {/if}
            {#if spot}1 LASSECASH = <b>{spot}</b> HBD{/if}
          </p>
        {/if}

        {#if poolReady && lpQuote?.ok}
          <div class="quote">
            <div class="meta col">
              <span>You get <b class="mono gold">{lc(lpQuote.shares)}</b> pool shares</span>
            </div>
            <p class="estimate">
              A new tranche starts at 1.00x and earns +1% a day, capping at 1.90x after 90 days.
            </p>
          </div>
        {/if}

        {#if showOpeningPricePreview}
          <p class="opening-price gold mono">
            Opening price: <b>{lc(openingPrice, 8)}</b> HBD per LASSECASH
            {#if hbdToLcRate} · 1 HBD = <b>{lc(hbdToLcRate, 2)}</b> LASSECASH{/if}
          </p>
          <p class="caution">
            This is the first deposit. The ratio you submit becomes the market
            price for everyone. Arbitrage will correct a mistake at your expense.
          </p>
        {/if}

        {#if lpError}<p class="err">{lpError}</p>{/if}
        <button
          onclick={addLiquidity}
          disabled={!chain.account || !lpQuote?.ok || chain.busy || !!insufficientReason}
        >
          {chain.account ? (insufficientReason ?? "Add liquidity") : "Sign in"}
        </button>
      </div>

      {#if info}
        <div class="panel">
          <h2>Liquidity rewards</h2>
          <dl>
            <dt>Unclaimed pool</dt>
            <dd class="mono gold">
              {lc(info.pool_liquidity)}
              <Hbd amount={info.pool_liquidity} block />
            </dd>
            <dt>Total pool shares</dt><dd class="mono">{lcShort(info.amm_shares)}</dd>
          </dl>
          <small class="dim">Funded by 25% of every block reward — not by trading fees.</small>
        </div>
      {/if}
    </aside>
  </div>

  <section class="panel">
    <h2>Your tranches</h2>
    {#if !chain.account}
      <p class="empty">Sign in to see your positions.</p>
    {:else if tranches.length === 0}
      <p class="empty">No liquidity provided. Each deposit opens its own tranche and ages independently.</p>
    {:else}
      <div class="scroll">
        <table>
          <thead>
            <tr><th></th><th class="num">Pool shares</th><th class="num">Age</th>
            <th class="num">Loyalty</th><th class="num">Worth</th><th class="num">Rewards</th>
            <th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {#each tranches as t (t.id)}
              {@const health = healthOf(t)}
              <tr>
                <td class="mono dim">#{t.id}</td>
                <td class="num">{lc(t.shares)}</td>
                <td class="num">{t.age_days}d</td>
                <td class="num" class:green={t.age_days >= 90}>
                  {mult(t.loyalty_multiplier)}{#if t.age_days >= 90}<span class="pill ok">max</span>{/if}
                </td>
                <td class="num">{lc(t.value_lc)} LASSECASH <small class="dim">+ {lc(t.value_hbd, 3)} HBD</small></td>
                <td class="num" class:gold={!isZero(t.pending_reward)} class:dim={isZero(t.pending_reward)}>
                  {lc(t.pending_reward, 3)}
                  <Hbd amount={t.pending_reward} decimals={6} block />
                </td>
                <td class="health"><TrancheHealth {health} /></td>
                <td class="actions">
                  <button
                    class="ghost small"
                    class:pulse-cta={health.phase >= 1}
                    onclick={() => claim(t.id)}
                    disabled={chain.busy || (isZero(t.pending_reward) && health.phase === 0)}
                  >
                    {#if !isZero(t.pending_reward)}
                      Claim rewards
                    {:else if health.phase >= 1}
                      <!-- Nothing is owed, but claiming is also the ONLY way to
                           prove life and reset the dormancy clock without
                           withdrawing the whole position — must stay pressable. -->
                      Claim (resets clock)
                    {:else}
                      Nothing yet
                    {/if}
                  </button>
                  <button class="small" onclick={() => exit(t.id)} disabled={chain.busy}>Withdraw</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if allTranches.length}
      <h2 class="allt">Everyone in the pool <span class="dim">— {allTranches.length} tranches</span></h2>
      <p class="allnote dim">
        The 25% emission slice is split between exactly these rows, by share and
        loyalty. Rebuilt from the chain's own calls — the contract cannot list
        them any more than it can list accounts.
      </p>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Account</th><th class="num">Pool shares</th><th class="num">Share</th>
            <th class="num">Age</th><th class="num">Loyalty</th><th class="num">Worth</th></tr>
          </thead>
          <tbody>
            {#each allTranches as t (t.owner + "_" + t.id)}
              <tr class:mine={chain.account === "hive:" + t.owner}>
                <td><a href="/@{t.owner}">@{t.owner}</a> <span class="dim mono">#{t.id}</span></td>
                <td class="num">{lc(t.shares)}</td>
                <td class="num mono">{(t.share * 100).toFixed(1)}%</td>
                <td class="num">{t.ageDays}d</td>
                <td class="num" class:green={t.ageDays >= 90}>{mult(t.loyalty)}</td>
                <td class="num">{lc(t.valueLc)} LASSECASH <small class="dim">+ {lc(t.valueHbd, 3)} HBD</small></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>

<style>
  .allt { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid var(--rule); }
  .allnote { font-size: .78rem; margin: 0 0 .75rem; }
  /* Your own rows, findable without hunting for your name. */
  tr.mine td { background: rgba(255, 200, 0, .04); }
  .rcnote { margin: 0 0 1rem; padding: .7rem .9rem; font-size: .82rem;
            border-left: 2px solid var(--gold-dim); color: var(--dim); }
  .rcnote b { color: var(--gold); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
  @media (max-width: 720px) {
    /* Two-up rather than one tall column per figure. */
    .stats { grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  }
  .layout { align-items: flex-start; }
  .swap { flex: 1 1 460px; }
  .side { flex: 1 1 320px; display: flex; flex-direction: column; gap: 1rem; }
  .dir { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .dir button { flex: 1; }
  .dir button.active { border-color: var(--gold); color: var(--gold); }
  .quote { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 0.85rem; margin-bottom: 0.9rem; }
  .quote.invalid { opacity: 0.6; }
  .headline { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .headline strong { font-size: 1.45rem; }
  .meta { display: flex; gap: 1.2rem; flex-wrap: wrap; margin-top: 0.55rem; font-size: 0.83rem; color: var(--dim); }
  .meta.col { flex-direction: column; gap: 0.3rem; }
  .meta b { color: var(--ink); }
  .estimate { margin: 0.6rem 0 0; font-size: 0.78rem; color: var(--dim); line-height: 1.5; }
  .err { color: var(--red); font-size: 0.86rem; margin: 0 0 0.7rem; }
  .swap > button, .side button:not(.small) { width: 100%; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.45rem 1rem; margin: 0 0 0.7rem; }
  dt { color: var(--dim); font-size: 0.85rem; }
  dd { margin: 0; text-align: right; }
  .scroll { overflow-x: auto; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions button + button { margin-left: 0.35rem; }
  .pill { margin-left: 0.35rem; }
  td.health { min-width: 150px; }
  /* Claiming resets the anti-zombie clock, so once a position needs
     attention the claim button IS the call to action — gold and pulsing,
     the same treatment MintRow gives claiming a bleeding mint. Never red:
     red is reserved for value actively being lost, not for a button. */
  button.pulse-cta {
    border-color: var(--gold); color: var(--gold);
    animation: cta-pulse 1.6s ease-in-out infinite;
  }
  @keyframes cta-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 210, 63, 0.5); }
    50% { box-shadow: 0 0 0 4px rgba(255, 210, 63, 0); }
  }

  /* Two (or three, first-deposit) linked asset rows, Tribaldex-style: name +
     balance + Max above each input, so the group reads as one "deposit"
     action rather than separate forms. */
  .asset-field {
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 8px; padding: 0.6rem 0.7rem; margin-bottom: 0.6rem;
  }
  .asset-head {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 0.35rem; gap: 0.5rem; flex-wrap: wrap;
  }
  .asset-name {
    font-family: var(--mono); font-weight: 800; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--gold-dim); font-size: var(--t-tiny);
  }
  .asset-balance {
    color: var(--dim); font-size: var(--t-tiny);
    display: flex; align-items: center; gap: 0.4rem;
  }
  .asset-balance b { color: var(--ink); font-weight: 600; }
  .asset-field input {
    width: 100%; background: transparent; border: none; padding: 0.1rem 0;
    font-size: var(--t-lg); font-weight: 700;
  }
  .asset-field input:focus, .asset-field input:hover { border-color: transparent; box-shadow: none; }
  .price-input-row { display: flex; align-items: center; gap: 0.5rem; }
  .price-input-row input { flex: 1; }
  .price-unit { font-size: var(--t-tiny); white-space: nowrap; }
  .linklike {
    padding: 0.1rem 0.4rem; font-size: var(--t-micro);
    text-transform: uppercase; letter-spacing: 0.05em; font-weight: 800;
  }
  .price-line { margin: 0 0 0.9rem; font-size: var(--t-tiny); }
  .price-line b { color: var(--ink); font-weight: 600; }

  /* First-deposit price preview: prominent, gold, above the button — this is
     the ONE number this page can let someone get badly wrong. */
  .opening-price {
    font-size: var(--t-base); font-weight: 700; margin: 0.9rem 0 0.4rem;
    text-shadow: var(--glow-gold);
  }
  .opening-price b { color: var(--gold); }
  .caution {
    color: var(--red); font-size: var(--t-tiny); line-height: 1.5;
    margin: 0 0 0.9rem; padding: 0.5rem 0.65rem;
    border: 1px solid var(--red); border-radius: 6px;
    background: rgba(255, 77, 77, 0.07);
  }
</style>

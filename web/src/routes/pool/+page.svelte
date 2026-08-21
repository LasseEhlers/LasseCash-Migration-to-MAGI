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
  import { lc, lcShort, mult, pct } from "$lib/format.js";
  import {
    estimateSwap, estimateLiquidity, toBaseUnitArg, toUnits, fromUnits, isZero,
    type SwapDirection,
  } from "$api/index.js";

  let direction = $state<SwapDirection>("lc_hbd");
  let amountIn = $state("1000");
  let slippagePct = $state(1);
  let swapError = $state<string | null>(null);
  let lpError = $state<string | null>(null);

  const info = $derived(chain.info);
  const me = $derived(chain.me);
  const tranches = $derived((me?.tranches ?? []).filter((t) => !t.closed));
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

  /** 1 LASSECASH = M HBD — the same figure the header "Price" tile shows. */
  const spot = $derived(
    info && poolReady
      ? (Number(info.amm_hbd) / Number(info.amm_lc)).toFixed(8)
      : null,
  );

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
    const lcFromHbd = reverseLcForHbd(hbdBalanceUnits, args.lc, args.hbd, args.shares);
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
    if (sendHbdUnits > hbdBalanceUnits) return "Not enough HBD on MAGI — deposit from Hive first";
    if (BigInt(lpQuote.lcBase) > toUnits(me.balance)) return "Not enough LASSECASH";
    return null;
  });

  /** Whether to show the "Opening price" summary + caution above the button. */
  const showOpeningPricePreview = $derived(
    !poolReady && !!lpQuote?.ok && BigInt(lpQuote.lcBase) > 0n && sendHbdUnits > 0n,
  );

  async function doSwap() {
    swapError = null;
    swapError = await chain.submit(() => client.swap(direction, amountIn, minOut));
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
    lpError = await chain.submit(() => client.addLiquidity(lcAmount, hbdArg));
  }
  async function claim(id: number) {
    lpError = await chain.submit(() => client.claimPoolRewards(id));
  }
  async function exit(id: number) {
    lpError = await chain.submit(() => client.removeLiquidity(id));
  }
</script>

<div class="grid">
  <section class="stats">
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
      <div class="sub">LPs are paid in LASSECASH</div>
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
                <strong class="gold mono">{lc(quote.amountOut, 6)}</strong>
                <span class="dim">{outSymbol}</span>
              </div>
              <div class="meta">
                <span>Rate <b class="mono">{lc(quote.rate, 8)}</b></span>
                <span class:amber={Number(quote.priceImpactPct) > 1} class:red={Number(quote.priceImpactPct) > 5}>
                  Price impact <b class="mono">{pct(quote.priceImpactPct)}</b>
                </span>
              </div>
              <p class="estimate">
                Estimate. Reserves move before this broadcasts — you receive at
                least <b class="mono">{lc(minOut, 6)}</b> {outSymbol} or the swap is rejected.
              </p>
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
      <button onclick={doSwap} disabled={!chain.account || !poolReady || !quote?.ok || chain.busy}>
        {chain.account ? "Swap" : "Sign in to swap"}
      </button>
    </section>

    <aside class="side">
      <div class="panel">
        <h2>Provide liquidity</h2>

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
              Balance <b class="mono">{lc(hbdBalance, 8)}</b>
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
            <dt>Unclaimed pool</dt><dd class="mono gold">{lc(info.pool_liquidity)}</dd>
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
            <th class="num">Loyalty</th><th class="num">Worth</th><th class="num">Rewards</th><th></th></tr>
          </thead>
          <tbody>
            {#each tranches as t (t.id)}
              <tr>
                <td class="mono dim">#{t.id}</td>
                <td class="num">{lc(t.shares)}</td>
                <td class="num">{t.age_days}d</td>
                <td class="num" class:green={t.age_days >= 90}>
                  {mult(t.loyalty_multiplier)}{#if t.age_days >= 90}<span class="pill ok">max</span>{/if}
                </td>
                <td class="num">{lc(t.value_lc)} LC <small class="dim">+ {lc(t.value_hbd, 6)} HBD</small></td>
                <td class="num" class:gold={!isZero(t.pending_reward)} class:dim={isZero(t.pending_reward)}>
                  {lc(t.pending_reward, 6)}
                </td>
                <td class="actions">
                  <button
                    class="ghost small" onclick={() => claim(t.id)}
                    disabled={chain.busy || isZero(t.pending_reward)}
                  >
                    {isZero(t.pending_reward) ? "Nothing yet" : "Claim rewards"}
                  </button>
                  <button class="small" onclick={() => exit(t.id)} disabled={chain.busy}>Withdraw</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>

<style>
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

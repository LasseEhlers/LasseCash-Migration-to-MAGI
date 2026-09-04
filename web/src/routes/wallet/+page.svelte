<script lang="ts">
  /**
   * Wallet — everything this account holds, and whether it can act.
   *
   * WHY THIS PAGE EXISTS. The balances were correct but scattered: LASSECASH
   * on Mint, HBD on Pool, and the resource meters nowhere at all. Nobody
   * should have to know the site's information architecture to find out what
   * they own.
   *
   * THE METERS ARE THE POINT. On launch night an account with tokens, shares
   * and a claimed position simply could not comment — and nothing on the site
   * said why. RC is not a detail here: MAGI has no fees, so RC is the entire
   * cost of everything, and a LasseCash post spends BOTH meters at once. Two
   * bars and two sentences turn "the site is broken" into "I know what is
   * wrong and what fixes it".
   */
  import { onMount } from "svelte";
  import { chain, client } from "$lib/chain.svelte.js";
  import { lc } from "$lib/format.js";
  import Hbd from "$lib/Hbd.svelte";
  import { describeCall } from "$lib/callSummary.js";
  import CallText from "$lib/CallText.svelte";
  import AssetChips from "$lib/AssetChips.svelte";
  import CoinIcon from "$lib/CoinIcon.svelte";
  import Seo from "$lib/Seo.svelte";
  import { SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";
  import {
    ASSET_DP, ASSET_SCALE, counterparts, fromUnits, unitsToDecimal,
    type AccountOp, type ResourceCredits,
  } from "$api/index.js";

  // --- HBD across the bridge ------------------------------------------------
  //
  // MAGI's HBD is the SAME HBD, bridged rather than wrapped. It is the RC
  // meter, the pool's other side, and the only way to buy LASSECASH — which
  // makes moving it the one operation that unblocks everything else here.
  let hbdAmount = $state("");
  let hbdBusy = $state(false);
  let hbdMsg = $state<string | null>(null);
  let hbdErr = $state<string | null>(null);
  /** What sits on the HIVE side. A deposit spends THIS, not the MAGI balance. */
  let hiveHbd = $state<string | null>(null);
  let hiveHive = $state<string | null>(null);
  /** BTC on MAGI, from the mapping contract. */
  let btcBal = $state<string | null>(null);
  /** Which asset the bridge is moving. BTC is not offered — see the note. */
  let bridgeAsset = $state<"HBD" | "HIVE" | "BTC">("HBD");
  /** BTC leaves to a real Bitcoin address, so it needs one. */
  let btcAddress = $state("");

  async function withdrawBtc() {
    hbdErr = null; hbdMsg = null;
    const sent = `${hbdAmount} BTC`;
    const refusal = await chain.submit(() => client.withdrawBtc(hbdAmount, btcAddress));
    if (refusal) { hbdErr = refusal; return; }
    hbdMsg = `Sent ${sent} to ${btcAddress.slice(0, 10)}… — Bitcoin confirmation takes its own time.`;
    hbdAmount = ""; btcAddress = "";
    await loadOps();
    // The BTC tile reads the mapping contract, which chain.refresh never
    // touches — without this the balance sat stale until a manual reload
    // (Lasse, 2026-09-03: "after the swap the btc amount does not update").
    void loadMeters();
  }

  async function moveHbd(dir: "in" | "out") {
    const n = Number(hbdAmount);
    if (!Number.isFinite(n) || n <= 0) { hbdErr = "Enter an amount"; return; }
    hbdBusy = true; hbdErr = null; hbdMsg = null;
    try {
      const res = dir === "in"
        ? await client.depositHbd(hbdAmount, bridgeAsset)
        : await client.withdrawHbd(hbdAmount, undefined, bridgeAsset);
      if (!res.ok) { hbdErr = res.msg; return; }
      hbdMsg = dir === "in"
        ? `Sent to the gateway. Your MAGI ${bridgeAsset} balance updates within a few minutes.`
        : `Withdrawal submitted. The ${bridgeAsset} lands on Hive within a few minutes.`;
      hbdAmount = "";
      await chain.refresh();
    } catch (e) {
      hbdErr = e instanceof Error ? e.message : String(e);
    } finally {
      hbdBusy = false;
    }
  }

  // --- swapping on MAGI's own pools ----------------------------------------
  //
  // NOT OUR POOL. Their contracts, their 0.08% fee, their reserves. What we
  // add is the quote and a floor the chain enforces; what we must never do is
  // let any of that read as if it were ours.
  let swapFrom = $state("HBD");
  let swapTo = $state("BTC");
  let swapAmount = $state("");
  let swapSlip = $state(1);
  let swapErr = $state<string | null>(null);
  let swapMsg = $state<string | null>(null);
  let quote = $state<Awaited<ReturnType<typeof client.quoteMagi>>>(null);
  let quoting = $state(false);

  const swapTargets = $derived(counterparts(swapFrom));

  // Keep the pair valid when the user changes the left side.
  $effect(() => {
    if (!swapTargets.includes(swapTo)) swapTo = swapTargets[0] ?? "HBD";
  });

  /** Re-quote whenever the pair or the amount changes. Their reserves move. */
  $effect(() => {
    const [f, t, a] = [swapFrom, swapTo, swapAmount];
    if (!Number(a)) { quote = null; return; }
    quoting = true;
    client.quoteMagi(f, t, a)
      .then((q) => { quote = q; })
      .catch(() => { quote = null; })
      .finally(() => { quoting = false; });
  });

  /** What the chain will be told to guarantee. Never omitted, never zero. */
  const swapFloor = $derived.by(() => {
    if (!quote) return null;
    const bps = BigInt(Math.round(Math.max(0.1, Math.min(50, swapSlip)) * 100));
    const units = (quote.amountOutUnits * (10_000n - bps)) / 10_000n;
    return unitsToDecimal(units, ASSET_SCALE[swapTo] ?? 1_000n);
  });

  /** What the chips show. null means "we cannot read this", never zero. */
  const magiBalances = $derived.by((): Record<string, string | null> => ({
    HBD: me ? (Number(me.hbd) / 100_000_000).toFixed(3) : null,
    HIVE: me ? (Number(me.hive ?? 0) / 100_000_000).toFixed(3) : null,
    BTC: btcBal,
  }));

  /** Balances we can actually check — BTC from its own mapping read. */
  const swapBalance = $derived.by(() => {
    if (!me) return null;
    if (swapFrom === "HBD") return Number(me.hbd) / 100_000_000;
    if (swapFrom === "HIVE") return Number(me.hive) / 100_000_000;
    if (swapFrom === "BTC") return btcBal !== null ? Number(btcBal) : null;
    return null;
  });
  /** BTC shows all eight decimals; a 3dp BTC reads as zero. */
  const swapBalanceDp = $derived(swapFrom === "BTC" ? 8 : 3);
  const swapOverBalance = $derived(
    swapBalance !== null && Number(swapAmount || "0") > swapBalance,
  );

  /** Flip the pair, keeping it one the pools actually trade. */
  function flipSwap() {
    const [f, t] = [swapFrom, swapTo];
    if (!counterparts(t).includes(f)) return;
    swapFrom = t; swapTo = f; swapAmount = "";
  }

  async function doMagiSwap() {
    if (!quote) return;
    swapErr = null; swapMsg = null;
    const paid = `${swapAmount} ${swapFrom}`;
    // chain.submit follows the call to the CONTRACT's verdict, not just to
    // Hive accepting the broadcast. Without it a refusal reads as success:
    // the first live swap was refused for a bad recipient and the page said
    // "Sent."
    // movesHbd, ALWAYS: both of MAGI's pools have HBD on one side, so every
    // swap here moves the node's LEDGER — a different store from contract
    // state, landing a beat later. Without this the page stopped at the
    // contract's verdict and the chips sat on pre-swap figures until a manual
    // reload (Lasse, 2026-09-04, on the first HIVE swap).
    const refusal = await chain.submit(
      () => client.magiSwap(swapFrom, swapTo, swapAmount, swapSlip),
      { movesHbd: true },
    );
    if (refusal) { swapErr = refusal; return; }
    swapMsg = `Swapped ${paid} for ${swapTo}.`;
    swapAmount = "";
    await loadOps();
    // The BTC tile reads the mapping contract, which chain.refresh never
    // touches — without this the balance sat stale until a manual reload
    // (Lasse, 2026-09-03: "after the swap the btc amount does not update").
    void loadMeters();
  }

  // --- sending, any asset this account holds on MAGI --------------------
  let sendAsset = $state("LASSECASH");
  let sendTo = $state("");
  let sendAmount = $state("");
  let sendMemo = $state("");
  let sendErr = $state<string | null>(null);
  let sendMsg = $state<string | null>(null);

  /** What is on MAGI — the only balances this form can spend. */
  const sendBalances = $derived.by((): Record<string, string | null> => ({
    LASSECASH: me ? lc(me.balance, 3) : null,
    HBD: me ? (Number(me.hbd) / 100_000_000).toFixed(3) : null,
    HIVE: me ? (Number(me.hive ?? 0) / 100_000_000).toFixed(3) : null,
    BTC: btcBal,
  }));

  async function doSend() {
    sendErr = null; sendMsg = null;
    const what = `${sendAmount} ${sendAsset}`;
    const to = sendTo.trim().replace(/^@/, "");
    const refusal = await chain.submit(() => client.sendAsset(sendAsset, to, sendAmount, sendMemo));
    if (refusal) { sendErr = refusal; return; }
    sendMsg = `Sent ${what} to @${to}.`;
    sendAmount = "";
    sendMemo = "";
    await loadOps();
    // The BTC tile reads the mapping contract, which chain.refresh never
    // touches — without this the balance sat stale until a manual reload
    // (Lasse, 2026-09-03: "after the swap the btc amount does not update").
    void loadMeters();
  }

  // --- recent activity ------------------------------------------------------
  let ops = $state<AccountOp[]>([]);
  let opsLoaded = $state(false);
  async function loadOps() {
    if (!chain.account) return;
    try { ops = await client.accountOps(30); } catch { ops = []; }
    opsLoaded = true;
  }
  /**
   * Retry once the account arrives.
   *
   * onMount fires BEFORE the layout restores the session, so on a cold load
   * `chain.account` is still null and the first attempt bails. The meters
   * already had this retry; the activity list did not, so it silently stayed
   * empty on exactly the case that matters — someone opening the page fresh.
   */
  $effect(() => {
    if (chain.account && !opsLoaded) void loadOps();
  });
  const when = (iso: string) =>
    new Date(iso + "Z").toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });

  const me = $derived(chain.me);

  let magiRc = $state<ResourceCredits | null>(null);
  let hiveRc = $state<ResourceCredits | null>(null);
  let meters = $state(false);

  async function loadMeters() {
    if (!chain.account) return;
    const [m, h] = await Promise.all([
      client.resourceCredits().catch(() => null),
      client.hiveResourceCredits().catch(() => null),
    ]);
    magiRc = m; hiveRc = h; meters = true;
    const hb = await client.hiveBalances().catch(() => null);
    hiveHbd = hb?.hbd ?? null;
    hiveHive = hb?.hive ?? null;
    btcBal = await client.btcBalance().catch(() => null);
  }
  onMount(() => { void loadMeters(); void loadOps(); });
  // Signing in on this page should fill the meters without a reload.
  $effect(() => { if (chain.account && !meters) void loadMeters(); });

  const pct = (rc: ResourceCredits | null) =>
    rc && rc.max > 0 ? Math.max(0, Math.min(100, (rc.amount / rc.max) * 100)) : 0;

  /** Under a tenth of the meter is where ordinary actions start being refused. */
  const low = (rc: ResourceCredits | null) => rc !== null && pct(rc) < 10;

  /** HBD on MAGI in milli-units, which IS the MAGI meter above the free 10,000. */
  const hbdOnMagi = $derived(me ? Number(me.hbd) / 100_000_000 : 0);
  /**
   * Which direction is actually possible. Each spends a different balance,
   * and a button that cannot work should not look like it can.
   */
  const canDeposit = $derived.by(() => {
    const side = bridgeAsset === "HBD" ? hiveHbd : hiveHive;
    return side === null || Number(side) > 0;
  });
  const canWithdraw = $derived(
    Number(bridgeAsset === "HBD" ? (me?.hbd ?? 0) : (me?.hive ?? 0)) > 0,
  );
</script>

<Seo
  title="Wallet"
  description="Your LASSECASH, HBD, L-Shares and resource credits on both chains."
  canonical={`${SITE_URL}/wallet`}
  image={SITE_OG_IMAGE}
  noindex
/>

<div class="grid">
  {#if !chain.account}
    <section class="panel">
      <h2>Wallet</h2>
      <p class="empty">Sign in to see what you hold.</p>
    </section>
  {:else if !me}
    <section class="panel"><p class="empty">Reading the chain…</p></section>
  {:else}
    <!-- TWO GROUPS, because they answer different questions: what you hold
         OF LASSECASH, and what you hold ON MAGI to trade it with. Mixing them
         in one row made HBD read like part of the LasseCash position. -->
    <section class="holdings">
      <div class="group">
        <div class="ghead">LasseCash</div>
        <div class="tiles">
          <div class="panel stat">
            <div class="label">LASSECASH</div>
            <div class="value gold">{lc(me.balance)}</div>
            <div class="sub">liquid — spendable now<Hbd amount={me.balance} block /></div>
          </div>
          <div class="panel stat">
            <div class="label">L-Shares</div>
            <div class="value">{lc(me.shares)}</div>
            <div class="sub">voting power &amp; yield weight — held in mints</div>
          </div>
          <div class="panel stat">
            <div class="label">Pending rewards</div>
            <div class="value">{lc(me.pending)}</div>
            <div class="sub">mints into one position on the 1st</div>
          </div>
        </div>
      </div>

      <div class="group">
        <div class="ghead">On MAGI</div>
        <div class="tiles">
          <div class="panel stat">
            <div class="label">BTC</div>
            <div class="value" class:dim={btcBal === null}>{btcBal ?? "—"}</div>
            <!-- Not a zero. MAGI's balance record reports hbd, hive,
                 hbd_savings and hive_consensus only; a mapped asset lives in
                 its own contract and is not readable from here yet. A zero
                 would be a claim we cannot support — the dash is the truth. -->
            <div class="sub">mapped Bitcoin, held on MAGI · swappable below</div>
          </div>
          <div class="panel stat">
            <div class="label">HBD</div>
            <div class="value">{lc(fromUnits(BigInt(Math.trunc(Number(me.hbd)))), 3)}</div>
            <div class="sub">your resource meter, and the pool's other side</div>
          </div>
          <div class="panel stat">
            <div class="label">HIVE</div>
            <div class="value">{lc(fromUnits(BigInt(Math.trunc(Number(me.hive ?? 0)))), 3)}</div>
            <div class="sub">bridged from Hive, like HBD</div>
          </div>
          <div class="panel stat">
            <div class="label">ETH <span class="soon">soon</span></div>
            <div class="value dim">—</div>
            <div class="sub">MAGI maps it; no pool for it yet</div>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Can this account act?</h2>
      <p class="lede">
        MAGI has no fees, so <b>resource credits are the entire cost of everything</b>.
        Publishing on LasseCash spends BOTH meters in one signed transaction — a Hive
        comment and a MAGI contract call — so either one running dry stops the same
        action, for completely different reasons.
      </p>

      <div class="meters">
        <div class="meter" class:low={low(magiRc)}>
          <div class="mhead">
            <strong>MAGI</strong>
            <span class="mono">
              {#if magiRc}{Math.round(magiRc.amount).toLocaleString()} / {Math.round(magiRc.max).toLocaleString()}
              {:else}<span class="dim">unknown</span>{/if}
            </span>
          </div>
          <div class="bar"><div class="fill magi" style="width:{pct(magiRc)}%"></div></div>
          <p class="note">
            Claims, mints, votes, comments, swaps — every contract call. Your meter is
            <b>HBD held on MAGI</b> plus 10,000 free: about
            <b class="mono">{Math.round(hbdOnMagi * 1000 + 10_000).toLocaleString()}</b> at
            your current balance. Spent credits recover over five days, and the HBD is never
            spent — it is a meter, and you can move it out whenever you like.
          </p>
        </div>

        <div class="meter" class:low={low(hiveRc)}>
          <div class="mhead">
            <strong>Hive</strong>
            <span class="mono">
              {#if hiveRc}{pct(hiveRc).toFixed(1)}%
              {:else}<span class="dim">unknown</span>{/if}
            </span>
          </div>
          <div class="bar"><div class="fill hive" style="width:{pct(hiveRc)}%"></div></div>
          <p class="note">
            The Hive side of a post, comment or vote. It regenerates from your HIVE POWER
            over about five days and cannot be bought — if it is empty, waiting is the
            only fix, or someone delegates you HIVE POWER.
          </p>
        </div>
      </div>

      {#if meters && (low(magiRc) || low(hiveRc))}
        <p class="warn">
          {#if low(magiRc) && low(hiveRc)}
            Both meters are low, so almost nothing will go through right now.
          {:else if low(magiRc)}
            <b>MAGI credits are low.</b> Contract calls — claiming, minting, voting,
            swapping — will be refused before the wallet opens. Hold a little more HBD on
            MAGI for an instant fix, or wait for recovery.
          {:else}
            <b>Hive credits are low.</b> Posts, comments and votes will be refused by Hive
            itself. This one only refills with time.
          {/if}
        </p>
      {/if}
    </section>


    <section class="panel">
      <h2>Swap on MAGI</h2>
      <p class="lede">
        HBD, HIVE and BTC, traded on <b>MAGI's own pools</b> — their contracts, not
        ours, and they charge <b>0.08%</b> where our LASSECASH pool charges nothing. You
        sign each swap yourself and nobody takes custody, but read the note below for
        what that does and does not mean.
      </p>

      <!-- The shape every trader already knows: two stacked cards, pay on
           top, receive below, and a button between them that flips the pair.
           Familiarity is the whole point — a swap screen that needs reading
           is a swap screen people abandon. -->
      <div class="swapcard">
        <div class="leg">
          <div class="leghead">
            <span>You pay</span>
            {#if swapBalance !== null}
              <!-- One wording site-wide: "Balance <x> · Max", like the pool. -->
              <button class="maxbtn" onclick={() => (swapAmount = swapBalance.toFixed(swapBalanceDp))}>
                Balance {swapBalance.toFixed(swapBalanceDp)} {swapFrom} · MAX
              </button>
            {/if}
          </div>
          <div class="legrow">
            <input inputmode="decimal" placeholder="0.000" bind:value={swapAmount} disabled={chain.busy} />
            <span class="asset"><CoinIcon asset={swapFrom} /> {swapFrom}</span>
          </div>
          <AssetChips
            assets={["HBD", "HIVE", "BTC"]} selected={swapFrom}
            balances={magiBalances} disabled={chain.busy}
            onpick={(a) => { swapFrom = a; swapAmount = ""; }}
          />
        </div>

        <button class="flip" onclick={flipSwap} disabled={chain.busy} aria-label="Swap direction">↓</button>

        <div class="leg">
          <div class="leghead"><span>You receive — estimate</span></div>
          <div class="legrow">
            <div class="out mono" class:dim={!quote}>
              {quote ? quote.amountOut : quoting ? "…" : "0.000"}
            </div>
            <span class="asset"><CoinIcon asset={swapTo} /> {swapTo}</span>
          </div>
          <AssetChips
            assets={swapTargets} selected={swapTo}
            balances={magiBalances} disabled={chain.busy}
            onpick={(a) => (swapTo = a)}
          />
        </div>
      </div>

      {#if quote}
        <div class="quote">
          <div class="line small">
            <span class="dim">Price impact</span>
            <b class="mono" class:warn={quote.priceImpact > 0.05}>{(quote.priceImpact * 100).toFixed(2)}%</b>
            <span class="dim">· their fee {(quote.feeBps / 100).toFixed(2)}%</span>
          </div>
          <p class="fine">
            You receive at least <b class="mono">{swapFloor}</b> {swapTo} or
            <b>the swap is rejected</b> — the chain enforces that floor, not this page.
          </p>
        </div>
        <label class="field">
          <span>Slippage tolerance — {swapSlip}%</span>
          <input type="range" min="0.1" max="5" step="0.1" bind:value={swapSlip} disabled={chain.busy} />
        </label>
      {:else if Number(swapAmount) && !quoting}
        <p class="fine dim">No quote — that pool could not be read.</p>
      {/if}

      {#if swapErr}<p class="err">{swapErr}</p>{/if}
      {#if swapMsg}<p class="ok">{swapMsg}</p>{/if}
      <button
        onclick={doMagiSwap}
        disabled={chain.busy || !quote || swapOverBalance}
      >
        {swapOverBalance ? `Not enough ${swapFrom}` : chain.busy ? "Signing…" : `Swap ${swapFrom} → ${swapTo}`}
      </button>

      <p class="note out">
        <b>Ours becomes unchangeable on 10 October</b> — the LASSECASH:HBD pool above, no
        owner key, no fee. These two are MAGI's own contracts and charge 0.08%.
        <a href="/about#what-you-are-trusting-layer-by-layer">What you are trusting →</a>
      </p>
    </section>

    <section class="panel">
      <h2>Move funds between Hive and MAGI</h2>
      <p class="lede">
        It is the <b>same HBD</b> — bridged, not wrapped. On MAGI it is your resource
        meter, the pool's other side, and the only way to buy LASSECASH, which makes
        this the one move that unblocks everything else on the site.
      </p>
      <!-- BOTH SIDES, ALWAYS. The two balances are the same asset in two
           places, which is exactly why they get confused: a deposit spends
           the Hive one and a withdrawal spends the MAGI one. Showing only
           the MAGI figure is what let a Deposit button sit there looking
           available while the Hive side was empty. -->
      <AssetChips
        assets={["HBD", "HIVE", "BTC"]} selected={bridgeAsset}
        balances={magiBalances}
        disabled={chain.busy}
        onpick={(a) => { bridgeAsset = a as "HBD" | "HIVE" | "BTC"; hbdAmount = ""; hbdErr = null; hbdMsg = null; }}
      />
      <!-- The chips show what is ON MAGI, like every other chip row here. They
           used to show the Hive side, so the same green HBD mark read 3.000 in
           this panel and 39.211 in Send — one asset, one logo, two numbers, a
           few centimetres apart. Which side a move spends is the job of the
           two boxes below, where the direction is actually visible. -->
      <small class="dim chipnote">
        {bridgeAsset === "BTC"
          ? "Your mapped BTC on MAGI. It leaves to a real Bitcoin address."
          : "Your balance on MAGI. A deposit spends the Hive side, shown below."}
      </small>

      {#if bridgeAsset === "BTC"}
        <div class="btcbox">
          <div class="sides">
            <div class="side">
              <span class="slabel">on MAGI</span>
              <b class="mono">{btcBal ?? "—"}</b>
              <span class="sunit">BTC</span>
            </div>
            <span class="arrow">→</span>
            <div class="side">
              <span class="slabel">to</span>
              <b class="mono small">Bitcoin mainnet</b>
            </div>
          </div>
          <label class="field">
            <span>Bitcoin address</span>
            <input placeholder="bc1…" bind:value={btcAddress} disabled={chain.busy} spellcheck="false" />
          </label>
          <div class="hbdform">
            <input inputmode="decimal" placeholder="0.00000000" bind:value={hbdAmount} disabled={chain.busy} aria-label="BTC amount" />
            <button onclick={withdrawBtc} disabled={chain.busy || !btcAddress.trim() || !Number(hbdAmount)}>
              Withdraw BTC
            </button>
          </div>
          {#if hbdErr}<p class="err">{hbdErr}</p>{/if}
          {#if hbdMsg}<p class="ok">{hbdMsg}</p>{/if}
          <p class="note">
            <b>Check the address twice.</b> Bitcoin has no recall: a wrong address is gone,
            and neither we nor MAGI can reverse it. The Bitcoin miner fee comes out of the
            amount you send, so you receive slightly less than you type — that is the only
            version that cannot fail for being a few satoshis short. The smallest
            withdrawal is <span class="mono">0.00000546</span> BTC, Bitcoin's dust limit.
          </p>

          <!-- ONE LINE, NOT A MENU. Bitcoin deposits need an address issued
               through a service we do not run, so we name where to get one and
               stop. Lightning and card onramps are deliberately NOT featured:
               a Keepsats balance is custodial and a CEX takes your identity,
               and neither belongs on a page whose whole argument is that
               nobody holds your funds. Altera offers them; that is Altera's
               call to make, not ours to advertise. -->
          <p class="note">
            <b>Getting BTC in</b> needs a deposit address MAGI issues through a service we
            do not run — <a href="https://altera.magi.eco/deposit" target="_blank" rel="noopener">Altera handles that</a>.
            Once it is on MAGI, everything here works on it.
          </p>
        </div>
      {:else}
      <div class="sides">
        <div class="side">
          <span class="slabel">on MAGI</span>
          <b class="mono">{lc(fromUnits(BigInt(Math.trunc(Number(bridgeAsset === "HBD" ? me.hbd : (me.hive ?? 0))))), 3)}</b>
          <span class="sunit">{bridgeAsset}</span>
        </div>
        <span class="arrow">↔</span>
        <div class="side">
          <span class="slabel">on Hive</span>
          <b class="mono">{(bridgeAsset === "HBD" ? hiveHbd : hiveHive) === null ? "…" : lc((bridgeAsset === "HBD" ? hiveHbd : hiveHive)!, 3)}</b>
          <span class="sunit">{bridgeAsset}</span>
        </div>
      </div>

      <div class="hbdform">
        <input
          inputmode="decimal" placeholder="0.000" bind:value={hbdAmount}
          disabled={hbdBusy} aria-label="HBD amount"
        />
        <button onclick={() => moveHbd("in")} disabled={hbdBusy || !canDeposit}>Deposit to MAGI</button>
        <button class="ghost" onclick={() => moveHbd("out")} disabled={hbdBusy || !canWithdraw}>Withdraw to Hive</button>
      </div>
      {#if hiveHbd !== null && Number(hiveHbd) <= 0}
        <p class="note hint">
          Nothing to deposit: your <b>Hive</b> HBD balance is empty. Everything you hold is
          already on MAGI, so the move available to you is <b>Withdraw</b>.
        </p>
      {/if}
      {#if hbdErr}<p class="err">{hbdErr}</p>{/if}
      {#if hbdMsg}<p class="ok">{hbdMsg}</p>{/if}
      <p class="note">
        A deposit is a Hive transfer to <span class="mono">vsc.gateway</span> carrying the
        memo that names your account — the page builds that memo from your signed-in name,
        never from anything typed, because a wrong memo is a transfer to a stranger with no
        refund path. Both directions ask for your <b>active</b> key, and both take a few
        minutes to appear.
      </p>
      <p class="note">
        <b>Not trustless, and worth knowing.</b> Your HBD and HIVE on MAGI are held on Hive
        by an 18-key validator multisig — no individual can move them, but the set could.
        <a href="/about#what-you-are-trusting-layer-by-layer">What you are trusting →</a>
      </p>
      {/if}
      <p class="note">
        <b>Want BTC?</b> Sell LASSECASH for HBD here, then swap HBD for BTC on
        <a href="https://altera.magi.eco/swap" target="_blank" rel="noopener">Altera</a>.
        Both legs are on-chain swaps you sign yourself — nobody takes custody of your funds
        at any point, and no account or permission is granted to anyone.
      </p>
    </section>

    <section class="panel">
      <h2>Send</h2>
      <p class="lede">
        To another MAGI account — LASSECASH through our contract, HBD and HIVE as MAGI's
        own assets, BTC through its mapping contract. All three rails, one form.
        <b>This stays on MAGI</b>: to reach Hive or Bitcoin, use the sections above.
      </p>

      <AssetChips
        assets={["LASSECASH", "HBD", "HIVE", "BTC"]} selected={sendAsset}
        balances={sendBalances} disabled={chain.busy}
        onpick={(a) => { sendAsset = a; sendAmount = ""; sendErr = null; sendMsg = null; }}
      />

      <label class="field">
        <span>To</span>
        <input placeholder="account name" bind:value={sendTo} disabled={chain.busy} spellcheck="false" />
      </label>
      <label class="field">
        <span>Amount — {sendAsset}</span>
        <input inputmode="decimal" placeholder="0.000" bind:value={sendAmount} disabled={chain.busy} />
      </label>
      {#if sendBalances[sendAsset]}
        <!-- Its own block with air below: jammed against the button it read
             as part of it (Lasse, 2026-09-03). -->
        <small class="dim sendbal">
          Balance {sendBalances[sendAsset]} {sendAsset}
          <button class="maxbtn" onclick={() => (sendAmount = sendBalances[sendAsset] ?? "")}>MAX</button>
        </small>
      {/if}

      <!-- Not for BTC: a mapped-asset withdrawal carries no memo field, so
           offering one would silently discard what the user typed. -->
      {#if sendAsset !== "BTC"}
      <label class="field">
        <span>Memo <span class="dim">— optional</span></span>
        <input
          placeholder="what it is for" bind:value={sendMemo}
          disabled={chain.busy} maxlength="200" spellcheck="false"
        />
      </label>
      <!-- PUBLIC, and said plainly. Hive users are used to memos they can
           encrypt with a leading #; this one cannot be. It rides in the call
           payload, which is on Hive L1 and on MAGI forever and readable by
           anyone. Someone who assumes otherwise puts something private in it
           exactly once. -->
      <small class="dim">
        Memos are public and permanent — they live in the transaction itself, and
        unlike a Hive memo they cannot be encrypted.
      </small>
      {/if}

      {#if sendErr}<p class="err">{sendErr}</p>{/if}
      {#if sendMsg}<p class="ok">{sendMsg}</p>{/if}
      <button onclick={doSend} disabled={chain.busy || !sendTo.trim() || !Number(sendAmount)}>
        Send {sendAsset}
      </button>
    </section>

    <section class="panel">
      <h2>Recent activity</h2>
      {#if !ops.length}
        <p class="empty">
          {opsLoaded ? "No contract calls yet." : "Reading your history…"}
        </p>
      {:else}
        <small class="dim">
          Your last {ops.length} contract calls, newest first — including the ones the chain
          refused, which are the rows worth having.
        </small>
        <div class="scroll">
          <table>
            <!-- No raw entrypoint column: "set_param" beside "Voted: …" was
                 jargon repeating what the words already say. The technical
                 identity survives on hover — the title carries the call name
                 and the raw payload, which is where a debugging eye looks. -->
            <thead><tr><th>When</th><th>What it did</th><th>Status</th></tr></thead>
            <tbody>
              {#each ops as o (o.id + o.action + o.time)}
                <tr>
                  <td class="mono dim">{when(o.time)}</td>
                  <td class="clip" title="{o.action.replace(/^\+/, '')} · {o.payload}">
                    {#if o.action.startsWith("+")}<span class="in">in</span>{/if}
                    <CallText text={describeCall(o.action, o.payload)} />
                  </td>
                  <td><span class="pill {o.status}">{o.status}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
            {/if}
    </section>

  {/if}
</div>

<style>
  .holdings { display: grid; gap: 1.1rem; }
  .ghead {
    font-family: var(--mono); font-size: var(--t-micro); font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase; color: var(--gold-dim);
    margin-bottom: 0.5rem;
  }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.8rem; }
  .soon {
    font-size: var(--t-micro); letter-spacing: 0.08em; text-transform: none;
    color: var(--dimmer); border: 1px solid var(--line); border-radius: 2px;
    padding: 0 0.28rem; margin-left: 0.35rem;
  }
  @media (min-width: 62rem) { .holdings { grid-template-columns: 3fr 4fr; } }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
  @media (max-width: 720px) { .stats { grid-template-columns: 1fr 1fr; gap: 0.6rem; } }
  .stat .label { font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
  .stat .value { font-family: var(--mono); font-size: var(--t-xl); font-weight: 800; margin-top: 0.35rem; font-variant-numeric: tabular-nums; }
  .stat .sub { font-size: var(--t-micro); color: var(--dimmer); margin-top: 0.3rem; line-height: 1.5; }

  .lede { color: var(--dim); font-size: var(--t-sm); line-height: 1.6; max-width: 76ch; margin: 0.2rem 0 1rem; }
  .meters { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); }
  .meter { background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0.8rem 0.9rem; }
  .meter.low { border-color: var(--gold-dim); }
  .mhead { display: flex; justify-content: space-between; align-items: baseline; font-family: var(--mono); font-size: var(--t-sm); }
  .mhead strong { letter-spacing: 0.1em; }
  .bar { height: 7px; background: #0d1117; border-radius: 4px; overflow: hidden; margin: 0.55rem 0 0.6rem; }
  .fill { height: 100%; }
  .fill.magi { background: var(--gold); }
  .fill.hive { background: var(--cyan); }
  .note { margin: 0; font-size: var(--t-micro); color: var(--dim); line-height: 1.6; }
  /* Gold, not red: an empty meter is a wait, not a loss. Red on this site
     means value actively being lost, and nothing here is being lost. */
  /* Two stacked cards with a flip between them — the shape a trader expects. */
  .swapcard { display: grid; gap: 0.35rem; margin: 0.8rem 0 0.2rem; position: relative; }
  .leg { background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0.7rem 0.85rem; }
  .leghead { display: flex; justify-content: space-between; align-items: baseline; font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); margin-bottom: 0.45rem; }
  .sendbal { display: block; margin: 0.15rem 0 0.9rem; }
  .maxbtn { background: none; border: 0; padding: 0; color: var(--gold-dim); font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.06em; cursor: pointer; text-transform: none; }
  .maxbtn:hover { color: var(--gold); }
  .legrow { display: flex; align-items: center; gap: 0.6rem; }
  .legrow input { flex: 1; background: none; border: 0; padding: 0; color: var(--ink); font-family: var(--mono); font-size: var(--t-xl); font-variant-numeric: tabular-nums; min-width: 0; }
  .legrow input:focus { outline: none; }
  .legrow select { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0.4rem 0.55rem; font-family: var(--mono); font-weight: 700; }
  .asset { display: inline-flex; align-items: center; gap: 0.4rem; font-family: var(--mono); font-weight: 700; font-size: var(--t-sm); flex: none; }
  .out { flex: 1; font-size: var(--t-xl); color: var(--gold); font-variant-numeric: tabular-nums; }
  .out.dim { color: var(--dimmer); }
  .flip {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 2rem; height: 2rem; padding: 0; border-radius: 50%;
    background: var(--panel); border: 1px solid var(--line-hot); color: var(--gold);
    font-size: 0.95rem; line-height: 1; cursor: pointer; z-index: 2;
  }
  .flip:hover { border-color: var(--gold); }

  .swaprow { display: flex; align-items: flex-end; gap: 0.8rem; flex-wrap: wrap; margin-bottom: 0.7rem; }
  .pick { display: grid; gap: 0.3rem; }
  .pick span { font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
  .pick select { background: var(--panel-2); color: var(--ink); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0.45rem 0.6rem; font-family: var(--mono); }
  .swaprow .arrow { padding-bottom: 0.5rem; }
  .field { display: grid; gap: 0.3rem; margin: 0.6rem 0 0.2rem; }
  .field span { font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
  .quote { background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0.7rem 0.85rem; margin: 0.7rem 0; }
  .quote .line { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; font-size: var(--t-sm); }
  .quote .line.small { font-size: var(--t-tiny); margin-top: 0.3rem; }
  .quote .line b.gold { font-size: var(--t-lg); }
  .quote .warn { color: var(--amber); }
  .fine { font-size: var(--t-micro); color: var(--dim); line-height: 1.55; margin: 0.5rem 0 0; }

  .elsewhere { margin-top: 0.9rem; display: grid; gap: 0.4rem; }
  .ehead { font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.15em; text-transform: uppercase; color: var(--dim); }
  .eopt {
    display: flex; align-items: flex-start; gap: 0.6rem; text-decoration: none;
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: var(--r-sm); padding: 0.6rem 0.75rem;
  }
  .eopt:hover { border-color: var(--gold-dim); }
  .eopt strong { display: block; font-size: var(--t-sm); color: var(--ink); }
  .eopt small { display: block; font-size: var(--t-micro); color: var(--dim); margin-top: 0.15rem; line-height: 1.5; }

  .btcbox { display: grid; gap: 0.2rem; }
  .side b.small { font-size: var(--t-sm); }
  .chipnote { display: block; margin: 0.4rem 0 0.7rem; }
  .sides { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.8rem; flex-wrap: wrap; }
  .side { background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0.5rem 0.8rem; }
  .slabel { display: block; font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); }
  .side b { font-size: var(--t-lg); font-variant-numeric: tabular-nums; }
  .sunit { font-size: var(--t-micro); color: var(--dimmer); margin-left: 0.25rem; }
  .arrow { color: var(--dimmer); font-size: 1.2rem; }
  .note.hint { color: var(--gold); margin-top: 0.5rem; }

  .hbdform { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
  .hbdform input { flex: 1 1 10rem; min-width: 8rem; }
  .err { color: var(--red); font-size: var(--t-sm); margin: 0.4rem 0 0; }
  .ok { color: var(--green); font-size: var(--t-sm); margin: 0.4rem 0 0; }

  .scroll { overflow-x: auto; margin-top: 0.7rem; }
  table { border-collapse: collapse; width: 100%; min-width: 34rem; font-size: var(--t-tiny); }
  th { text-align: left; font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--line); }
  td { padding: 0.45rem 0.7rem; border-bottom: 1px solid var(--line-soft); }
  tbody tr:last-child td { border-bottom: 0; }
  .clip { max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .in { color: var(--green); font-weight: 700; margin-right: 0.25rem; }
  .pill { font-family: var(--mono); font-size: var(--t-micro); padding: 0.08rem 0.4rem; border-radius: 2px; }
  .pill.confirmed { color: var(--green); border: 1px solid rgba(53, 208, 127, 0.45); }
  .pill.failed { color: var(--red); border: 1px solid rgba(255, 77, 77, 0.45); }
  .pill.pending { color: var(--dim); border: 1px solid var(--line); }

  .routes { display: grid; gap: 0.7rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
  .route {
    display: block; text-decoration: none;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: 0.75rem 0.85rem;
  }
  .route:hover { border-color: var(--gold-dim); }
  .route strong { display: block; font-family: var(--mono); color: var(--gold); letter-spacing: 0.06em; }
  .route span { display: block; margin-top: 0.3rem; font-size: var(--t-micro); color: var(--dim); }
  .note.out { margin-top: 0.9rem; max-width: 76ch; }


  .warn { margin: 1rem 0 0; font-size: var(--t-sm); color: var(--gold); line-height: 1.6; }
</style>

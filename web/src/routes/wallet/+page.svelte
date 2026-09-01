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
  import SendForm from "$lib/SendForm.svelte";
  import { describeCall } from "$lib/callSummary.js";
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

  async function moveHbd(dir: "in" | "out") {
    const n = Number(hbdAmount);
    if (!Number.isFinite(n) || n <= 0) { hbdErr = "Enter an amount"; return; }
    hbdBusy = true; hbdErr = null; hbdMsg = null;
    try {
      const res = dir === "in"
        ? await client.depositHbd(hbdAmount)
        : await client.withdrawHbd(hbdAmount);
      if (!res.ok) { hbdErr = res.msg; return; }
      hbdMsg = dir === "in"
        ? "Sent to the gateway. It credits your MAGI balance within a few minutes."
        : "Withdrawal submitted. It lands on Hive within a few minutes.";
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
  let swapBusy = $state(false);
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

  /** Balances we can actually check. BTC is not in the account view. */
  const swapBalance = $derived.by(() => {
    if (!me) return null;
    if (swapFrom === "HBD") return Number(me.hbd) / 100_000_000;
    return null;
  });
  const swapOverBalance = $derived(
    swapBalance !== null && Number(swapAmount || "0") > swapBalance,
  );

  async function doMagiSwap() {
    if (!quote) return;
    swapBusy = true; swapErr = null; swapMsg = null;
    try {
      const res = await client.magiSwap(swapFrom, swapTo, swapAmount, swapSlip);
      if (!res.ok) { swapErr = res.msg; return; }
      swapMsg = `Sent. ${swapFrom} → ${swapTo} settles on MAGI within a few minutes.`;
      swapAmount = "";
      await chain.refresh();
      await loadOps();
    } catch (e) {
      swapErr = e instanceof Error ? e.message : String(e);
    } finally {
      swapBusy = false;
    }
  }

  // --- recent activity ------------------------------------------------------
  let ops = $state<AccountOp[]>([]);
  async function loadOps() {
    if (!chain.account) return;
    try { ops = await client.accountOps(30); } catch { ops = []; }
  }
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
    hiveHbd = (await client.hiveBalances().catch(() => null))?.hbd ?? null;
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
  const canDeposit = $derived(hiveHbd === null || Number(hiveHbd) > 0);
  const canWithdraw = $derived(hbdOnMagi > 0);
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
    <section class="stats">
      <div class="panel stat">
        <div class="label">LASSECASH</div>
        <div class="value gold">{lc(me.balance)}</div>
        <div class="sub">liquid — spendable now<Hbd amount={me.balance} block /></div>
      </div>
      <div class="panel stat">
        <div class="label">HBD on MAGI</div>
        <div class="value">{lc(fromUnits(BigInt(Math.trunc(Number(me.hbd)))), 3)}</div>
        <div class="sub">the pool's other side — and your MAGI meter</div>
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
            your current balance. Spent credits thaw over five days, and the HBD is never
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
            MAGI for an instant fix, or wait for the thaw.
          {:else}
            <b>Hive credits are low.</b> Posts, comments and votes will be refused by Hive
            itself. This one only refills with time.
          {/if}
        </p>
      {/if}
    </section>

    <section class="panel">
      <h2>Send LASSECASH</h2>
      <SendForm />
    </section>

    <section class="panel">
      <h2>Swap on MAGI</h2>
      <p class="lede">
        HBD, HIVE and BTC, traded on <b>MAGI's own pools</b> — their contracts, not
        ours, and they charge <b>0.08%</b> where our LASSECASH pool charges nothing. You
        sign each swap yourself and nobody takes custody, but read the note below for
        what that does and does not mean.
      </p>

      <div class="swaprow">
        <label class="pick">
          <span>From</span>
          <select bind:value={swapFrom} disabled={swapBusy}>
            {#each ["HBD", "HIVE", "BTC"] as a (a)}<option value={a}>{a}</option>{/each}
          </select>
        </label>
        <span class="arrow">→</span>
        <label class="pick">
          <span>To</span>
          <select bind:value={swapTo} disabled={swapBusy}>
            {#each swapTargets as a (a)}<option value={a}>{a}</option>{/each}
          </select>
        </label>
      </div>

      <label class="field">
        <span>You pay — {swapFrom}</span>
        <input inputmode="decimal" placeholder="0.000" bind:value={swapAmount} disabled={swapBusy} />
      </label>
      {#if swapBalance !== null}
        <small class="dim">Balance {swapBalance.toFixed(3)} {swapFrom} on MAGI</small>
      {/if}

      {#if quote}
        <div class="quote">
          <div class="line">
            <span class="dim">You receive about</span>
            <b class="gold mono">{quote.amountOut}</b>
            <span class="dim">{swapTo}</span>
          </div>
          <div class="line small">
            <span class="dim">Price impact</span>
            <b class="mono" class:warn={quote.priceImpact > 0.05}>{(quote.priceImpact * 100).toFixed(2)}%</b>
            <span class="dim">· their fee {(quote.feeBps / 100).toFixed(2)}%</span>
          </div>
          <p class="fine">
            Estimate, from their reserves read just now. You receive at least
            <b class="mono">{swapFloor}</b> {swapTo} or <b>the swap is rejected</b> — the
            chain enforces that floor, not this page.
          </p>
        </div>
        <label class="field">
          <span>Slippage tolerance — {swapSlip}%</span>
          <input type="range" min="0.1" max="5" step="0.1" bind:value={swapSlip} disabled={swapBusy} />
        </label>
      {:else if quoting}
        <p class="fine dim">Reading their pool…</p>
      {:else if Number(swapAmount)}
        <p class="fine dim">No quote — that pool could not be read.</p>
      {/if}

      {#if swapErr}<p class="err">{swapErr}</p>{/if}
      {#if swapMsg}<p class="ok">{swapMsg}</p>{/if}
      <button
        onclick={doMagiSwap}
        disabled={swapBusy || !quote || swapOverBalance}
      >
        {swapOverBalance ? `Not enough ${swapFrom}` : swapBusy ? "Signing…" : `Swap ${swapFrom} → ${swapTo}`}
      </button>

      <p class="note out">
        <b>Whose risk is whose.</b> Our LASSECASH:HBD pool has no owner key from
        <b>10 October</b> and charges nothing. These two are <b>MAGI's</b>: their
        contracts keep an owner and can be updated, and both sides of HBD:HIVE are
        bridged from Hive by the two-thirds validator multisig described below.
        <b>BTC is mapped</b> — real Bitcoin held off-chain by a mechanism we have not
        verified — so it carries one more layer of trust than anything else here.
        Every swap is still a trade you sign against a contract, with no account and
        no company holding your funds, which is more than most of the market offers.
        It is simply not the same as our own pool, and we will not print a word that
        blurs the two.
      </p>
    </section>

    <section class="panel">
      <h2>HBD between Hive and MAGI</h2>
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
      <div class="sides">
        <div class="side">
          <span class="slabel">on Hive</span>
          <b class="mono">{hiveHbd === null ? "…" : lc(hiveHbd, 3)}</b>
          <span class="sunit">HBD</span>
        </div>
        <span class="arrow">↔</span>
        <div class="side">
          <span class="slabel">on MAGI</span>
          <b class="mono">{lc(fromUnits(BigInt(Math.trunc(Number(me.hbd)))), 3)}</b>
          <span class="sunit">HBD</span>
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
        <b>What secures it, precisely.</b> This is the one thing here that is <em>not</em>
        trustless, and saying so is worth more than the word. Your HBD on MAGI is real HBD
        held on Hive by <span class="mono">vsc.gateway</span>, an account whose active
        authority is an <b>18-key multisig needing a two-thirds supermajority</b>
        (6,667 of 10,000 in weight; the largest single key is 24%). No individual can move
        it — not MAGI's developers, not us, not anyone holding one key — but a two-thirds
        collusion of that set could, and no contract prevents that. It is
        <b>validator-secured custody</b>, which is a strong thing and a different thing.
        The <b>swaps</b> below and the LASSECASH pool above <em>are</em> trustless: those
        execute against a contract, and nobody can decline them. Bridging is the step where
        you rely on people, so it is the step to size deliberately.
      </p>
      <p class="note">
        <b>Want BTC?</b> Sell LASSECASH for HBD here, then swap HBD for BTC on
        <a href="https://altera.magi.eco/swap" target="_blank" rel="noopener">Altera</a>.
        Both legs are on-chain swaps you sign yourself — nobody takes custody of your funds
        at any point, and no account or permission is granted to anyone.
      </p>
    </section>

    {#if ops.length}
      <section class="panel">
        <h2>Recent activity</h2>
        <small class="dim">
          Your last {ops.length} contract calls, newest first — including the ones the chain
          refused, which are the rows worth having.
        </small>
        <div class="scroll">
          <table>
            <thead><tr><th>When</th><th>Call</th><th>What it did</th><th>Status</th></tr></thead>
            <tbody>
              {#each ops as o (o.id + o.action + o.time)}
                <tr>
                  <td class="mono dim">{when(o.time)}</td>
                  <td class="mono dim">{o.action}</td>
                  <td class="clip" title={o.payload}>{describeCall(o.action, o.payload)}</td>
                  <td><span class="pill {o.status}">{o.status}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

  {/if}
</div>

<style>
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
  .ranked { margin: 0.9rem 0 0; padding-left: 1.2rem; display: grid; gap: 0.65rem; }
  .ranked li { font-size: var(--t-sm); color: var(--dim); line-height: 1.6; max-width: 78ch; }
  .ranked b { color: var(--ink); }
  .ranked li::marker { color: var(--gold-dim); font-family: var(--mono); }


  .warn { margin: 1rem 0 0; font-size: var(--t-sm); color: var(--gold); line-height: 1.6; }
</style>

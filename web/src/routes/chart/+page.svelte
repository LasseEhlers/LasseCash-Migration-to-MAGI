<script lang="ts">
  /**
   * LASSECASH:HBD — every trade since the pool opened.
   *
   * NOT CANDLES, DELIBERATELY. An AMM price is a pure function of two
   * reserves: it does not drift between trades, it sits perfectly still and
   * jumps the instant someone swaps. Drawn as steps that is exactly what you
   * see; drawn as a smooth line it would show movement that never happened.
   * Candles earn their place when there is enough flow for a candle to have a
   * body — until then they would be mostly empty boxes.
   *
   * Every figure is replayed through the engine (`client.poolTrades`), and
   * the replay is CHECKED against live reserves rather than trusted.
   */
  import { onMount } from "svelte";
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, lc } from "$lib/format.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";
  import type { PoolTrade } from "$api/index.js";

  let trades = $state<PoolTrade[]>([]);
  let reconciled = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const res = await client.poolTrades();
      trades = res.trades;
      reconciled = res.reconciled;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  const priced = $derived(trades.filter((t) => Number(t.price) > 0));
  const first = $derived(priced[0] ?? null);
  const last = $derived(priced[priced.length - 1] ?? null);
  const swaps = $derived(trades.filter((t) => t.side === "sell" || t.side === "buy"));

  /** Change since the pool opened. Exact division of two exact figures. */
  const changePct = $derived.by(() => {
    if (!first || !last) return null;
    const a = Number(first.price), b = Number(last.price);
    if (!a) return null;
    return ((b / a - 1) * 100).toFixed(1);
  });

  const low = $derived(priced.length ? priced.reduce((m, t) => (Number(t.price) < Number(m.price) ? t : m)) : null);
  const high = $derived(priced.length ? priced.reduce((m, t) => (Number(t.price) > Number(m.price) ? t : m)) : null);
  const volumeLc = $derived(
    swaps.reduce((n, t) => n + Number(t.side === "sell" ? t.amountIn : t.amountOut), 0),
  );
  const depthHbd = $derived(last ? Number(last.hbdReserve) : 0);

  /**
   * The step path, in a 0..1000 x 0..300 box.
   *
   * X is REAL ELAPSED TIME, not one slot per trade: a quiet night should look
   * like a long flat shelf, because that is what it was. Y is linear in price
   * over the observed range, padded so the line never touches the frame.
   */
  const geom = $derived.by(() => {
    if (priced.length < 2 || !low || !high) return null;
    const t0 = Date.parse(priced[0]!.time + "Z");
    const t1 = Date.parse(priced[priced.length - 1]!.time + "Z");
    const span = Math.max(1, t1 - t0);
    const lo = Number(low.price), hi = Number(high.price);
    const pad = (hi - lo) * 0.15 || hi * 0.15 || 1;
    const yLo = Math.max(0, lo - pad), yHi = hi + pad;
    const x = (t: string) => ((Date.parse(t + "Z") - t0) / span) * 940 + 40;
    const y = (p: string) => 280 - ((Number(p) - yLo) / (yHi - yLo)) * 260;

    let d = "";
    let prevY = 0;
    priced.forEach((t, i) => {
      const px = x(t.time), py = y(t.price);
      // A step: hold the previous price across to this moment, then jump.
      d += i === 0 ? `M ${px.toFixed(1)} ${py.toFixed(1)}` : ` L ${px.toFixed(1)} ${prevY.toFixed(1)} L ${px.toFixed(1)} ${py.toFixed(1)}`;
      prevY = py;
    });
    // Hold the last price out to "now", because that is where it still stands.
    d += ` L 980 ${prevY.toFixed(1)}`;
    const area = `${d} L 980 300 L 40 300 Z`;
    return {
      line: d, area, x, y, endY: prevY,
      ticks: [yLo, (yLo + yHi) / 2, yHi].map((v) => ({ v, y: y(String(v)) })),
      points: priced.map((t) => ({ t, cx: x(t.time), cy: y(t.price) })),
    };
  });

  const when = (iso: string) =>
    new Date(iso + "Z").toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
</script>

<Seo
  title="Chart"
  description="The LASSECASH:HBD price on MAGI — every trade since the pool opened, replayed from the chain."
  canonical={`${SITE_URL}/chart`}
  image={SITE_OG_IMAGE}
/>

<div class="grid">
  <section class="panel">
    <h2>LASSECASH:HBD</h2>

    {#if loading}
      <p class="empty">Replaying the pool's history…</p>
    {:else if error}
      <p class="empty red">{error}</p>
    {:else if !last}
      <p class="empty">
        No trades yet. The chart begins with the pool's first deposit.
      </p>
    {:else}
      <div class="hero">
        <div>
          <div class="price mono">{lc(last.price, 8)}</div>
          <div class="unit">HBD per LASSECASH</div>
        </div>
        {#if changePct}
          <div class="delta">
            <div class="mono" class:up={Number(changePct) >= 0}>{Number(changePct) >= 0 ? "+" : ""}{changePct}%</div>
            <div class="unit">since the pool opened</div>
          </div>
        {/if}
      </div>

      <dl class="stats">
        <div><dt>Depth</dt><dd class="mono">{lc(last.lcReserve, 2)} LC · {lc(last.hbdReserve, 3)} HBD</dd></div>
        <div><dt>Trades</dt><dd class="mono">{swaps.length}</dd></div>
        <div><dt>Volume</dt><dd class="mono">{lc(String(volumeLc), 2)} LC</dd></div>
        {#if low && high}
          <div><dt>Low / high</dt><dd class="mono">{lc(low.price, 8)} · {lc(high.price, 8)}</dd></div>
        {/if}
        <div><dt>Swap fee</dt><dd class="mono green">0%</dd></div>
      </dl>
    {/if}
  </section>

  {#if geom}
    <section class="panel">
      <div class="chartwrap">
        <svg viewBox="0 0 1000 330" role="img"
             aria-label="LASSECASH price in HBD since the pool opened, drawn as steps">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--gold)" stop-opacity="0.20" />
              <stop offset="100%" stop-color="var(--gold)" stop-opacity="0" />
            </linearGradient>
          </defs>
          {#each geom.ticks as t (t.v)}
            <line class="grid" x1="40" y1={t.y} x2="980" y2={t.y} />
            <text class="axis" x="36" y={t.y + 3} text-anchor="end">{Number(t.v).toFixed(8)}</text>
          {/each}
          <path d={geom.area} fill="url(#g)" />
          <path d={geom.line} fill="none" stroke="var(--gold)" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round" />
          {#each geom.points as p (p.t.time)}
            <circle cx={p.cx} cy={p.cy} r="3"
                    fill={p.t.side === "buy" ? "var(--cyan)" : p.t.side === "sell" ? "var(--amber)" : "var(--gold)"}>
              <title>{when(p.t.time)} · {p.t.side} · {lc(p.t.price, 8)} HBD</title>
            </circle>
          {/each}
          <circle cx="980" cy={geom.endY} r="8" fill="var(--gold)" opacity="0.16" />
          <circle cx="980" cy={geom.endY} r="3.5" fill="var(--gold)" />
          <text class="axis" x="40" y="322">{when(priced[0]!.time)}</text>
          <text class="axis" x="980" y="322" text-anchor="end">now</text>
        </svg>
      </div>
      <div class="legend">
        <span><i class="sw gold"></i>price</span>
        <span><i class="sw amber"></i>sell — LASSECASH into the pool</span>
        <span><i class="sw cyan"></i>buy — HBD into the pool</span>
      </div>
      <small class="dim note">
        Drawn as <b>steps</b> because that is what an AMM price does: it is a pure
        function of the two reserves, so it holds perfectly still between trades and
        jumps the instant someone swaps. Candles arrive when there is enough flow for
        a candle to have a body.
      </small>
    </section>
  {/if}

  {#if swaps.length}
    <section class="panel">
      <h2>Every trade, from the first deposit</h2>
      <small class="dim">
        Replayed from the chain's own calls through the engine — the same Go code
        the contract runs. Every trade names its signer, because every trade
        already does on the chain: hiding it here would make this page less
        honest than the raw transaction it is built from.
        {#if reconciled}
          The replay lands on the live reserves <b class="green">exactly, in both
          assets</b>, which is the check that says it is right.
        {:else if chain.info}
          <b class="amber">The replay does not currently reconcile with live
          reserves</b>, so treat the earlier points as approximate — a liquidity
          event it cannot reproduce is the usual cause.
        {/if}
      </small>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <!-- PER ASSET, not per direction. "In" and "Out" meant different
                   assets on different rows — a SELL puts LASSECASH in and takes
                   HBD out, a BUY does the reverse, and a LIQUIDITY row puts both
                   in — so the reader had to work out the unit from the badge
                   before the number meant anything. Each column now holds one
                   asset on every row, and the badge says which way it moved. -->
              <th>Time</th><th>Event</th><th>Trader</th>
              <th class="num">LASSECASH</th><th class="num">HBD</th>
              <th class="num">LC reserve</th><th class="num">HBD reserve</th><th class="num">Price after</th>
            </tr>
          </thead>
          <tbody>
            {#each [...trades].reverse() as t (t.time + t.side + t.amountIn)}
              <tr>
                <td class="mono dim">{when(t.time)}</td>
                <td><span class="pill {t.side}">{t.side}</span></td>
                <td class="mono">
                  {#if t.trader}
                    <a href="/@{displayName(t.trader).replace('@','')}">{displayName(t.trader)}</a>
                  {:else}<span class="dim">—</span>{/if}
                </td>
                <!-- A buy is the one row where amountIn is the HBD side. -->
                <td class="num mono">{lc(t.side === "buy" ? t.amountOut : t.amountIn, 3)}</td>
                <!-- THREE DECIMALS, because that is all HBD has. Hive holds it
                     as "1.098 HBD" and MAGI moves it in milli-units — there is
                     no such thing as 0.107721 HBD. Our own contract settles the
                     point: HbdPayMilli rounds DOWN to whole milli, so a payout
                     the engine computed as 0.107721 pays 0.107 and the
                     remainder stays in custody as dust.
                     Six decimals showed precision that never moved. A trade too
                     small to shift a milli now reads 0.000, which is exactly
                     what it paid. -->
                <td class="num mono">{lc(t.side === "buy" ? t.amountIn : t.amountOut, 3)}</td>
                <td class="num mono">{lc(t.lcReserve, 2)}</td>
                <td class="num mono">{lc(t.hbdReserve, 3)}</td>
                <td class="num mono gold">{lc(t.price, 8)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>

<style>
  .hero { display: flex; flex-wrap: wrap; gap: 1.2rem 2.4rem; align-items: flex-end; margin: 0.6rem 0 1.1rem; }
  .price { font-size: clamp(1.9rem, 6vw, 2.6rem); font-weight: 800; color: var(--gold); text-shadow: var(--glow-gold); line-height: 1; }
  .delta .mono { font-size: 1.35rem; font-weight: 700; color: var(--amber); }
  .delta .mono.up { color: var(--green); }
  .unit { font-size: var(--t-micro); letter-spacing: 0.13em; text-transform: uppercase; color: var(--dim); margin-top: 0.45rem; font-family: var(--mono); }

  .stats { display: grid; gap: 1px; margin: 0; background: var(--line-soft); border: 1px solid var(--line-soft); grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
  .stats > div { background: var(--panel-2); padding: 0.6rem 0.8rem; }
  .stats dt { font-size: var(--t-micro); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); font-family: var(--mono); }
  .stats dd { margin: 0.3rem 0 0; font-size: var(--t-tiny); font-variant-numeric: tabular-nums; }

  .chartwrap { overflow-x: auto; }
  svg { display: block; width: 100%; min-width: 32rem; height: auto; }
  .grid { stroke: var(--line-soft); stroke-width: 1; }
  .axis { font-family: var(--mono); font-size: 10px; fill: var(--dim); }

  .legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1.3rem; margin-top: 0.7rem; font-family: var(--mono); font-size: var(--t-micro); color: var(--dim); }
  .legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
  .sw { width: 10px; height: 10px; border-radius: 1px; display: inline-block; }
  .sw.gold { background: var(--gold); } .sw.amber { background: var(--amber); } .sw.cyan { background: var(--cyan); }
  .note { display: block; margin-top: 0.8rem; line-height: 1.55; }

  .scroll { overflow-x: auto; margin-top: 0.7rem; }
  table { border-collapse: collapse; width: 100%; min-width: 44rem; font-size: var(--t-tiny); }
  th { text-align: left; font-family: var(--mono); font-size: var(--t-micro); letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td a { color: var(--ink); }
  td a:hover { color: var(--gold); }
  td { padding: 0.45rem 0.7rem; border-bottom: 1px solid var(--line-soft); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .num { text-align: right; }
  th.num { text-align: right; }
  tbody tr:last-child td { border-bottom: 0; }
  .pill { font-family: var(--mono); font-size: var(--t-micro); padding: 0.08rem 0.4rem; border-radius: 2px; letter-spacing: 0.08em; }
  .pill.buy { color: var(--cyan); border: 1px solid rgba(46, 230, 214, 0.45); }
  .pill.sell { color: var(--amber); border: 1px solid rgba(255, 165, 63, 0.45); }
  .pill.open, .pill.liquidity { color: var(--gold); border: 1px solid var(--gold-dim); }
</style>

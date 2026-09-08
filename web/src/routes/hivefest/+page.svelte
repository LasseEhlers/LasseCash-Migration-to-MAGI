<script lang="ts">
  /**
   * The HiveFest XI stage page — one browser tab, read from the back of a
   * room. Everything on it is READ FROM THE CHAIN while people watch:
   *
   *   - the LASSECASH:HBD price and every trade as it lands (the room trades
   *     during the talk; each swap appears as a tick within a poll);
   *   - the code: the CID the chain reports for the production contract next
   *     to the CID of a build from the public repo (a fresh build reproduces
   *     it — verified 2026-09-09);
   *   - the keys: the owner, the empty update queue, and a live countdown to
   *     the block where the owner key is destroyed.
   *
   * Nothing here derives a value: prices and reserves come from the pool's
   * own settled outputs (client.poolTrades), the countdown is height
   * arithmetic on the chain's clock. Polls every 15 s; nothing is signed.
   */
  import { onMount } from "svelte";
  import { chain, client } from "$lib/chain.svelte.js";
  import { lc, displayName } from "$lib/format.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_OG_IMAGE, SITE_URL, KEY_BURN_HEIGHTS } from "$lib/site.js";
  import type { PoolTrade } from "$api/index.js";

  const CORE = "vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV";
  /** Content hash of a build from the public repo at HEAD (tools/cid.py). */
  const REPO_BUILD_CID = "bafkreihztepfwl5noydp3qab7odgsfvtfetupozxytbxw4uorxqdm5nrsu";
  const POLL_MS = 15_000;

  let trades = $state<PoolTrade[]>([]);
  let error = $state<string | null>(null);
  let chainCid = $state<string | null>(null);
  let owner = $state<string | null>(null);
  let pendingUpdates = $state<number | null>(null);
  let sinceStart = $state(0);      // trades that landed after the page opened
  let baselineCount = $state(-1);
  let now = $state(Date.now());
  let heightAt = $state<{ height: number; at: number } | null>(null);

  const gql = () => {
    const b = client.backend as unknown as { query?: <T>(q: string, v?: Record<string, unknown>) => Promise<T> };
    return typeof b.query === "function" ? b.query.bind(b) : null;
  };

  async function poll() {
    try {
      const [res, info] = await Promise.all([client.poolTrades(), client.chain()]);
      trades = res.trades;
      if (baselineCount < 0) baselineCount = trades.length;
      sinceStart = Math.max(0, trades.length - baselineCount);
      heightAt = { height: info.height, at: Date.now() };
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  async function readContract() {
    const q = gql();
    if (!q) return;
    try {
      const d = await q<{ findContract: { code: string; owner: string }[] | null; findPendingContractUpdates: unknown[] | null }>(
        `query($c: String!) { findContract(filterOptions: {byId: $c}) { code owner }
           findPendingContractUpdates(filterOptions: {byId: $c}) { id } }`, { c: CORE });
      chainCid = d.findContract?.[0]?.code ?? null;
      owner = d.findContract?.[0]?.owner ?? null;
      pendingUpdates = (d.findPendingContractUpdates ?? []).length;
    } catch {
      /* the tiles show "—" until the next poll */
    }
  }

  onMount(() => {
    // ?stage — the projector view: no nav, no banner, no footer. The class is
    // removed on leave so the rest of the site is untouched.
    const stage = new URLSearchParams(location.search).has("stage");
    if (stage) document.documentElement.classList.add("stage-mode");
    poll(); readContract();
    const a = setInterval(poll, POLL_MS);
    const b = setInterval(readContract, POLL_MS * 4);
    const c = setInterval(() => (now = Date.now()), 1000);
    return () => {
      clearInterval(a); clearInterval(b); clearInterval(c);
      document.documentElement.classList.remove("stage-mode");
    };
  });

  const priced = $derived(trades.filter((t) => Number(t.price) > 0));
  const first = $derived(priced[0] ?? null);
  const last = $derived(priced[priced.length - 1] ?? null);
  const swaps = $derived(trades.filter((t) => t.side === "sell" || t.side === "buy"));
  const recent = $derived([...swaps].reverse().slice(0, 6));
  const changePct = $derived.by(() => {
    if (!first || !last) return null;
    const a = Number(first.price), b = Number(last.price);
    return a ? ((b / a - 1) * 100).toFixed(1) : null;
  });
  const low = $derived(priced.length ? priced.reduce((m, t) => (Number(t.price) < Number(m.price) ? t : m)) : null);
  const high = $derived(priced.length ? priced.reduce((m, t) => (Number(t.price) > Number(m.price) ? t : m)) : null);

  /** Same step geometry as /chart: x is real elapsed time, y linear in price. */
  const geom = $derived.by(() => {
    if (priced.length < 2 || !low || !high) return null;
    const t0 = Date.parse(priced[0]!.time + "Z");
    const t1 = Math.max(Date.parse(priced[priced.length - 1]!.time + "Z"), t0 + 1);
    const span = t1 - t0;
    const lo = Number(low.price), hi = Number(high.price);
    const pad = (hi - lo) * 0.15 || hi * 0.15 || 1;
    const yLo = Math.max(0, lo - pad), yHi = hi + pad;
    const x = (t: string) => ((Date.parse(t + "Z") - t0) / span) * 940 + 40;
    const y = (p: string) => 280 - ((Number(p) - yLo) / (yHi - yLo)) * 260;
    let d = ""; let prevY = 0;
    priced.forEach((t, i) => {
      const px = x(t.time), py = y(t.price);
      d += i === 0 ? `M ${px.toFixed(1)} ${py.toFixed(1)}` : ` L ${px.toFixed(1)} ${prevY.toFixed(1)} L ${px.toFixed(1)} ${py.toFixed(1)}`;
      prevY = py;
    });
    d += ` L 980 ${prevY.toFixed(1)}`;
    return {
      line: d, area: `${d} L 980 300 L 40 300 Z`, endY: prevY,
      points: priced.slice(-40).map((t) => ({ t, cx: x(t.time), cy: y(t.price) })),
    };
  });

  /** The chain's clock, carried forward at 3 s per height between polls. */
  const heightNow = $derived(heightAt ? heightAt.height + Math.floor((now - heightAt.at) / 3000) : null);
  const info = $derived(chain.info);
  const burnHeight = $derived(info ? info.genesis_height + KEY_BURN_HEIGHTS : null);
  const secondsToBurn = $derived(burnHeight !== null && heightNow !== null ? Math.max(0, burnHeight - heightNow) * 3 : null);
  const countdown = $derived.by(() => {
    if (secondsToBurn === null) return null;
    const s = secondsToBurn;
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return { d, h, m, sec, burned: s === 0 };
  });
  const cidMatch = $derived(chainCid !== null && chainCid === REPO_BUILD_CID);
  const ago = (iso: string) => {
    const s = Math.max(0, Math.floor((now - Date.parse(iso + "Z")) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  };
</script>

<Seo
  title="HiveFest XI — live"
  description="LasseCash on MAGI, read live from the chain for the HiveFest XI stage: price, every trade, the code hash, and the countdown to the key burn."
  canonical={`${SITE_URL}/hivefest`}
  image={SITE_OG_IMAGE}
/>

<div class="stage">
  <header class="top">
    <div>
      <div class="eyebrow">HiveFest XI · Barcelona · live from MAGI</div>
      <h1>LASSECASH<span class="dim">:HBD</span></h1>
    </div>
    <div class="right">
      <div class="eyebrow">height</div>
      <div class="mono big">{heightNow ?? "—"}</div>
    </div>
  </header>

  {#if error}<p class="err">{error}</p>{/if}

  <section class="tiles">
    <div class="tile hero">
      <div class="label">HBD per LASSECASH</div>
      <div class="value glow">{last ? lc(last.price, 8) : "—"}</div>
      <div class="sub">
        {#if changePct !== null}<span class:red={Number(changePct) < 0} class:green={Number(changePct) >= 0}>{Number(changePct) >= 0 ? "+" : ""}{changePct}%</span> since the pool opened{/if}
      </div>
    </div>
    <div class="tile">
      <div class="label">Trades during this talk</div>
      <div class="value" class:glow={sinceStart > 0}>{sinceStart}</div>
      <div class="sub">{swaps.length} since 31 August</div>
    </div>
    <div class="tile">
      <div class="label">Pool depth</div>
      <div class="value small">{last ? lc(last.lcReserve, 0) : "—"}</div>
      <div class="sub">LASSECASH · {last ? lc(last.hbdReserve, 3) : "—"} HBD · 0% fee, hardcoded</div>
    </div>
  </section>

  <section class="panel chart">
    {#if geom}
      <svg viewBox="0 0 1000 330" role="img" aria-label="LASSECASH:HBD price, every trade">
        <defs>
          <linearGradient id="hg" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="var(--gold)" stop-opacity="0.25" />
            <stop offset="1" stop-color="var(--gold)" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d={geom.area} fill="url(#hg)" />
        <path d={geom.line} fill="none" stroke="var(--gold)" stroke-width="3" stroke-linejoin="round" />
        {#each geom.points as p (p.t.height + p.t.time)}
          <circle cx={p.cx} cy={p.cy} r="5" fill={p.t.side === "buy" ? "var(--cyan)" : p.t.side === "sell" ? "#f0a030" : "var(--gold)"} />
        {/each}
        <circle cx="980" cy={geom.endY} r="9" fill="var(--gold)" class="pulse" />
      </svg>
    {:else}
      <p class="empty">Waiting for the chain…</p>
    {/if}
    <div class="legend"><span class="sw buy"></span> buy — HBD into the pool <span class="sw sell"></span> sell — LASSECASH into the pool</div>
  </section>

  <section class="cols">
    <div class="panel">
      <div class="label">Last trades</div>
      {#if recent.length === 0}
        <p class="empty">No trades yet.</p>
      {:else}
        <ul class="ticker">
          {#each recent as t (t.height + t.time)}
            <li class:fresh={baselineCount >= 0 && trades.indexOf(t) >= baselineCount}>
              <span class="mono who">{displayName(t.trader)}</span>
              {#if t.side === "buy"}
                <span class="cyan">bought</span> <span class="mono">{lc(t.amountOut)}</span> LASSECASH for <span class="mono">{lc(t.amountIn, 3)}</span> HBD
              {:else}
                <span class="orange">sold</span> <span class="mono">{lc(t.amountIn)}</span> LASSECASH for <span class="mono">{lc(t.amountOut, 3)}</span> HBD
              {/if}
              <span class="dim mono">{ago(t.time)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="panel">
      <div class="label">The code</div>
      <div class="row"><span class="dim">chain says</span> <span class="mono cid">{chainCid ?? "—"}</span></div>
      <div class="row"><span class="dim">repo builds</span> <span class="mono cid">{REPO_BUILD_CID}</span></div>
      <div class="verdict" class:green={cidMatch} class:dim={!cidMatch}>{chainCid === null ? "reading…" : cidMatch ? "IDENTICAL — what runs is what is published" : "DIFFERENT"}</div>

      <div class="label mt">The keys</div>
      <div class="row"><span class="dim">owner</span> <span class="mono">{owner ?? "—"}</span></div>
      <div class="row"><span class="dim">queued code updates</span> <span class="mono">{pendingUpdates ?? "—"}</span> <span class="dim">(48 h public notice each)</span></div>
      <div class="row"><span class="dim">owner's recovery account</span> <span class="mono">null</span> <span class="dim">— nobody can restore the key</span></div>
      {#if countdown}
        <div class="label mt">{countdown.burned ? "The key is burned" : "The key burns in"}</div>
        <div class="value glow count">
          {#if countdown.burned}forever{:else}{countdown.d}d {String(countdown.h).padStart(2, "0")}h {String(countdown.m).padStart(2, "0")}m {String(countdown.sec).padStart(2, "0")}s{/if}
        </div>
        <div class="sub">block {burnHeight} · 10 October 2026 · after that: no fix, no new rule, not by anyone</div>
      {/if}
    </div>
  </section>

  <section class="qrs">
    <a class="qr" href="https://altera.magi.eco/swap" target="_blank" rel="noopener">
      <img src="/qr/qr-altera.svg" alt="QR: trade on Altera" />
      <div><strong>Trade on Altera</strong><br /><span class="dim">MAGI's own DEX · altera.magi.eco</span></div>
    </a>
    <a class="qr" href="/pool" target="_blank" rel="noopener">
      <img src="/qr/qr-pool.svg" alt="QR: trade on lassecash.com/pool" />
      <div><strong>Trade on lassecash.com/pool</strong><br /><span class="dim">Keychain · HBD on MAGI · 0% fee</span></div>
    </a>
    <a class="qr" href="https://hivefe.st/program.html#talks18/lasseehlers/hf26-talk-mttaa4c6-2ez" target="_blank" rel="noopener">
      <img src="/qr/qr-talk.svg" alt="QR: this talk on hivefe.st" />
      <div><strong>This talk</strong><br /><span class="dim">♥ it on hivefe.st</span></div>
    </a>
  </section>
</div>

<style>
  .stage { max-width: 1400px; margin: 0 auto; padding: 0.5rem 1rem 2rem; font-size: 1.15rem; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 1rem; }
  .top h1 { font-size: 3rem; margin: 0; letter-spacing: 0.02em; }
  .top .right { text-align: right; }
  .eyebrow { font-family: var(--mono); font-size: 0.8rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--dim); }
  .big { font-size: 1.6rem; }
  .tiles { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
  .tile { border: 1px solid var(--line); background: var(--panel); padding: 1rem 1.25rem; }
  .tile .label, .panel .label { font-family: var(--mono); font-size: 0.8rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); }
  .tile .value { font-family: var(--mono); font-size: 3.6rem; font-weight: 700; line-height: 1.1; margin: 0.2rem 0; }
  .tile .value.small { font-size: 2.4rem; }
  .hero .value { font-size: 5rem; }
  .sub { color: var(--dim); font-size: 1rem; }
  .glow { color: var(--gold); text-shadow: 0 0 18px color-mix(in srgb, var(--gold) 55%, transparent); }
  .panel { border: 1px solid var(--line); background: var(--panel); padding: 1rem 1.25rem; }
  .chart { margin-bottom: 1rem; }
  .chart svg { width: 100%; height: auto; display: block; }
  .pulse { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .legend { color: var(--dim); font-size: 0.95rem; margin-top: 0.4rem; }
  .sw { display: inline-block; width: 0.8em; height: 0.8em; margin: 0 0.3em 0 0.8em; vertical-align: middle; }
  .sw.buy { background: var(--cyan); } .sw.sell { background: #f0a030; }
  .cols { display: grid; grid-template-columns: 1.1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
  .ticker { list-style: none; margin: 0.5rem 0 0; padding: 0; }
  .ticker li { padding: 0.55rem 0; border-top: 1px solid var(--line); font-size: 1.2rem; }
  .ticker li.fresh { color: var(--gold); }
  .who { margin-right: 0.4rem; }
  .row { margin: 0.35rem 0; display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: baseline; }
  .cid { font-size: 0.85rem; word-break: break-all; }
  .verdict { font-family: var(--mono); font-weight: 700; margin-top: 0.4rem; letter-spacing: 0.06em; }
  .mt { margin-top: 1.2rem; }
  .count { font-family: var(--mono); font-size: 2.6rem; font-weight: 700; }
  .qrs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .qr { display: flex; gap: 1rem; align-items: center; border: 1px solid var(--line); background: var(--panel); padding: 0.8rem; color: var(--fg); text-decoration: none; }
  .qr img { width: 150px; height: 150px; background: #fff; padding: 6px; }
  .cyan { color: var(--cyan); } .orange { color: #f0a030; } .green { color: var(--green, #5ad37a); } .red { color: var(--red, #f25f5c); } .dim { color: var(--dim); }
  .err { color: var(--red, #f25f5c); }
  @media (max-width: 900px) {
    .tiles, .cols, .qrs { grid-template-columns: 1fr; }
    .hero .value { font-size: 3rem; } .tile .value { font-size: 2.4rem; } .top h1 { font-size: 2rem; }
  }
</style>

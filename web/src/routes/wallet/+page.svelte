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
  import Seo from "$lib/Seo.svelte";
  import { SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";
  import { fromUnits, type ResourceCredits } from "$api/index.js";

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
  }
  onMount(loadMeters);
  // Signing in on this page should fill the meters without a reload.
  $effect(() => { if (chain.account && !meters) void loadMeters(); });

  const pct = (rc: ResourceCredits | null) =>
    rc && rc.max > 0 ? Math.max(0, Math.min(100, (rc.amount / rc.max) * 100)) : 0;

  /** Under a tenth of the meter is where ordinary actions start being refused. */
  const low = (rc: ResourceCredits | null) => rc !== null && pct(rc) < 10;

  /** HBD on MAGI in milli-units, which IS the MAGI meter above the free 10,000. */
  const hbdOnMagi = $derived(me ? Number(me.hbd) / 100_000_000 : 0);
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
      <h2>Beyond LASSECASH</h2>
      <p class="lede">
        Our pool is <b>LASSECASH:HBD</b> — that is the pair this contract owns and the
        only one it can price. HBD then reaches everything else through MAGI's own
        cross-chain pools, which are separate contracts run by MAGI, not by us.
      </p>
      <div class="routes">
        <a class="route" href="https://altera.magi.eco/swap" target="_blank" rel="noopener">
          <strong>HBD : HIVE</strong>
          <span>Move between Hive's dollar and HIVE.</span>
        </a>
        <a class="route" href="https://altera.magi.eco/swap" target="_blank" rel="noopener">
          <strong>BTC : HBD</strong>
          <span>Bitcoin, on MAGI, against HBD.</span>
        </a>
      </div>
      <p class="note out">
        These open <b>Altera</b>, MAGI's own swap interface. We link rather than rebuild:
        putting our own front end on a contract we do not control means our page breaks
        when theirs changes, and it would hide the fact that you are trading in someone
        else's pool. Both are small — a few thousand dollars each — so check the price
        impact before a large trade, the same way you would here.
      </p>
    </section>
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

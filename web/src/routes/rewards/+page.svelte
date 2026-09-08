<script lang="ts">
  /**
   * Reward pools — where every emitted LASSECASH actually goes.
   *
   * The Chain page shows supply against the cap. This shows the FOUR POOLS
   * that supply flows through, what is sitting in each right now, how fast it
   * is filling, and what it is being divided among. Asked for by Lasse
   * 2026-09-06: "I would like a page where I can see what actually happens in
   * the reward pools".
   *
   * Nothing here is computed by this page. Balances are chain state; the
   * daily split comes from `dailyRewards` in the engine, which is the same
   * closed-form function the contract runs. The one thing this page does that
   * the chain does not is WATCH: it records each pool's balance on load and
   * shows the movement since, which is the only way to see a pool actually
   * being drained rather than merely being large.
   */
  import { chain, client, wallet } from "$lib/chain.svelte.js";
  import { lc, displayName } from "$lib/format.js";
  import { dailyRewards, fromUnits, toUnits } from "$api/index.js";
  import type { PostView } from "$api/index.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";

  const info = $derived(chain.info);

  /** Today's emission, split exactly as the contract splits it. */
  const daily = $derived(
    chain.ready && info && info.genesis_height
      ? dailyRewards(info.genesis_height, info.height)
      : null,
  );

  /**
   * Is emission actually flowing? The accrual walk credits pools through the
   * last COMPLETE day it has settled. If `settled` lags the head by more than
   * a day, nothing is arriving and every "per day" figure below is what the
   * chain WOULD pay once someone calls advance — not what it is paying.
   */
  const behindHeights = $derived(info ? info.height - info.settled_height : 0);
  const behindDays = $derived(Math.floor(behindHeights / 28_800));

  /** Balances as they were when this page opened, so movement is visible. */
  let opened = $state<Record<string, bigint> | null>(null);
  let openedAt = $state(0);
  $effect(() => {
    if (info && !opened) {
      opened = {
        viral: toUnits(info.pool_viral),
        deep: toUnits(info.pool_deep),
        lshare: toUnits(info.pool_lshare),
        liq: toUnits(info.pool_liquidity),
      };
      openedAt = Date.now();
    }
  });

  const pools = $derived.by(() => {
    if (!info) return [];
    return [
      {
        key: "viral",
        name: "Proof-of-Brain — viral",
        share: "12.5% of every block",
        balance: info.pool_viral,
        perDay: daily?.viral ?? null,
        dividedLabel: "rshares voted on open 7-day posts",
        divided: info.rsh_viral,
        drains: "paid out when a post's 7-day window is settled",
      },
      {
        key: "deep",
        name: "Proof-of-Brain — deep",
        share: "37.5% of every block",
        balance: info.pool_deep,
        perDay: daily?.deep ?? null,
        dividedLabel: "rshares voted on open 30-day posts",
        divided: info.rsh_deep,
        drains: "paid out when a post's 30-day window is settled",
      },
      {
        key: "lshare",
        name: "L-Share yield",
        share: "25% of every block",
        balance: info.pool_lshare,
        perDay: daily?.lshare ?? null,
        dividedLabel: "active L-Shares earning",
        divided: info.total_shares,
        drains: "paid when a mint is claimed — and it is the ONLY pool that also RECEIVES, from every early-end slash, every day of bleed and every swept position",
      },
      {
        key: "liq",
        name: "Liquidity",
        share: "25% of every block",
        balance: info.pool_liquidity,
        perDay: daily?.liquidity ?? null,
        dividedLabel: "loyalty-weighted pool shares",
        divided: info.amm_weight,
        drains: "paid when an LP claims or withdraws",
      },
    ];
  });

  /**
   * Every open post and what it would take from its pool RIGHT NOW.
   *
   * `pending_payout` is engine-computed against the live pool — the same
   * `Pool.Claim` the contract runs at settlement: balance x this post's
   * rshares / the window's total. So this is not an estimate of a formula,
   * it is the formula, run against today's balance.
   *
   * It moves for two reasons and both are honest: the pool grows every day,
   * and every new vote anywhere in the window changes the denominator.
   */
  let posts = $state<PostView[]>([]);
  let postsLoaded = $state(false);
  $effect(() => {
    if (!chain.ready) return;
    void (async () => {
      try {
        posts = await client.posts(100);
      } catch {
        posts = [];
      }
      postsLoaded = true;
    })();
  });

  const open = $derived(
    posts
      .filter((p) => !p.paid_out && toUnits(p.pending_payout) > 0n)
      .sort((a, b) => (toUnits(b.pending_payout) > toUnits(a.pending_payout) ? 1 : -1)),
  );
  const owed = $derived(open.reduce((t, p) => t + toUnits(p.pending_payout), 0n));
  const payableNow = $derived(open.filter((p) => p.payable));

  /**
   * Settle a closed window from here, instead of hunting the post.
   *
   * `payout` is permissionless — it pays the AUTHOR and their curators, never
   * the caller, so pressing this is pure housekeeping at your own RC cost.
   * The site normally does it for free by riding up to two settlements along
   * with anyone's vote; this is for when nobody has voted lately and a
   * backlog has built up.
   *
   * NOT frozen by the key burn: `payout` itself is, but who calls it and when
   * is a web page, changeable forever.
   */
  let settling = $state<string | null>(null);
  let settleErr = $state<string | null>(null);

  /**
   * Fund a pool from the signed-in account. This is the operator's proof
   * that `fund` — the door future dApps feed the tokenomics through — works
   * from a real wallet: the pool balance above must rise by exactly the
   * amount, and the native token must debit the funder by the same. The
   * signer bundles the token allowance ahead of the call, as for any debit.
   */
  const TARGET: Record<string, string> = { viral: "viral", deep: "deep", lshare: "lshare", liq: "liquidity" };
  let fundAmt = $state<Record<string, string>>({ viral: "", deep: "", lshare: "", liq: "", all: "" });
  let funding = $state<string | null>(null);
  let fundErr = $state<string | null>(null);
  let fundOk = $state<string | null>(null);
  /**
   * Raw contract call, operator only. Sends exactly what is typed, signed
   * with the ACTIVE key by whoever is signed in, to any contract. Built for
   * the native DEX pool's owner-only `init`, which lasseehlers must sign and
   * no command-line tool here can. Simulate first; this does not.
   */
  let rawContract = $state("");
  let rawAction = $state("");
  let rawPayload = $state("");
  let rawRc = $state("5000");
  let rawBusy = $state(false);
  let rawMsg = $state<string | null>(null);
  let rawErr = $state<string | null>(null);
  async function rawCall() {
    if (!wallet) { rawErr = "wallet mode only"; return; }
    rawBusy = true; rawMsg = null; rawErr = null;
    try {
      const refusal = await chain.submit(() =>
        (wallet as { rawCall: (c: string, a: string, p: string, r: number) => Promise<{ ok: boolean; msg: string; txId?: string }> })
          .rawCall(rawContract.trim(), rawAction.trim(), rawPayload.trim(), Number(rawRc) || 5000));
      if (refusal) rawErr = refusal; else rawMsg = `${rawAction} sent to ${rawContract.slice(0, 14)}…`;
    } catch (e) {
      rawErr = e instanceof Error ? e.message : String(e);
    } finally {
      rawBusy = false;
    }
  }

  async function fund(key: string) {
    const amt = (fundAmt[key] || "").trim();
    if (!amt) return;
    funding = key; fundErr = null; fundOk = null;
    try {
      const refusal = await chain.submit(() => client.fund(TARGET[key] ?? key, amt));
      if (refusal) fundErr = refusal;
      else { fundOk = `${amt} LASSECASH into ${TARGET[key] ?? key}`; fundAmt[key] = ""; }
    } catch (e) {
      fundErr = e instanceof Error ? e.message : String(e);
    } finally {
      funding = null;
    }
  }
  let settled = $state(0);

  async function settle(p: PostView) {
    const key = p.author + "/" + p.permlink;
    settling = key;
    settleErr = null;
    try {
      const refusal = await chain.submit(() => client.payout(p.author, p.permlink));
      if (refusal) {
        settleErr = refusal;
      } else {
        settled += 1;
        posts = await client.posts(100);
      }
    } catch (e) {
      settleErr = e instanceof Error ? e.message : String(e);
    } finally {
      settling = null;
    }
  }

  function moved(key: string, now: string): bigint | null {
    if (!opened) return null;
    return toUnits(now) - (opened[key] ?? 0n);
  }

  /** Per unit of whatever divides the pool — the number that decides a payout. */
  function perUnit(perDay: string | null, divided: string): string | null {
    if (!perDay) return null;
    const d = toUnits(divided);
    if (d <= 0n) return null;
    // Scaled by 1e8 so a per-share figure is readable rather than all zeros.
    return fromUnits((toUnits(perDay) * 100_000_000n) / d);
  }
</script>

<Seo
  title="Reward pools"
  description="Where every emitted LASSECASH goes: the four reward pools, what is in each, how fast they fill and what divides them."
  canonical={`${SITE_URL}/rewards`}
  image={SITE_OG_IMAGE}
/>

<div class="grid">
  <section class="panel intro">
    <h1>Reward pools</h1>
    <p class="note">
      Every block reward is split four ways before anyone is paid. This is what is
      sitting in each pool right now, how fast it fills, and what it gets divided
      among. Balances are chain state; the split is the engine's own function —
      the same one the contract runs.
    </p>
    {#if info}
      <div class="ticks">
        <span>height <b class="mono">{info.height.toLocaleString()}</b></span>
        <span>settled <b class="mono">{info.settled_height.toLocaleString()}</b></span>
        {#if behindDays >= 1}
          <span class="warn">
            accrual is {behindDays} day{behindDays > 1 ? "s" : ""} behind — nothing is
            arriving until someone calls advance
          </span>
        {:else}
          <span class="ok">accrual current</span>
        {/if}
      </div>
    {/if}
  </section>

  {#if !info}
    <section class="panel"><p class="note">Reading the chain…</p></section>
  {:else}
    {#if daily}
      <section class="panel">
        <div class="label">Emitted per day, at this height</div>
        <div class="value gold mono">{lc(daily.total)}</div>
        <p class="note">
          Halves every three years. Split 50% Proof-of-Brain (a quarter of that
          viral, three quarters deep), 25% L-Share yield, 25% liquidity.
        </p>
      </section>
    {/if}

    {#if chain.account}
      <section class="panel fundall">
        <div class="label">Fund all four at the block split</div>
        <p class="note">
          One call, split 12.5% viral · 37.5% deep · 25% L-Share · 25% liquidity,
          exactly as a block reward is. The L-Share slice absorbs any rounding.
        </p>
        <form class="fund" onsubmit={(e) => { e.preventDefault(); fund("all"); }}>
          <input class="mono" inputmode="decimal" placeholder="LASSECASH" bind:value={fundAmt.all}
            disabled={chain.busy || funding !== null} />
          <button class="small" disabled={chain.busy || funding !== null || !fundAmt.all}>
            {funding === "all" ? "Funding…" : "Fund all four"}
          </button>
        </form>
        {#if fundOk}<p class="ok">Funded {fundOk}. Watch the balances above move by exactly that.</p>{/if}
        {#if fundErr}<p class="err">{fundErr}</p>{/if}
      </section>
    {/if}

    {#if chain.account && wallet}
      <section class="panel rawcall">
        <div class="label">Raw contract call — operator only</div>
        <p class="note">
          Sends exactly what you type, signed with your ACTIVE key, to any contract.
          No dry run and no allowance bundling. Simulate it first.
        </p>
        <form class="raw" onsubmit={(e) => { e.preventDefault(); rawCall(); }}>
          <input class="mono" placeholder="contract id (vsc1…)" bind:value={rawContract} disabled={rawBusy} />
          <input class="mono" placeholder="action (e.g. init)" bind:value={rawAction} disabled={rawBusy} />
          <textarea class="mono" placeholder="payload" rows="3" bind:value={rawPayload} disabled={rawBusy}></textarea>
          <div class="row">
            <input class="mono rc" placeholder="rc_limit" bind:value={rawRc} disabled={rawBusy} />
            <button class="small" disabled={rawBusy || !rawContract || !rawAction}>{rawBusy ? "Sending…" : "Send call"}</button>
          </div>
        </form>
        {#if rawMsg}<p class="ok">{rawMsg}</p>{/if}
        {#if rawErr}<p class="err">{rawErr}</p>{/if}
      </section>
    {/if}

    <div class="cards">
      {#each pools as p (p.key)}
        {@const delta = moved(p.key, p.balance)}
        {@const unit = perUnit(p.perDay, p.divided)}
        <section class="panel pool">
          <div class="label">{p.name}</div>
          <div class="value gold mono">{lc(p.balance)}</div>
          <div class="sub">{p.share}</div>

          <dl>
            <div><dt>filling at</dt><dd class="mono">{p.perDay ? lc(p.perDay) : "—"} / day</dd></div>
            <div><dt>{p.dividedLabel}</dt><dd class="mono">{lc(p.divided)}</dd></div>
            {#if unit}
              <div>
                <dt>per unit per day</dt>
                <dd class="mono">{unit} <small class="dim">×1e-8</small></dd>
              </div>
            {/if}
            {#if delta !== null}
              <div>
                <dt>since you opened this page</dt>
                <dd class="mono" class:up={delta > 0n} class:down={delta < 0n}>
                  {delta > 0n ? "+" : ""}{fromUnits(delta)}
                </dd>
              </div>
            {/if}
          </dl>
          <p class="note drain">{p.drains}</p>
          {#if chain.account}
            <form class="fund" onsubmit={(e) => { e.preventDefault(); fund(p.key); }}>
              <input
                class="mono"
                inputmode="decimal"
                placeholder="LASSECASH"
                bind:value={fundAmt[p.key]}
                disabled={chain.busy || funding !== null}
              />
              <button class="small" disabled={chain.busy || funding !== null || !fundAmt[p.key]}>
                {funding === p.key ? "Funding…" : "Fund this pool"}
              </button>
            </form>
          {/if}
        </section>
      {/each}
    </div>

    <section class="panel">
      <div class="label">Open posts and what they would take right now</div>
      {#if !postsLoaded}
        <p class="note">Reading posts…</p>
      {:else if open.length === 0}
        <p class="note">
          Nothing is currently owed: no open post has any votes on it, so the two
          Proof-of-Brain pools have nobody to divide among and simply keep growing.
        </p>
      {:else}
        <p class="note">
          <b class="mono">{lc(fromUnits(owed))}</b> of the two Proof-of-Brain pools
          is already spoken for by {open.length} open post{open.length > 1 ? "s" : ""}.
          {#if payableNow.length > 0}
            <b class="warn">{payableNow.length} can be settled now</b> — the window
            has closed and anyone may trigger the payout.
          {/if}
          Each figure is the contract's own formula against today's balance, so it
          moves as the pool fills and as new votes change the denominator.
        </p>
        {#if !chain.account}
          <p class="note dim">Sign in to settle a closed window from here.</p>
        {/if}
        {#if settleErr}<p class="err">{settleErr}</p>{/if}
        {#if settled > 0}
          <p class="note ok">
            Settled {settled} post{settled > 1 ? "s" : ""}. The author and their
            curators are paid; you paid only the resource credits.
          </p>
        {/if}
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>post</th><th>pool</th><th class="num">rshares</th>
                <th class="num">would take</th><th>settles</th><th></th>
              </tr>
            </thead>
            <tbody>
              {#each open.slice(0, 30) as p (p.author + "/" + p.permlink)}
                <tr>
                  <td>
                    <a href="/@{p.author}/{p.permlink}">{p.title || p.permlink}</a>
                    <span class="dim">@{displayName(p.author)}</span>
                  </td>
                  <td><span class="pill">{p.window}</span></td>
                  <td class="num mono">{lc(p.rshares, 0)}</td>
                  <td class="num mono gold">{lc(p.pending_payout)}</td>
                  <td class:warn={p.payable}>
                    {p.payable ? "ready now" : p.payout_time.slice(0, 10)}
                  </td>
                  <td>
                    {#if p.payable && chain.account}
                      <button
                        class="small"
                        onclick={() => settle(p)}
                        disabled={chain.busy || settling !== null}
                      >
                        {settling === p.author + "/" + p.permlink ? "Settling…" : "Settle"}
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="panel">
      <p class="note">
        <b>Why a pool can sit still.</b> A pool only pays when something claims from
        it: a post's window closing, a mint being claimed, an LP claiming. Between
        those it just grows. The L-Share pool is the exception in the other
        direction — it also collects every slashed early end, every day of bleed and
        every swept dead position, which is what funds rewards after emission ends
        in year 75.
      </p>
      {#if openedAt}
        <p class="note dim">
          Watching since {new Date(openedAt).toLocaleTimeString()}. The page re-reads
          the chain every 30 seconds.
        </p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .grid { display: flex; flex-direction: column; gap: 1rem; }
  .intro h1 { margin: 0 0 0.4rem; font-size: 1.4rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
  .ticks { display: flex; flex-wrap: wrap; gap: 0.9rem; margin-top: 0.6rem; font-size: var(--t-micro); }
  .ticks .ok { color: var(--green); }
  .ticks .warn { color: var(--gold); }
  .pool dl { margin: 0.9rem 0 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .pool dl > div { display: flex; justify-content: space-between; gap: 0.8rem; align-items: baseline; }
  .pool dt { color: var(--dim); font-size: var(--t-micro); }
  .pool dd { margin: 0; font-size: var(--t-sm); }
  .pool dd.up { color: var(--green); }
  .pool dd.down { color: var(--gold); }
  .err { color: var(--red); font-size: var(--t-sm); margin: 0.5rem 0 0; }
  .ok { color: var(--green); font-size: var(--t-sm); margin: 0.5rem 0 0; }
  form.fund { display: flex; gap: 0.5rem; margin-top: 0.7rem; }
  form.fund input { flex: 1; min-width: 0; background: #0d1117; border: 1px solid var(--line); color: var(--fg); padding: 0.35rem 0.5rem; border-radius: 4px; }
  .fundall { margin-bottom: 1rem; }
  .rawcall { margin-bottom: 1rem; border-color: color-mix(in srgb, var(--gold) 35%, var(--line)); }
  form.raw { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.6rem; }
  form.raw input, form.raw textarea { background: #0d1117; border: 1px solid var(--line); color: var(--fg); padding: 0.4rem 0.5rem; border-radius: 4px; width: 100%; box-sizing: border-box; }
  form.raw .row { display: flex; gap: 0.5rem; }
  form.raw .rc { max-width: 140px; }
  .ok { color: var(--green); }
  .pill { font-size: var(--t-micro); border: 1px solid var(--line); border-radius: 4px; padding: 0.05rem 0.3rem; }
  .warn { color: var(--gold); }
  .drain { margin-top: 0.8rem; padding-top: 0.7rem; border-top: 1px solid var(--line-soft); }
</style>

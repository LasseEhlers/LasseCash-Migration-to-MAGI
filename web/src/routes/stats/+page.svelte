<script lang="ts">
  /**
   * STATS, LAYER 1 — the living economy since launch.
   *
   * Three layers, each one click deeper:
   *   /stats            this page: who is using it now
   *   /stats/migration  who claimed what was theirs, and what they did next
   *   /check            the frozen snapshot: who was entitled to what
   *
   * The migration was the launch story. A month in, the question a newcomer
   * actually asks is "is anyone using this?", and the answer should name
   * people, not just count them — which is what made "Who showed up" work.
   *
   * NOTHING IS DERIVED HERE. Every figure is a chain record read raw and
   * summed: mint records (principal | shares | start | days | ga | ended),
   * LP tranches through `allTranches()` (which asks the engine for value and
   * loyalty), and the transaction log grouped by signer. Summing records is
   * aggregation, not a second implementation of anything.
   *
   * "Since launch" is literal while the whole log fits the read cap: on
   * 2026-10-03 it was 318 transactions. If the walk ever stops at the cap the
   * page says so, and the indexer is what lifts it.
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { lc } from "$lib/format.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_URL } from "$lib/site.js";

  const ACTIVITY_CAP = 3000;
  /** Protocol accounts are not people turning up. */
  const NOT_PEOPLE = new Set(["hive:lassecashmagi", "hive:null"]);

  type MintRow = {
    account: string; made: number; open: number;
    minted: bigint; locked: bigint; shares: bigint; longest: number;
  };
  type LpRow = { account: string; positions: number; share: number; oldest: number };
  type MediaRow = { account: string; posts: number; replies: number; votes: number };

  let loaded = $state(false);
  let error = $state<string | null>(null);
  let capped = $state(false);

  let active = $state(0);
  let active7 = $state(0);
  let totals = $state({ posts: 0, replies: 0, votes: 0, swaps: 0, mints: 0 });
  let mints = $state<MintRow[]>([]);
  let lps = $state<LpRow[]>([]);
  let media = $state<MediaRow[]>([]);

  /** Base units (1e8) to a decimal string, exactly — no float in between. */
  const dec = (v: bigint): string => {
    const neg = v < 0n; const s = (neg ? -v : v).toString().padStart(9, "0");
    return (neg ? "-" : "") + s.slice(0, -8) + "." + s.slice(-8);
  };
  const amt = (v: bigint) => lc(dec(v), 2);
  const tsMs = (t: string) => Date.parse(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : t + "Z");

  async function load() {
    try {
      const info = chain.info!;
      const [activity, snapshot, tranches] = await Promise.all([
        client.activity(ACTIVITY_CAP),
        fetch("/admin-data.json").then((r) => r.ok ? r.json() : { migrated: [] })
          .catch(() => ({ migrated: [] })) as Promise<{ migrated: { account: string }[] }>,
        client.allTranches().catch(() => []),
      ]);
      const people = activity.filter((a) => !NOT_PEOPLE.has(a.account));
      capped = people.reduce((t, a) => t + a.calls, 0) >= ACTIVITY_CAP;

      // --- activity -------------------------------------------------------
      const weekAgo = Date.now() - 7 * 86_400_000;
      active = people.length;
      active7 = people.filter((a) => tsMs(a.lastSeen) >= weekAgo).length;
      const n = (a: (typeof people)[number], ...ks: string[]) =>
        ks.reduce((t, k) => t + (a.actions[k] ?? 0), 0);
      totals = {
        posts: people.reduce((t, a) => t + n(a, "post"), 0),
        replies: people.reduce((t, a) => t + n(a, "comment"), 0),
        votes: people.reduce((t, a) => t + n(a, "vote"), 0),
        swaps: people.reduce((t, a) => t + n(a, "swap_lassecash_hbd", "swap_hbd_lassecash", "swap_lc_hbd", "swap_hbd_lc"), 0),
        mints: people.reduce((t, a) => t + n(a, "mint"), 0),
      };
      media = people
        .map((a) => ({ account: a.account, posts: n(a, "post"), replies: n(a, "comment"), votes: n(a, "vote") }))
        .filter((r) => r.posts + r.replies + r.votes > 0)
        .sort((a, b) => (b.posts * 3 + b.replies * 2 + b.votes) - (a.posts * 3 + a.replies * 2 + a.votes));

      // --- mints made since launch ---------------------------------------
      // A migration mint starts at the genesis height by construction; every
      // other mint — by hand, or the monthly mint of post earnings — starts at
      // the height it was made. That is the whole test.
      const universe = [...new Set([
        ...snapshot.migrated.map((m) => `hive:${m.account}`),
        ...people.map((a) => a.account),
      ])].filter((a) => !NOT_PEOPLE.has(a));
      const seqs = await client.state(universe.map((a) => `mseq_${a}`));
      const keys: string[] = [];
      for (const a of universe) {
        const seq = Number(seqs[`mseq_${a}`] || 0);
        for (let id = 1; id <= seq; id++) keys.push(`mint_${a}_${id}`);
      }
      const recs = keys.length ? await client.state(keys) : {};
      const byAcct = new Map<string, MintRow>();
      for (const k of keys) {
        const raw = recs[k]; if (!raw) continue;
        const f = raw.split("|");
        if (Number(f[2] || 0) === info.genesis_height) continue; // migration mint
        const account = k.slice(5, k.lastIndexOf("_"));
        const r = byAcct.get(account) ?? { account, made: 0, open: 0, minted: 0n, locked: 0n, shares: 0n, longest: 0 };
        r.made += 1;
        r.minted += BigInt(f[0] || "0");
        if (f[5] !== "1") {
          r.open += 1;
          r.locked += BigInt(f[0] || "0");
          r.shares += BigInt(f[1] || "0");
        }
        r.longest = Math.max(r.longest, Number(f[3] || 0));
        byAcct.set(account, r);
      }
      // What is locked NOW first (Lasse, 2026-10-04): live commitment is what
      // a reader wants. Finished mints follow, by what they minted — a mint
      // held to maturity and claimed is a success, so it stays listed.
      mints = [...byAcct.values()].sort((a, b) =>
        b.locked !== a.locked ? (b.locked > a.locked ? 1 : -1)
        : b.minted !== a.minted ? (b.minted > a.minted ? 1 : -1) : b.made - a.made);

      // --- liquidity -----------------------------------------------------
      const lpBy = new Map<string, LpRow>();
      for (const t of tranches) {
        const r = lpBy.get(t.owner) ?? { account: t.owner, positions: 0, share: 0, oldest: 0 };
        r.positions += 1;
        r.share += t.share;
        r.oldest = Math.max(r.oldest, t.ageDays);
        lpBy.set(t.owner, r);
      }
      lps = [...lpBy.values()].sort((a, b) => b.share - a.share);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loaded = true;
    }
  }

  $effect(() => { if (chain.info && !loaded && !error) void load(); });

  const sumLocked = $derived(mints.reduce((t, r) => t + r.locked, 0n));
  const sumMinted = $derived(mints.reduce((t, r) => t + r.minted, 0n));
  const name = (a: string) => a.replace(/^hive:/, "");
  const top = <T,>(xs: T[], k = 10) => xs.slice(0, k);
  let allMints = $state(false);
  let allMedia = $state(false);
</script>

<Seo
  title="Stats — who is using LasseCash"
  description="Live from the chain: who has minted since launch, who provides liquidity, and who posts and votes on LasseCash."
  canonical={`${SITE_URL}/stats`}
/>

<h1>Stats</h1>
<p class="lede dim">
  Everything since launch on 31 August, read live from the chain.
  {#if capped}<b>Showing the most recent {ACTIVITY_CAP.toLocaleString()} transactions.</b>{/if}
</p>

{#if error}
  <div class="panel"><p class="red"><strong>Could not load.</strong> {error}</p></div>
{:else if !loaded}
  <div class="panel"><p class="dim">Reading the chain…</p></div>
{:else}
  <div class="panel summary">
    <div><dt>Active accounts</dt><dd class="mono gold">{active}</dd>
      <dd class="dim">{active7} in the last 7 days</dd></div>
    <div><dt>Minted since launch</dt><dd class="mono gold">{amt(sumMinted)}</dd>
      <dd class="dim">by {mints.length} accounts, {amt(sumLocked)} still locked</dd></div>
    <div><dt>Pool</dt><dd class="mono gold">{lc(chain.info?.amm_lc ?? "0", 0)}</dd>
      <dd class="dim">LASSECASH + {lc(chain.info?.amm_hbd ?? "0", 3)} HBD, {lps.length} providers</dd></div>
    <div><dt>LasseMedia</dt><dd class="mono gold">{totals.posts + totals.replies}</dd>
      <dd class="dim">posts and replies, {totals.votes} votes</dd></div>
  </div>

  <div class="cols">
    <section class="panel">
      <h2>Minted since launch <span class="dim">— {mints.length}</span></h2>
      <p class="note dim">
        Mints made after the migration: by hand, or the monthly mint of post and
        curation earnings. Migration mints are on the <a href="/stats/migration">migration page</a>.
      </p>
      {#if mints.length === 0}
        <p class="dim">No new mints yet.</p>
      {:else}
        <div class="scroll">
          <table>
            <thead><tr>
              <th class="num">#</th><th>Account</th><th class="num">Mints</th>
              <th class="num">Locked now</th><th class="num">L-Shares</th><th class="num">Minted</th><th class="num">Longest</th>
            </tr></thead>
            <tbody>
              {#each (allMints ? mints : top(mints, 15)) as r, i}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td><a href="/@{name(r.account)}">@{name(r.account)}</a></td>
                  <td class="num mono">{r.made}{#if r.open < r.made}<span class="dim"> ({r.open} open)</span>{/if}</td>
                  <td class="num mono" class:gold={r.locked > 0n} class:zero={r.locked === 0n}>{r.locked === 0n ? "claimed" : amt(r.locked)}</td>
                  <td class="num mono" class:zero={r.shares === 0n}>{amt(r.shares)}</td>
                  <td class="num mono dim">{amt(r.minted)}</td>
                  <td class="num mono dim">{r.longest} d</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if mints.length > 15}
          <button onclick={() => allMints = !allMints}>{allMints ? "Show fewer" : `Show all ${mints.length}`}</button>
        {/if}
      {/if}
    </section>

    <section class="panel">
      <h2>Liquidity providers <span class="dim">— {lps.length}</span></h2>
      <p class="note dim">Open positions in the LASSECASH:HBD pool. Each position earns more the longer it stays, up to 90 days.</p>
      {#if lps.length === 0}
        <p class="dim">No open positions.</p>
      {:else}
        <div class="scroll">
          <table>
            <thead><tr>
              <th class="num">#</th><th>Account</th><th class="num">Positions</th>
              <th class="num">Pool share</th><th class="num">Oldest</th>
            </tr></thead>
            <tbody>
              {#each lps as r, i}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td><a href="/@{name(r.account)}">@{name(r.account)}</a></td>
                  <td class="num mono">{r.positions}</td>
                  <td class="num mono gold">{(r.share * 100).toFixed(2)}%</td>
                  <td class="num mono dim">{r.oldest} d</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <p class="more"><a href="/pool">Pool and chart →</a></p>
    </section>
  </div>

  <section class="panel media">
    <h2>LasseMedia <span class="dim">— {media.length} accounts</span></h2>
    <p class="note dim">
      {totals.posts} posts published, {totals.replies} replies and {totals.votes} votes made on
      LasseCash since launch. Posts from other Hive sites join when their first vote registers them.
    </p>
    {#if media.length}
      <div class="scroll">
        <table>
          <thead><tr>
            <th class="num">#</th><th>Account</th><th class="num">Posts</th>
            <th class="num">Replies</th><th class="num">Votes</th>
          </tr></thead>
          <tbody>
            {#each (allMedia ? media : top(media, 15)) as r, i}
              <tr>
                <td class="num dim">{i + 1}</td>
                <td><a href="/@{name(r.account)}">@{name(r.account)}</a></td>
                <td class="num mono" class:zero={!r.posts}>{r.posts}</td>
                <td class="num mono" class:zero={!r.replies}>{r.replies}</td>
                <td class="num mono" class:zero={!r.votes}>{r.votes}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if media.length > 15}
        <button onclick={() => allMedia = !allMedia}>{allMedia ? "Show fewer" : `Show all ${media.length}`}</button>
      {/if}
    {/if}
    <p class="more"><a href="/feed">Read the feed →</a></p>
  </section>
{/if}

<a class="panel layer" href="/stats/migration">
  <span>
    <strong>The migration: who showed up</strong>
    <span class="dim">Who claimed their Hive-Engine LASSECASH, who has not yet, and what each did next. One level deeper: the full snapshot.</span>
  </span>
  <span class="arrow">→</span>
</a>

<style>
  h1 { margin: 0 0 .3rem; }
  .lede { margin: 0 0 1.2rem; font-size: .9rem; }
  h2 { font-size: 1rem; margin: 0 0 .5rem; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 1rem; margin-bottom: 1rem; }
  .summary dt { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .summary dd { margin: .2rem 0 0; font-size: 1.25rem; }
  .summary dd.dim { font-size: .75rem; }
  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 1rem; align-items: start; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .media { margin-top: 1rem; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  th { text-align: left; font-weight: normal; color: var(--dim); font-size: .7rem;
       text-transform: uppercase; letter-spacing: .06em; padding: .35rem .5rem; }
  td { padding: .35rem .5rem; border-top: 1px solid var(--rule); }
  .num { text-align: right; }
  .mono { font-variant-numeric: tabular-nums; }
  td.gold, dd.gold { color: var(--gold); }
  .zero { color: var(--dim); }
  .note { font-size: .75rem; margin: 0 0 .75rem; }
  .note a, .more a { text-decoration: underline; text-underline-offset: 2px; }
  .more { margin: .75rem 0 0; font-size: .8rem; }
  button { margin-top: .75rem; }
  .layer { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
           margin-top: 1rem; text-decoration: none; color: inherit; border: 1px solid var(--gold-dim); }
  .layer:hover, .layer:focus-visible { border-color: var(--gold); }
  .layer strong { display: block; color: var(--gold); margin-bottom: .2rem; }
  .layer .dim { font-size: .85rem; }
  .layer .arrow { font-size: 1.4rem; color: var(--gold); }
  .red { color: var(--red); }
</style>

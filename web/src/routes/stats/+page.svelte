<script lang="ts">
  /**
   * WHO ACTUALLY SHOWED UP — the migration, one row per account.
   *
   * The Snapshot page answers "who was entitled to what". This one answers the
   * question that matters after launch: of those people, who turned up, and
   * what did they do once they got here? A balance says someone was given
   * tokens seven years ago. A row of actions says someone is here now.
   *
   * PRIVATE BY NOT BEING DEPLOYED — see +page.ts. Every figure is on-chain, but
   * a sorted leaderboard with an activity profile attached is a different thing
   * from data that is technically queryable, and shipping it is a decision.
   *
   * THREE SOURCES, none of them derived here:
   *   admin-data.json   the committed snapshot — who was entitled to what
   *   contract state    mig_ (claim receipt), shr_ (LIVE voting weight)
   *   transactions      every confirmed call, attributed to its signer
   *
   * `shr_` is LIVE weight, not weight-at-claim: a mint's shares retire at
   * maturity, so on 30 September this column falls to near zero for everyone
   * holding only a migration mint. That is the day-30 cliff, and seeing it
   * arrive here is the point of the column existing.
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { lc } from "$lib/format.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_URL } from "$lib/site.js";

  const U = 100_000_000n;

  /**
   * One letter per KIND of thing done, not per entrypoint. Nobody reading a
   * table wants to distinguish swap_lc_hbd from swap_hbd_lc at a glance; they
   * want to know the account has traded.
   */
  const KINDS: { key: string; letter: string; label: string; actions: string[] }[] = [
    { key: "claim", letter: "C", label: "Claimed", actions: ["claim_migration"] },
    { key: "post",  letter: "P", label: "Posted", actions: ["post"] },
    { key: "reply", letter: "R", label: "Replied", actions: ["comment"] },
    { key: "vote",  letter: "V", label: "Voted", actions: ["vote"] },
    { key: "mint",  letter: "M", label: "Minted", actions: ["mint", "claim_mint", "good_accounting", "set_duration"] },
    { key: "lp",    letter: "L", label: "Liquidity", actions: ["add_liquidity", "remove_liquidity", "claim_pool"] },
    { key: "swap",  letter: "S", label: "Swapped", actions: ["swap_lc_hbd", "swap_hbd_lc"] },
    { key: "send",  letter: "T", label: "Transferred", actions: ["transfer"] },
    { key: "burn",  letter: "B", label: "Burned / promoted", actions: ["burn", "promote_post"] },
    { key: "gov",   letter: "G", label: "Thresholds", actions: ["set_param", "promote"] },
  ];

  type Row = {
    account: string;
    entitledLiquid: bigint;
    entitledStaked: bigint;
    entitledTotal: bigint;
    claimed: boolean;
    sharesNow: bigint;
    kinds: string[];
    calls: number;
    lastSeen: string;
  };

  let rows = $state<Row[] | null>(null);
  let error = $state<string | null>(null);
  let showAllClaimed = $state(false);
  let showAllUnclaimed = $state(false);

  async function load() {
    try {
      const res = await fetch("/admin-data.json");
      if (!res.ok) throw new Error(`admin-data.json: HTTP ${res.status}`);
      const file = await res.json() as {
        migrated: { account: string; liquid: number; staked: number; total: number }[];
      };

      const accounts = file.migrated.map((m) => `hive:${m.account}`);
      // Two reads per account. `state()` batches internally — getStateByKeys
      // refuses a request outside 1..100 keys, and 418 accounts is well past it.
      const [st, activity] = await Promise.all([
        client.state([...accounts.map((a) => `mig_${a}`), ...accounts.map((a) => `shr_${a}`)]),
        client.activity(3000),
      ]);

      const acts = new Map(activity.map((a) => [a.account, a]));

      rows = file.migrated.map((m) => {
        const q = `hive:${m.account}`;
        const act = acts.get(q);
        const kinds = act
          ? KINDS.filter((k) => k.actions.some((a) => (act.actions[a] ?? 0) > 0)).map((k) => k.letter)
          : [];
        return {
          account: m.account,
          entitledLiquid: BigInt(m.liquid),
          entitledStaked: BigInt(m.staked),
          entitledTotal: BigInt(m.total),
          // The receipt is the claim. A missing key is unclaimed; an empty
          // string is ALSO missing on MAGI, which is why this tests truthiness
          // rather than `!== undefined`.
          claimed: !!st[`mig_${q}`],
          sharesNow: BigInt(st[`shr_${q}`] || "0"),
          kinds,
          calls: act?.calls ?? 0,
          lastSeen: act?.lastSeen ?? "",
        };
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => { if (chain.info && !rows && !error) void load(); });

  const claimed = $derived((rows ?? []).filter((r) => r.claimed)
    .sort((a, b) => (b.entitledTotal > a.entitledTotal ? 1 : -1)));
  const unclaimed = $derived((rows ?? []).filter((r) => !r.claimed)
    .sort((a, b) => (b.entitledTotal > a.entitledTotal ? 1 : -1)));

  const sum = (xs: Row[]) => xs.reduce((t, r) => t + r.entitledTotal, 0n);
  const amt = (v: bigint) => lc((Number(v) / Number(U)).toFixed(8), 2);
  const pct = (a: bigint, b: bigint) => b === 0n ? "0.0" : (Number(a) / Number(b) * 100).toFixed(1);
</script>

<Seo
  title="Who showed up"
  description="Migration claims and on-chain activity."
  canonical={`${SITE_URL}/stats`}
  noindex
/>

<h1>Who showed up</h1>

{#if error}
  <div class="panel"><p class="red"><strong>Could not load.</strong> {error}</p></div>
{:else if !rows}
  <div class="panel"><p class="dim">Reading the chain…</p></div>
{:else}
  <div class="panel summary">
    <div><dt>Claimed</dt><dd class="mono gold">{claimed.length}</dd><dd class="dim">of {rows.length} accounts</dd></div>
    <div><dt>Supply claimed</dt><dd class="mono gold">{amt(sum(claimed))}</dd>
      <dd class="dim">{pct(sum(claimed), sum(rows))}% of entitled</dd></div>
    <div><dt>Still unclaimed</dt><dd class="mono">{amt(sum(unclaimed))}</dd>
      <dd class="dim">{unclaimed.length} accounts</dd></div>
    <div><dt>Have done something</dt><dd class="mono gold">{claimed.filter((r) => r.calls > 1).length}</dd>
      <dd class="dim">beyond claiming</dd></div>
  </div>

  <p class="legend">
    {#each KINDS as k}<span><b>{k.letter}</b> {k.label}</span>{/each}
  </p>

  <div class="cols">
    <section class="panel">
      <h2>Claimed <span class="dim">— {claimed.length}</span></h2>
      <div class="scroll">
        <table>
          <thead><tr>
            <th class="num">#</th><th>Account</th>
            <th class="num">LASSECASH</th><th class="num">L-Shares at claim</th>
            <th class="num">L-Shares now</th><th>Did</th>
          </tr></thead>
          <tbody>
            {#each (showAllClaimed ? claimed : claimed.slice(0, 40)) as r, i}
              <tr>
                <td class="num dim">{i + 1}</td>
                <td><a href="/@{r.account}">@{r.account}</a></td>
                <td class="num mono">{amt(r.entitledTotal)}</td>
                <td class="num mono dim">{amt(r.entitledStaked)}</td>
                <td class="num mono" class:zero={r.sharesNow === 0n}>{amt(r.sharesNow)}</td>
                <td class="kinds">
                  {#each r.kinds as k}<b>{k}</b>{/each}
                  {#if r.kinds.length <= 1}<span class="dim">— claim only</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if claimed.length > 40}
        <button onclick={() => showAllClaimed = !showAllClaimed}>
          {showAllClaimed ? "Show fewer" : `Show all ${claimed.length}`}
        </button>
      {/if}
    </section>

    <section class="panel">
      <h2>Not claimed <span class="dim">— {unclaimed.length}</span></h2>
      <div class="scroll">
        <table>
          <thead><tr>
            <th class="num">#</th><th>Account</th>
            <th class="num">LASSECASH</th><th class="num">L-Shares waiting</th>
          </tr></thead>
          <tbody>
            {#each (showAllUnclaimed ? unclaimed : unclaimed.slice(0, 40)) as r, i}
              <tr>
                <td class="num dim">{i + 1}</td>
                <td><a href="/@{r.account}">@{r.account}</a></td>
                <td class="num mono">{amt(r.entitledTotal)}</td>
                <td class="num mono dim">{amt(r.entitledStaked)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if unclaimed.length > 40}
        <button onclick={() => showAllUnclaimed = !showAllUnclaimed}>
          {showAllUnclaimed ? "Show fewer" : `Show all ${unclaimed.length}`}
        </button>
      {/if}
    </section>
  </div>
{/if}

<style>
  h1 { margin: 0 0 1rem; }
  h2 { font-size: 1rem; margin: 0 0 .75rem; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 1rem; }
  .summary dt { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .summary dd { margin: .2rem 0 0; font-size: 1.25rem; }
  .summary dd.dim { font-size: .75rem; }
  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 1rem; align-items: start; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  th { text-align: left; font-weight: normal; color: var(--dim); font-size: .7rem;
       text-transform: uppercase; letter-spacing: .06em; padding: .35rem .5rem; }
  td { padding: .35rem .5rem; border-top: 1px solid var(--rule); }
  .num { text-align: right; }
  .mono { font-variant-numeric: tabular-nums; }
  /* Zero live weight is the day-30 cliff arriving, not an error — dim, never red. */
  .zero { color: var(--dim); }
  .kinds b { display: inline-block; min-width: 1.1em; text-align: center; color: var(--gold);
             font-family: inherit; font-size: .75rem; }
  .legend { display: flex; flex-wrap: wrap; gap: .25rem 1rem; font-size: .7rem; color: var(--dim); margin: 1rem 0; }
  .legend b { color: var(--gold); margin-right: .25rem; }
  button { margin-top: .75rem; }
  .red { color: var(--red); }
</style>

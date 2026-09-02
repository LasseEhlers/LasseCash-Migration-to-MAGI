<script lang="ts">
  /**
   * WHO ACTUALLY SHOWED UP — the migration, one row per account.
   *
   * The Snapshot page answers "who was entitled to what". This one answers the
   * question that matters after launch: of those people, who turned up, and
   * what did they do once they got here? A balance says someone was given
   * tokens seven years ago. A row of actions says someone is here now.
   *
   * PUBLIC, and in the nav. It started life as a private console; the argument
   * that retired that idea is the same one that made the snapshot public — the
   * public deserves to watch the progress on the same terms the founder does,
   * and a figure volunteered is a disclosure while the same figure discovered
   * is an expose.
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

  /**
   * SHOWED UP — active on the chain with nothing in the snapshot.
   *
   * The most important number on this page, and until now it was invisible.
   * Everyone in the tables above was GIVEN something: they had a balance on
   * Hive-Engine and came to collect it. These people had nothing to collect
   * and used it anyway — @condeas bought LASSECASH with HBD and put it
   * straight into the pool, ninety minutes after a letter he had never asked
   * for.
   *
   * That is the difference between a migration and a product, so it gets its
   * own list rather than being folded into a total.
   */
  type Newcomer = {
    account: string;
    balance: bigint;
    shares: bigint;
    kinds: string[];
    calls: number;
  };
  let newcomers = $state<Newcomer[]>([]);

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
        client.state([
          ...accounts.map((a) => `mig_${a}`),
          ...accounts.map((a) => `shr_${a}`),
        ]),
        client.activity(3000),
      ]);

      const acts = new Map(activity.map((a) => [a.account, a]));

      // WHAT THIS PAGE DELIBERATELY DOES NOT READ.
      //
      // It used to show what each account had earned and not yet taken, which
      // meant reading pend_ and mseq_ for all 418 accounts and then every mint
      // record behind them — roughly double the chain reads, for a column of
      // near-zeros this early and one summary figure.
      //
      // Removed 2026-09-02 for the speed. The engine bridge that computed it
      // (entitlement) is untouched and the mint keys are documented above, so
      // it is a re-add rather than a rebuild if the numbers ever get big
      // enough to be worth the wait.
      // SHOWED UP — active on the chain with nothing in the snapshot.
      //
      // Everyone in the tables above was GIVEN something: they held LASSECASH
      // on Hive-Engine and came to collect it. These people had nothing to
      // collect and used the chain anyway, which is the only evidence that the
      // thing pulls rather than being pushed.
      //
      // The owner is excluded: init and set_snapshot are genesis transactions,
      // not somebody turning up.
      //
      // ⚠️ DELETED BY ACCIDENT 2026-09-02 and restored. Removing the `earned`
      // computation cut a slice of code between two markers, and this block
      // sat inside that slice — the markup survived, `newcomers` stayed empty,
      // and the section silently stopped rendering. Nothing failed and no test
      // caught it. If this ever moves again, move it deliberately.
      const known = new Set(file.migrated.map((m) => `hive:${m.account}`));
      const strangers = activity
        .map((a) => a.account)
        .filter((a) => !known.has(a) && a !== "hive:lassecashmagi");
      if (strangers.length) {
        const st2 = await client.state([
          ...strangers.map((a) => `bal_${a}`),
          ...strangers.map((a) => `shr_${a}`),
        ]);
        newcomers = strangers
          .map((a) => {
            const act = acts.get(a);
            return {
              account: a.replace(/^hive:/, ""),
              balance: BigInt(st2[`bal_${a}`] || "0"),
              shares: BigInt(st2[`shr_${a}`] || "0"),
              kinds: act
                ? KINDS.filter((k) => k.actions.some((x) => (act.actions[x] ?? 0) > 0)).map((k) => k.letter)
                : [],
              calls: act?.calls ?? 0,
            };
          })
          .sort((a, b) => (b.balance > a.balance ? 1 : -1));
      }

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

  // DUST IS NOT A MISSING PERSON. 65 accounts qualified holding exactly
  // nothing and another 110 hold 13.46 LC between them, so a raw "405 have
  // not claimed" overstates the gap by about 40% — and the real picture is
  // the opposite: 82 accounts hold 99.2% of everything outstanding. One LC is
  // the line because it is also the contract's own: balances under 1 LC roll
  // over rather than minting, so below it there is nothing to mint either.
  const DUST = 100_000_000n;
  const allUnclaimed = $derived((rows ?? []).filter((r) => !r.claimed)
    .sort((a, b) => (b.entitledTotal > a.entitledTotal ? 1 : -1)));
  const unclaimed = $derived(allUnclaimed.filter((r) => r.entitledTotal >= DUST));
  const dustCount = $derived(allUnclaimed.length - unclaimed.length);
  let showDust = $state(false);
  const unclaimedShown = $derived(showDust ? allUnclaimed : unclaimed);

  const sum = (xs: Row[]) => xs.reduce((t, r) => t + r.entitledTotal, 0n);
  const amt = (v: bigint) => lc((Number(v) / Number(U)).toFixed(8), 2);
  const pct = (a: bigint, b: bigint) => b === 0n ? "0.0" : (Number(a) / Number(b) * 100).toFixed(1);
</script>

<Seo
  title="Who showed up — LasseCash migration progress"
  description="Live from the chain: who has claimed their LASSECASH on MAGI, and what they have done since."
  canonical={`${SITE_URL}/stats`}
/>

<h1>Who showed up</h1>

<!-- THE CLAIM FUNNEL, AT THE TOP. Someone arriving cold does not want a
     leaderboard, they want to know whether any of this is theirs — and the
     window for claiming while the position still EARNS closes on 30 September.
     That question outranks every figure below it. -->
<p class="claimcta">
  Haven't claimed yet? <a href="/check">Check whether you're in the snapshot →</a>
  <span class="dim">— 418 accounts qualified. Claiming before 30 September keeps the position earning.</span>
</p>

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
      <dd class="dim">{unclaimed.length} accounts holding 1 LASSECASH or more</dd></div>
    <div><dt>Have done something</dt><dd class="mono gold">{claimed.filter((r) => r.calls > 1).length}</dd>
      <dd class="dim">beyond claiming</dd></div>

  </div>

  <!-- "LASSECASH" read as the LIQUID balance, because that is how every Hive
       wallet labels its first column — @klye showed 22,476 here and 2,046 on
       PeakD, and it looked like a snapshot bug for a minute. It is the whole
       position: liquid + staked. Same numbers, said properly. -->
  <p class="legend unit">
    <span><b>Total LASSECASH</b> is the whole snapshot position — liquid plus staked.
    The staked half is what becomes the mint, shown as L-Shares.</span>
  </p>

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
            <th class="num">Total LASSECASH</th><th class="num">L-Shares at claim</th><th>Did</th>
          </tr></thead>
          <tbody>
            {#each (showAllClaimed ? claimed : claimed.slice(0, 40)) as r, i}
              <tr>
                <td class="num dim">{i + 1}</td>
                <td><a href="/@{r.account}">@{r.account}</a></td>
                <td class="num mono">{amt(r.entitledTotal)}</td>
                <td class="num mono dim">{amt(r.entitledStaked)}</td>
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

      {#if newcomers.length}
        <h2 class="showed">Showed up <span class="dim">— {newcomers.length}</span></h2>
        <p class="note dim">
          Nothing in the snapshot, nothing to claim. They arrived anyway and
          bought in — the only people here who were never given anything.
        </p>
        <div class="scroll">
          <table>
            <thead><tr>
              <th class="num">#</th><th>Account</th>
              <th class="num">LASSECASH</th><th class="num">L-Shares</th><th>Did</th>
            </tr></thead>
            <tbody>
              {#each newcomers as n, i}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td><a href="/@{n.account}">@{n.account}</a></td>
                  <td class="num mono gold">{amt(n.balance)}</td>
                  <td class="num mono" class:zero={n.shares === 0n}>{amt(n.shares)}</td>
                  <td class="kinds">{#each n.kinds as k}<b>{k}</b>{/each}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="panel">
      <h2>Not claimed <span class="dim">— {unclaimed.length}</span></h2>
      <p class="note dim">
        {dustCount} more qualified with less than 1 LASSECASH between them, dust the
        contract would not even mint.
        <button class="link" onclick={() => showDust = !showDust}>
          {showDust ? "hide them" : "show them anyway"}
        </button>
      </p>
      <div class="scroll">
        <table>
          <thead><tr>
            <th class="num">#</th><th>Account</th>
            <th class="num">Total LASSECASH</th><th class="num">L-Shares waiting</th>
          </tr></thead>
          <tbody>
            {#each (showAllUnclaimed ? unclaimedShown : unclaimedShown.slice(0, 40)) as r, i}
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
      {#if unclaimedShown.length > 40}
        <button onclick={() => showAllUnclaimed = !showAllUnclaimed}>
          {showAllUnclaimed ? "Show fewer" : `Show all ${unclaimedShown.length}`}
        </button>
      {/if}
    </section>
  </div>
{/if}

<style>
  h1 { margin: 0 0 1rem; }
  .claimcta { margin: 0 0 1.5rem; padding: .8rem 1rem; font-size: .95rem;
              border: 1px solid var(--gold-dim); border-radius: 4px; }
  .claimcta a { color: var(--gold); font-weight: 600; }
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
  /* Gold, not green: this is money the protocol owes, not a gain realised. */
  td.gold { color: var(--gold); }
  .kinds b { display: inline-block; min-width: 1.1em; text-align: center; color: var(--gold);
             font-family: inherit; font-size: .75rem; }
  .legend { display: flex; flex-wrap: wrap; gap: .25rem 1rem; font-size: .7rem; color: var(--dim); margin: 1rem 0; }
  .legend b { color: var(--gold); margin-right: .25rem; }
  .legend.unit { margin-bottom: .25rem; }
  button { margin-top: .75rem; }
  .note { font-size: .75rem; margin: 0 0 .75rem; }
  .showed { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid var(--rule); }
  button.link { margin: 0; background: none; border: 0; padding: 0; font: inherit;
                color: var(--gold); text-decoration: underline; cursor: pointer; }
  .red { color: var(--red); }
</style>

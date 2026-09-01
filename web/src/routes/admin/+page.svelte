<script lang="ts">
  /**
   * Admin — the founder's migration console.
   *
   * Reads two things:
   *   1. web/static/admin-data.json — a static snapshot built by
   *      tools/snapshot/make_admin_data.py from the migration set. Who
   *      migrates, who is burned, and everyone who ever touched LasseCash.
   *   2. GET /dev/dump on the dev chain — the LIVE shr_/mint_ state, which the
   *      static snapshot cannot know because it was generated before any
   *      migrated account ever minted. Only available against the dev
   *      simulator; a real MAGI node has no such endpoint, so those two
   *      columns show "—" in wallet mode. See CLAUDE.md, "Dev chain".
   *
   * Soft gate only: the account name check is a UI convenience, not security —
   * the data is public snapshot data regardless of who is looking at it.
   */
  import { onMount } from "svelte";
  import { chain, WALLET_MODE } from "$lib/chain.svelte.js";
  import { displayName, lc, shortDate } from "$lib/format.js";
  import { fromUnits } from "$api/index.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_URL } from "$lib/site.js";

  // Keep in sync with the same literal in +layout.svelte (the nav gate) —
  // chain.svelte.ts is shared app state and out of scope for this page.
  const FOUNDER = "hive:lasseehlers";
  const isFounder = $derived(chain.account === FOUNDER);

  const DEV_URL = import.meta.env.VITE_CHAIN_URL ?? "http://localhost:8080";
  const SHOW_LIMIT = 100;

  // --- static snapshot --------------------------------------------------

  interface AdminStats {
    migrated_accounts: number;
    total_lassecash: number;
    total_staked_power: number;
    combined_total: number;
    /** Truncated to 2dp in Python — see make_admin_data.py. Never re-derived here. */
    founder_ownership_pct: string;
  }

  interface AdminDataFile {
    generated: string;
    window_months: number;
    stats: AdminStats;
    migrated: { account: string; liquid: number; staked: number; total: number; reason: string }[];
    all: { account: string; liquid: number; staked: number }[];
    burned: { account: string; liquid: number; staked: number; group: "inactive" | "protocol" }[];
  }

  let raw = $state<AdminDataFile | null>(null);
  let dataError = $state<string | null>(null);

  async function loadData() {
    try {
      const res = await fetch("/admin-data.json");
      if (!res.ok) throw new Error(`admin-data.json: HTTP ${res.status}`);
      raw = await res.json();
    } catch (e) {
      dataError = e instanceof Error ? e.message : String(e);
    }
  }

  // --- live dev-chain state (L-Shares, open mint principal) -------------

  let dumpMap = $state<Map<string, { shares: bigint; principal: bigint }> | null>(null);
  let dumpError = $state<string | null>(null);

  /** Ended mints (field 5, the 6th pipe-field) do not count toward principal. */
  function accumulate(map: Map<string, { shares: bigint; principal: bigint }>, account: string) {
    let entry = map.get(account);
    if (!entry) {
      entry = { shares: 0n, principal: 0n };
      map.set(account, entry);
    }
    return entry;
  }

  async function loadDump() {
    if (WALLET_MODE) return; // no dev-only dump endpoint against a real MAGI node
    try {
      const res = await fetch(`${DEV_URL}/dev/dump`);
      if (!res.ok) throw new Error(`/dev/dump: HTTP ${res.status}`);
      const dump: Record<string, string> = await res.json();
      const map = new Map<string, { shares: bigint; principal: bigint }>();
      for (const [key, value] of Object.entries(dump)) {
        if (key.startsWith("shr_")) {
          accumulate(map, key.slice("shr_".length)).shares = BigInt(value || "0");
        } else if (key.startsWith("mint_")) {
          const rest = key.slice("mint_".length);
          const idx = rest.lastIndexOf("_");
          if (idx === -1) continue;
          const account = rest.slice(0, idx);
          // principal|shares|start|days|goodAccounting|ended|accStart
          const fields = value.split("|");
          if (fields.length < 6 || fields[5] !== "0") continue; // skip ended mints
          accumulate(map, account).principal += BigInt(fields[0] || "0");
        }
      }
      dumpMap = map;
    } catch (e) {
      dumpError = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void loadData();
    void loadDump();
  });

  // --- row shapes ----------------------------------------------------------

  /**
   * WHY THERE IS NO LONGER AN "A / B / A+B" BADGE.
   *
   * This page used to show a two-criteria legend: an active-key op on Hive OR
   * LASSECASH activity, either sufficient. That was the rule BEFORE C6
   * (2026-08-22), and it survived here after the decision changed — so the
   * console described a migration that did not happen. Every one of the 418
   * rows carried a "B", which is what gave it away: a badge whose value never
   * varies is not reporting anything.
   *
   * The rule that actually ran (tools/snapshot/apply_criteria.py) is single:
   * an account migrates iff it SIGNED a LASSECASH operation on Hive-Engine
   * inside the window. The Hive active-key timestamp is still collected and
   * still published — `last_active_op`, marked "audit only" in that script —
   * but it qualifies nobody.
   *
   * One exception is worth a badge because it genuinely differs: an account
   * whose history walk never resolved FAILS OPEN and migrates unproven,
   * because a scan that ran out of pages is not evidence of death. That is
   * the only row a reader should look at twice.
   */
  type Criteria = "signed" | "unresolved";
  function criteriaBadge(reason: string): Criteria {
    return reason.includes("truncated") ? "unresolved" : "signed";
  }

  // POWER (staked) does not survive migration — it becomes L-Shares 1:1, so
  // the migrated table's own "TOTAL" is balance + L-SHARES (live), not
  // balance + power. It is therefore only known once the dev-chain dump has
  // loaded, same as the L-Shares and mint-principal columns it depends on.
  interface MigratedRow {
    account: string; liquid: bigint; total: bigint | null;
    lshares: bigint | null; principal: bigint | null; reason: string; badge: Criteria;
  }
  interface AllRow { account: string; liquid: bigint; staked: bigint; }
  interface BurnedRow { account: string; liquid: bigint; staked: bigint; group: "inactive" | "protocol"; }

  const migratedRows = $derived<MigratedRow[]>(
    (raw?.migrated ?? []).map((r) => {
      const live = dumpMap?.get(`hive:${r.account}`);
      const liquid = BigInt(r.liquid);
      // WHERE THE L-SHARE FIGURE COMES FROM.
      //
      // Against the dev chain the live dump is the truth. Against a real MAGI
      // node there is no /dev/dump, so `loadDump` returns immediately and this
      // table printed an em-dash in every one of its three right-hand columns
      // — which is what the production console showed all launch night.
      //
      // The snapshot itself is the honest answer there, and an exact one:
      // staked POWER becomes L-Shares 1:1 and becomes the migration mint's
      // principal (engine.NewMigrationMint), so both columns ARE `staked`.
      // It is a statement about the migration, which is what this page is.
      // Once an account claims, its live figures live on /chain and its
      // profile; this console is the record of what the snapshot promised.
      const snapshotStake = BigInt(r.staked);
      const lshares = dumpMap !== null ? (live?.shares ?? 0n) : snapshotStake;
      const principal = dumpMap !== null ? (live?.principal ?? 0n) : snapshotStake;
      return {
        account: r.account,
        liquid,
        lshares,
        principal,
        total: liquid + lshares,
        reason: r.reason,
        badge: criteriaBadge(r.reason),
      };
    }),
  );
  const allRows = $derived<AllRow[]>(
    (raw?.all ?? []).map((r) => ({ account: r.account, liquid: BigInt(r.liquid), staked: BigInt(r.staked) })),
  );
  const burnedRows = $derived<BurnedRow[]>(
    (raw?.burned ?? []).map((r) => ({ account: r.account, liquid: BigInt(r.liquid), staked: BigInt(r.staked), group: r.group })),
  );

  // --- sorting: BigInt-safe (values exceed Number.MAX_SAFE_INTEGER once
  // summed), account/criteria/group compared lexically -------------------

  type SortDir = 1 | -1;
  type Cell = string | bigint | null;

  function cmp(a: Cell, b: Cell): number {
    if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
    return String(a).localeCompare(String(b));
  }

  function makeSorter<T, K extends string>(getField: (row: T, key: K) => Cell) {
    return (rows: T[], key: K, dir: SortDir) => [...rows].sort((a, b) => cmp(getField(a, key), getField(b, key)) * dir);
  }

  type MigratedKey = "account" | "liquid" | "total" | "lshares" | "principal" | "badge";
  type AllKey = "account" | "liquid" | "staked";
  type BurnedKey = "account" | "liquid" | "staked" | "group";

  const sortMigrated = makeSorter<MigratedRow, MigratedKey>((r, k) => r[k]);
  const sortAll = makeSorter<AllRow, AllKey>((r, k) => r[k]);
  const sortBurned = makeSorter<BurnedRow, BurnedKey>((r, k) => r[k]);

  // Default: TOTAL (balance + L-Shares) descending, so the founder can rank
  // accounts by overall size. Nulls (unknown L-Shares — wallet mode, or the
  // dump hasn't loaded yet) sort last regardless of direction.
  let migratedSort = $state<{ key: MigratedKey; dir: SortDir }>({ key: "total", dir: -1 });
  let allSort = $state<{ key: AllKey; dir: SortDir }>({ key: "liquid", dir: -1 });
  let burnedSort = $state<{ key: BurnedKey; dir: SortDir }>({ key: "liquid", dir: -1 });

  /** Toggles direction on a repeat click; a new column starts at its natural default. */
  function toggle<K extends string>(state: { key: K; dir: SortDir }, key: K, firstDir: SortDir) {
    if (state.key === key) state.dir = state.dir === 1 ? -1 : 1;
    else { state.key = key; state.dir = firstDir; }
  }
  function arrow<K extends string>(state: { key: K; dir: SortDir }, key: K): string {
    return state.key !== key ? "" : state.dir === 1 ? "▲" : "▼";
  }

  let migratedShowAll = $state(false);
  let allShowAll = $state(false);
  let burnedShowAll = $state(false);

  const migratedSorted = $derived(sortMigrated(migratedRows, migratedSort.key, migratedSort.dir));
  const allSorted = $derived(sortAll(allRows, allSort.key, allSort.dir));
  const burnedSorted = $derived(sortBurned(burnedRows, burnedSort.key, burnedSort.dir));

  const migratedShown = $derived(migratedShowAll ? migratedSorted : migratedSorted.slice(0, SHOW_LIMIT));
  const allShown = $derived(allShowAll ? allSorted : allSorted.slice(0, SHOW_LIMIT));
  const burnedShown = $derived(burnedShowAll ? burnedSorted : burnedSorted.slice(0, SHOW_LIMIT));

  function sumBigint<T>(rows: T[], get: (r: T) => bigint): bigint {
    return rows.reduce((acc, r) => acc + get(r), 0n);
  }
  // The migrated table's subtitle uses raw.stats.combined_total (the static,
  // always-known snapshot figure) rather than summing live per-row totals,
  // which would be null/incomplete before the dump loads or in wallet mode.
  const allTotal = $derived(sumBigint(allRows, (r) => r.liquid + r.staked));
  const burnedTotal = $derived(sumBigint(burnedRows, (r) => r.liquid + r.staked));

</script>

<Seo
  title="Admin"
  description="Migration console."
  canonical={`${SITE_URL}/admin`} noindex
/>

{#if !isFounder}
  <section class="panel">
    <h2>Admin</h2>
    <p class="empty">
      <strong>This page is the founder's migration console.</strong>
      Sign in as the founder account to use it.
    </p>
    <small class="dim">
      Nothing here is secret — every figure comes from the public migration
      snapshot, so this gate is a convenience that keeps the page out of
      everyone else's way, not a security boundary.
    </small>
  </section>
{:else}
  <div class="grid">
    {#if dataError}
      <div class="panel"><p class="empty red"><strong>Could not load admin-data.json.</strong> {dataError}</p></div>
    {:else if !raw}
      <div class="panel"><p class="empty">Loading migration snapshot…</p></div>
    {:else}
      <section class="stats">
        <div class="panel stat">
          <div class="label">Migrated accounts</div>
          <div class="value dim">{raw.stats.migrated_accounts.toLocaleString()}</div>
        </div>
        <div class="panel stat">
          <div class="label">Total LasseCash</div>
          <div class="value">{lc(fromUnits(BigInt(raw.stats.total_lassecash)))}</div>
          <div class="sub">liquid, across all migrated accounts</div>
        </div>
        <div class="panel stat">
          <div class="label">Total staked power</div>
          <div class="value">{lc(fromUnits(BigInt(raw.stats.total_staked_power)))}</div>
          <div class="sub">becomes a 30-day migration mint, L-Shares 1:1</div>
        </div>
        <div class="panel stat">
          <div class="label">Combined total</div>
          <div class="value gold">{lc(fromUnits(BigInt(raw.stats.combined_total)))}</div>
          <div class="sub">liquid + staked</div>
        </div>
        <div class="panel stat">
          <div class="label">Founder ownership</div>
          <div class="value">{raw.stats.founder_ownership_pct}%</div>
          <div class="sub">@lasseehlers of combined total</div>
        </div>
      </section>

      <section class="panel">
        <h2>Migration snapshot</h2>
        <small class="dim">
          Generated {shortDate(raw.generated)} · {raw.window_months}-month liveness window ·
          {dumpMap ? "live L-Shares and mint principal from the dev chain" : "figures as committed in the snapshot"}
        </small>
        {#if dumpError}<p class="empty red">/dev/dump: {dumpError}</p>{/if}
      </section>

      <section class="panel">
        <h2>Migrated accounts</h2>
        <small class="dim">
          {migratedRows.length.toLocaleString()} accounts · {lc(fromUnits(BigInt(raw.stats.combined_total)))} LC total
        </small>

        <div class="legend-box">
          <div class="legend-title">Qualifying criterion — one rule, and it is about LasseCash</div>
          <div class="legend-row">
            <span class="badge b">signed</span>
            The account SIGNED a LASSECASH operation on Hive-Engine within the
            {raw.window_months}-month window — a transfer, a stake, an unstake, a delegation.
            Holding the token was never enough and being active elsewhere on Hive was never
            enough: {migratedRows.length} of {migratedRows.length} accounts qualified this way.
            Hive active-key timestamps are collected and published for the audit trail, but
            they qualify nobody.
          </div>
          <div class="legend-row">
            <span class="badge a">unresolved</span>
            Fail-open: the history walk never finished, so the account migrated unproven.
            A scan that ran out of pages is not evidence of death — nobody is burned on
            missing data. None in this snapshot.
          </div>
        </div>
        <small class="dim">
          POWER does not survive migration — it becomes L-Shares 1:1, so this table shows LasseCash balance, L-Shares
          and a combined TOTAL rather than the pre-migration balance/power split kept in the other two tables.
        </small>

        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="sortable" onclick={() => toggle(migratedSort, "account", 1)}>Account {arrow(migratedSort, "account")}</th>
                <th class="sortable num" onclick={() => toggle(migratedSort, "liquid", -1)}>LasseCash balance {arrow(migratedSort, "liquid")}</th>
                <th class="sortable num" onclick={() => toggle(migratedSort, "lshares", -1)}>L-Shares {arrow(migratedSort, "lshares")}</th>
                <th class="sortable num" onclick={() => toggle(migratedSort, "principal", -1)}>Mint principal (LASSECASH) {arrow(migratedSort, "principal")}</th>
                <th class="sortable num" onclick={() => toggle(migratedSort, "total", -1)}>Total {arrow(migratedSort, "total")}</th>
                <th class="sortable" onclick={() => toggle(migratedSort, "badge", 1)}>Criteria {arrow(migratedSort, "badge")}</th>
              </tr>
            </thead>
            <tbody>
              {#each migratedShown as row, i (row.account)}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td>{displayName(`hive:${row.account}`)}</td>
                  <td class="num">{lc(fromUnits(row.liquid))}</td>
                  <td class="num">{row.lshares === null ? "—" : lc(fromUnits(row.lshares))}</td>
                  <td class="num">{row.principal === null ? "—" : lc(fromUnits(row.principal))}</td>
                  <td class="num">{row.total === null ? "—" : lc(fromUnits(row.total))}</td>
                  <td><span class="badge {row.badge === 'unresolved' ? 'a' : 'b'}">{row.badge}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="tablefoot">
          {#if migratedSorted.length > SHOW_LIMIT}
            <button class="ghost small" onclick={() => (migratedShowAll = !migratedShowAll)}>
              {migratedShowAll ? `show top ${SHOW_LIMIT}` : `show all ${migratedSorted.length.toLocaleString()}`}
            </button>
          {/if}
          {#if !dumpMap}
            <small class="dim">
              L-Shares and mint principal are the SNAPSHOT's figures — staked POWER
              becomes L-Shares 1:1 and is the migration mint's principal. What an
              account holds today, after claiming and acting, is on its profile.
            </small>
          {/if}
        </div>
      </section>

      <section class="panel">
        <h2>All Hive-Engine accounts that ever touched LasseCash</h2>
        <small class="dim">
          {allRows.length.toLocaleString()} accounts · {lc(fromUnits(allTotal))} LC total
        </small>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="sortable" onclick={() => toggle(allSort, "account", 1)}>Account {arrow(allSort, "account")}</th>
                <th class="sortable num" onclick={() => toggle(allSort, "liquid", -1)}>LASSECASH (liquid) {arrow(allSort, "liquid")}</th>
                <th class="sortable num" onclick={() => toggle(allSort, "staked", -1)}>LASSECASH POWER (staked) {arrow(allSort, "staked")}</th>
              </tr>
            </thead>
            <tbody>
              {#each allShown as row, i (row.account)}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td>{displayName(`hive:${row.account}`)}</td>
                  <td class="num">{lc(fromUnits(row.liquid))}</td>
                  <td class="num">{lc(fromUnits(row.staked))}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if allSorted.length > SHOW_LIMIT}
          <div class="tablefoot">
            <button class="ghost small" onclick={() => (allShowAll = !allShowAll)}>
              {allShowAll ? `show top ${SHOW_LIMIT}` : `show all ${allSorted.length.toLocaleString()}`}
            </button>
          </div>
        {/if}
      </section>

      <section class="panel">
        <h2>Did not make it (burned at migration)</h2>
        <small class="dim">
          {burnedRows.length.toLocaleString()} accounts · {lc(fromUnits(burnedTotal))} LC total
        </small>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="sortable" onclick={() => toggle(burnedSort, "account", 1)}>Account {arrow(burnedSort, "account")}</th>
                <th class="sortable num" onclick={() => toggle(burnedSort, "liquid", -1)}>LASSECASH {arrow(burnedSort, "liquid")}</th>
                <th class="sortable num" onclick={() => toggle(burnedSort, "staked", -1)}>LASSECASH POWER {arrow(burnedSort, "staked")}</th>
              </tr>
            </thead>
            <tbody>
              {#each burnedShown as row, i (row.account)}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td>{displayName(`hive:${row.account}`)}</td>
                  <td class="num">{lc(fromUnits(row.liquid))}</td>
                  <td class="num">{lc(fromUnits(row.staked))}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if burnedSorted.length > SHOW_LIMIT}
          <div class="tablefoot">
            <button class="ghost small" onclick={() => (burnedShowAll = !burnedShowAll)}>
              {burnedShowAll ? `show top ${SHOW_LIMIT}` : `show all ${burnedSorted.length.toLocaleString()}`}
            </button>
          </div>
        {/if}
      </section>
    {/if}
  </div>
{/if}

<style>
  /* Same top-of-page tile grid as /chain. */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
  @media (max-width: 720px) {
    .stats { grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  }

  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--ink); }
  th.num, td.num { text-align: right; }
  .tablefoot { display: flex; align-items: center; gap: 0.8rem; margin-top: 0.7rem; flex-wrap: wrap; }
  .red { color: var(--red); }

  /* Qualifying-criteria legend, above the migrated table. */
  .legend-box {
    background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: 0.6rem 0.8rem; margin: 0.7rem 0 0.9rem;
    display: flex; flex-direction: column; gap: 0.35rem;
  }
  .legend-title {
    font-family: var(--mono); font-size: var(--t-micro); font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim);
  }
  .legend-row { display: flex; gap: 0.55rem; align-items: flex-start; font-size: var(--t-sm); color: var(--dim); }
  .legend-row .badge { flex-shrink: 0; margin-top: 0.05rem; }

  /* Row badges: `signed` (the rule) and `unresolved` (the fail-open case). */
  .badge {
    display: inline-block; min-width: 1.6rem; text-align: center;
    padding: 0.08rem 0.4rem; border-radius: var(--r-sm);
    font-family: var(--mono); font-weight: 700; font-size: var(--t-tiny);
    border: 1px solid currentColor;
  }
  .badge.a { color: var(--cyan); background: rgba(46, 230, 214, 0.1); }
  .badge.b { color: var(--gold); background: rgba(255, 210, 63, 0.1); }
</style>

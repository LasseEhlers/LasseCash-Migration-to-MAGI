<script lang="ts">
  /**
   * The migration snapshot, in full: what was committed, who qualified, who
   * was burned, and every account that ever touched LASSECASH.
   *
   * PUBLIC ON PURPOSE. This was the founder's console behind a soft gate, and
   * the gate never protected anything — every figure comes from the published
   * snapshot, the root is on-chain and the leaves are in the repo. Keeping it
   * tucked away only meant that the one number people would want to check —
   * how much the founder holds — had to be dug for rather than read. A figure
   * volunteered is a disclosure; the same figure discovered is an exposé.
   *
   * Extracted as a component so the Snapshot page and anything after it show
   * the SAME tables from the SAME file. Two copies of a table like this drift,
   * and the first anyone would notice is when two pages disagree about the
   * migration.
   */
  /**
   * Reads two things:
   *   1. web/static/admin-data.json — the static snapshot built by
   *      tools/snapshot/make_admin_data.py. Who qualified, who was burned,
   *      and everyone who ever touched LASSECASH.
   *   2. GET /dev/dump on the dev chain — LIVE shr_/mint_ state, which the
   *      static file cannot know. Only the simulator has that endpoint; a
   *      real MAGI node does not, and against one the table falls back to the
   *      snapshot's own figures, which are exact for what they describe:
   *      staked POWER becomes L-Shares 1:1 at migration.
   */
  import { onMount } from "svelte";
  import { chain, WALLET_MODE } from "$lib/chain.svelte.js";
  import { displayName, lc, shortDate } from "$lib/format.js";
  import { fromUnits } from "$api/index.js";


  // Keep in sync with the same literal in +layout.svelte (the nav gate) —
  // chain.svelte.ts is shared app state and out of scope for this page.
  const FOUNDER = "hive:lasseehlers";

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
  interface AllRow { account: string; liquid: bigint; staked: bigint; total: bigint; }
  interface BurnedRow { account: string; liquid: bigint; staked: bigint; total: bigint; group: "inactive" | "protocol"; }

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
    (raw?.all ?? []).map((r) => ({
      account: r.account, liquid: BigInt(r.liquid), staked: BigInt(r.staked),
      total: BigInt(r.liquid) + BigInt(r.staked),
    })),
  );
  const burnedRows = $derived<BurnedRow[]>(
    (raw?.burned ?? []).map((r) => ({
      account: r.account, liquid: BigInt(r.liquid), staked: BigInt(r.staked),
      total: BigInt(r.liquid) + BigInt(r.staked), group: r.group,
    })),
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
  type AllKey = "account" | "liquid" | "staked" | "total";
  type BurnedKey = "account" | "liquid" | "staked" | "total" | "group";

  const sortMigrated = makeSorter<MigratedRow, MigratedKey>((r, k) => r[k]);
  const sortAll = makeSorter<AllRow, AllKey>((r, k) => r[k]);
  const sortBurned = makeSorter<BurnedRow, BurnedKey>((r, k) => r[k]);

  // Default: TOTAL (balance + L-Shares) descending, so the founder can rank
  // accounts by overall size. Nulls (unknown L-Shares — wallet mode, or the
  // dump hasn't loaded yet) sort last regardless of direction.
  let migratedSort = $state<{ key: MigratedKey; dir: SortDir }>({ key: "total", dir: -1 });
  let allSort = $state<{ key: AllKey; dir: SortDir }>({ key: "total", dir: -1 });
  let burnedSort = $state<{ key: BurnedKey; dir: SortDir }>({ key: "total", dir: -1 });

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

  /**
   * The burned list is 12,143 rows and almost all of it is dust, which hides
   * the fact that a handful of large holders make up nearly all of it. This
   * is the shape of the burn in one line: how many accounts held a real
   * position and lost it, and what share of the total they were.
   */
  const BIG_BURN = 10_000n * 100_000_000n;
  const bigBurned = $derived.by(() => {
    const big = burnedRows.filter((r) => r.total > BIG_BURN);
    const sum = sumBigint(big, (r) => r.total);
    const total = burnedTotal;
    return {
      count: big.length,
      sum,
      pct: total > 0n ? (Number((sum * 1000n) / total) / 10).toFixed(1) : "0",
    };
  });

  /**
   * The root committed on-chain by `set_snapshot`, and the leaf count it
   * commits to. The root is a CONSTANT because it is a fact about the chain,
   * not about this file: it is what `cfg_migroot` holds, and if the published
   * tree ever stopped matching it the claim page would already be refusing to
   * offer a button (see ClaimMigration's rootMismatch).
   *
   * The leaf count is DERIVED — every account holding anything gets a leaf,
   * qualified or burned, which is what makes the tree a permanent record of
   * what everyone held rather than a list of winners.
   */
  const MIGRATION_ROOT =
    "092f7b2ed2e6a0ccd3dadb832e9829c6419096171bcae68edb883fb099e46803";
  const leafCount = $derived(
    allRows.filter((r) => r.liquid + r.staked > 0n).length,
  );

</script>

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

        <!-- WHAT WAS ACTUALLY COMMITTED. The tables below are the working
             data; these are the figures the contract will hold forever, and
             they are the ones to quote publicly. Every one is derived from
             the same file the tables use, so the page cannot drift from a
             hardcoded copy of its own totals. -->
        <dl class="facts">
          <div><dt>Committed root</dt><dd class="root">{MIGRATION_ROOT}</dd></div>
          <div><dt>Snapshot block</dt><dd>109,504,918 <span class="dim">· 31 Aug 2026, 12:00 UTC</span></dd></div>
          <div><dt>Leaves in the tree</dt><dd>{leafCount.toLocaleString()} <span class="dim">· every account with a balance, qualified or burned</span></dd></div>
          <div><dt>Qualified</dt><dd>{migratedRows.length.toLocaleString()} accounts · <b>{lc(fromUnits(BigInt(raw.stats.combined_total)))}</b> LC</dd></div>
          <div><dt>Burned to @null</dt><dd>{burnedRows.length.toLocaleString()} accounts · <b>{lc(fromUnits(burnedTotal))}</b> LC</dd></div>
          <div><dt>Snapshot supply</dt><dd><b>{lc(fromUnits(burnedTotal + BigInt(raw.stats.combined_total)))}</b> LC <span class="dim">· qualified + burned</span></dd></div>
        </dl>
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
            enough: <b>{migratedRows.length} of {migratedRows.length}</b> accounts qualified
            this way. Hive active-key timestamps are collected and published for the audit
            trail, but they qualify nobody.
          </div>
          <div class="legend-row plain">
            <!-- The fail-open rule bound for no one, so it gets no badge — a
                 legend explains symbols that appear in the table. It is still
                 stated, because it is a promise the snapshot kept and reading
                 the criterion without it makes the rule look harsher than it
                 was. The snapshot is committed and final, so "none" is not a
                 count that can change later. -->
            Nobody was burned on missing data. An account whose history walk never
            finished would have migrated <em>unproven</em> — a scan that ran out of pages
            is not evidence of death. That safeguard was never needed here: every
            qualifying account was resolved, and signed.
          </div>
        </div>
        <small class="dim">
          POWER does not survive migration: it becomes L-SHARES 1:1 and is the principal of a 30-day
          migration mint. So this table shows liquid LASSECASH and the POWER that becomes L-Shares —
          the other two tables keep the pre-migration balance/power split.
          <br />
          <b>TOTAL is notional, not a balance.</b> It adds LASSECASH to L-Shares, and those are not the
          same thing: one is money you can send, the other is voting weight and a claim on the yield
          pool. They line up only because POWER converts 1:1 at this one moment. Read it as "what this
          account held on Hive-Engine, restated" — it is the right number for ranking who arrived with
          what, and the wrong number to call anyone's balance.
        </small>

        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="sortable" onclick={() => toggle(migratedSort, "account", 1)}>Account {arrow(migratedSort, "account")}</th>
                <th class="sortable num" onclick={() => toggle(migratedSort, "liquid", -1)}>LASSECASH {arrow(migratedSort, "liquid")}</th>
                <th class="sortable num" onclick={() => toggle(migratedSort, "lshares", -1)}>LASSECASH POWER → L-Shares {arrow(migratedSort, "lshares")}</th>
                {#if dumpMap}
                  <th class="sortable num" onclick={() => toggle(migratedSort, "principal", -1)}>Mint principal {arrow(migratedSort, "principal")}</th>
                {/if}
                <th class="sortable num" onclick={() => toggle(migratedSort, "total", -1)} title="LASSECASH + L-Shares. Two different units added together — see the note above the table.">Total <span class="hint">notional</span> {arrow(migratedSort, "total")}</th>
                <th class="sortable" onclick={() => toggle(migratedSort, "badge", 1)}>Criteria {arrow(migratedSort, "badge")}</th>
              </tr>
            </thead>
            <tbody>
              {#each migratedShown as row, i (row.account)}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td>{displayName(`hive:${row.account}`)}</td>
                  <td class="num">{lc(fromUnits(row.liquid))}</td>
                  <td class="num">{lc(fromUnits(row.lshares))}</td>
                  {#if dumpMap}<td class="num">{lc(fromUnits(row.principal))}</td>{/if}
                  <td class="num gold">{lc(fromUnits(row.total))}</td>
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
        <h2>Did not make it (burned at migration)</h2>
        <small class="dim">
          {burnedRows.length.toLocaleString()} accounts · {lc(fromUnits(burnedTotal))} LC total ·
          <b>{bigBurned.count.toLocaleString()}</b> of them held over 10,000 LC, together
          <b>{lc(fromUnits(bigBurned.sum))}</b> LC — {bigBurned.pct}% of everything burned.
          Their tokens sit at @null, unspendable, listed account by account forever.
        </small>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="sortable" onclick={() => toggle(burnedSort, "account", 1)}>Account {arrow(burnedSort, "account")}</th>
                <th class="sortable num" onclick={() => toggle(burnedSort, "liquid", -1)}>LASSECASH {arrow(burnedSort, "liquid")}</th>
                <th class="sortable num" onclick={() => toggle(burnedSort, "staked", -1)}>LASSECASH POWER {arrow(burnedSort, "staked")}</th>
                <th class="sortable num" onclick={() => toggle(burnedSort, "total", -1)}>Total {arrow(burnedSort, "total")}</th>
                <th class="sortable" onclick={() => toggle(burnedSort, "group", 1)}>Burned {arrow(burnedSort, "group")}</th>
              </tr>
            </thead>
            <tbody>
              {#each burnedShown as row, i (row.account)}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td>{displayName(`hive:${row.account}`)}</td>
                  <td class="num">{lc(fromUnits(row.liquid))}</td>
                  <td class="num">{lc(fromUnits(row.staked))}</td>
                  <td class="num gold">{lc(fromUnits(row.total))}</td>
                  <td><span class="badge {row.group === 'protocol' ? 'a' : 'burn'}">{row.group === 'protocol' ? 'protocol' : 'burned'}</span></td>
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

      <section class="panel">
        <h2>All Hive-Engine accounts that ever touched LasseCash</h2>
        <small class="dim">
          Everyone, qualified or not, as the snapshot found them — the reference list
          the two tables above are drawn from. TOTAL here is a straight sum: both
          columns are pre-migration LASSECASH, the same unit. (In "Migrated accounts"
          it is notional, because there it adds tokens to L-Shares.)
        </small>
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
                <th class="sortable num" onclick={() => toggle(allSort, "total", -1)}>Total {arrow(allSort, "total")}</th>
              </tr>
            </thead>
            <tbody>
              {#each allShown as row, i (row.account)}
                <tr>
                  <td class="num dim">{i + 1}</td>
                  <td>{displayName(`hive:${row.account}`)}</td>
                  <td class="num">{lc(fromUnits(row.liquid))}</td>
                  <td class="num">{lc(fromUnits(row.staked))}</td>
                  <td class="num gold">{lc(fromUnits(row.total))}</td>
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
    {/if}
  </div>

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
  /* A stated rule rather than a key to a symbol: no swatch to align to. */
  .legend-row.plain { padding-left: 0.1rem; }

  /* The committed snapshot facts: label left, value right, one per row. */
  .facts { margin: 0.9rem 0 0; display: grid; gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); }
  .facts > div {
    background: var(--panel-2); padding: 0.5rem 0.7rem;
    display: flex; flex-wrap: wrap; gap: 0.3rem 0.9rem; justify-content: space-between; align-items: baseline;
  }
  .facts dt { font-size: var(--t-micro); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); font-family: var(--mono); }
  .facts dd { margin: 0; font-family: var(--mono); font-size: var(--t-tiny); font-variant-numeric: tabular-nums; }
  .facts dd b { color: var(--gold); }
  /* The root is 64 hex characters: let it wrap rather than scroll the panel. */
  .facts dd.root { word-break: break-all; color: var(--cyan); font-size: var(--t-micro); }

  /* Row badges: `signed` (the rule) and `unresolved` (the fail-open case). */
  .badge {
    display: inline-block; min-width: 1.6rem; text-align: center;
    padding: 0.08rem 0.4rem; border-radius: var(--r-sm);
    font-family: var(--mono); font-weight: 700; font-size: var(--t-tiny);
    border: 1px solid currentColor;
  }
  .badge.a { color: var(--cyan); background: rgba(46, 230, 214, 0.1); }
  /* A column whose name needs a qualifier gets one, in the header where the
     number is read — not only in a note above the table. */
  th .hint {
    font-size: var(--t-micro); letter-spacing: 0.06em; text-transform: none;
    color: var(--dimmer); font-weight: 400;
  }
  .badge.b { color: var(--gold); background: rgba(255, 210, 63, 0.1); }
  /* Burned is a fact, not an alarm: these tokens sit at @null, they were not
     taken from anyone who was using them. Dim, not red — red on this site
     means value actively being lost right now. */
  .badge.burn { color: var(--dim); background: rgba(132, 146, 165, 0.12); }
</style>

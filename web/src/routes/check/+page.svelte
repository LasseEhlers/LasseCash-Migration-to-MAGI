<script lang="ts">
  /**
   * "Am I in the snapshot?" — the roll-call page.
   *
   * WHY THIS PAGE DECIDES NOTHING ITSELF. Its verdict is read from static
   * shards built by tools/snapshot/build_status.py, which calls the SAME
   * `evaluate()` that decides the real snapshot. The C6 rule has sharp edges —
   * signed operations only, exact Hive-Engine operation names, an authorship
   * check per operation, a deliberate fail-open on a truncated history walk —
   * and a second implementation here would drift. A drift on this page tells
   * somebody they are safe when the snapshot will burn them.
   *
   * WHAT THE PAGE DOES COMPUTE is nothing: the live Hive-Engine lookup below
   * only LISTS an account's recent LASSECASH operations. It deliberately does
   * not judge them. The shards are a photograph, so an account that acts today
   * still reads "not in" until they are rebuilt; showing the raw operations
   * lets a person see their own fresh transaction immediately without this page
   * having to re-derive a rule it must not own.
   */
  import Seo from "$lib/Seo.svelte";
  import { lc } from "$lib/format.js";
  import { SITE_URL, SNAPSHOT_BLOCK, SNAPSHOT_WHEN } from "$lib/site.js";
  import { base } from "$app/paths";

  type Row = {
    in: boolean;
    liquid: string;
    staked: string;
    reason: string;
    last_lassecash?: string;
    last_hive_op?: string;
    protocol?: boolean;
  };
  type HeOp = {
    timestamp: number;
    operation: string;
    from?: string;
    to?: string;
    quantity: string;
    transactionId: string;
  };

  let query = $state("");
  let looking = $state(false);
  let asked = $state("");
  let row = $state<Row | null>(null);
  let missing = $state(false);
  let index = $state<{ generated: string; window_months: number; cutoff: string } | null>(null);
  let ops = $state<HeOp[] | null>(null);

  const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
  /** Mirrors migtree.Shard in Go and shard_of() in build_status.py. */
  function shardOf(name: string): string {
    let out = "";
    for (let i = 0; i < 2; i++) {
      const c = name[i] ?? "";
      out += (i === 0 ? ALNUM : ALNUM + ".-").includes(c) ? c : "_";
    }
    return out;
  }

  function clean(s: string): string {
    return s.trim().toLowerCase().replace(/^@+/, "");
  }

  async function lookup() {
    const name = clean(query);
    if (!name) return;
    looking = true;
    asked = name;
    row = null;
    missing = false;
    ops = null;
    try {
      if (!index) {
        index = await fetch(`${base}/migration/status/index.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
      }
      const shard: Record<string, Row> = await fetch(
        `${base}/migration/status/${shardOf(name)}.json`,
      )
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
      row = shard[name] ?? null;
      missing = row === null;
      // Anyone not already qualifying wants to see whether the action they just
      // took has landed. Fetched only in that case — it is a third-party API.
      if (!row?.in) void recent(name);
    } finally {
      looking = false;
    }
  }

  async function recent(name: string) {
    try {
      const r = await fetch(
        `https://history.hive-engine.com/accountHistory?account=${encodeURIComponent(name)}&symbol=LASSECASH&limit=10`,
      );
      ops = r.ok ? await r.json() : [];
    } catch {
      ops = [];
    }
  }

  const cutoffDate = $derived(index ? index.cutoff.slice(0, 10) : "");
  function when(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
  /** True when an operation is one the account itself must have signed. */
  function selfSigned(o: HeOp, name: string): boolean {
    if (o.operation === "tokens_transfer") return o.from === name;
    return o.operation.startsWith("tokens_") && o.operation !== "tokens_unstakeDone";
  }
</script>

<Seo
  title="Am I in the LASSECASH snapshot?"
  description="Check whether your Hive account qualifies for the LASSECASH migration to MAGI, and what to do before the snapshot block if it does not."
  canonical={`${SITE_URL}/check`}
/>

<div class="wrap">
  <h1>Am I in the snapshot?</h1>
  <p class="lede">
    LASSECASH is migrating to MAGI. To be included you must have <b>signed at
    least one LASSECASH transaction</b> on Hive-Engine in the six months before
    block <span class="mono">{SNAPSHOT_BLOCK.toLocaleString()}</span> —
    {SNAPSHOT_WHEN}. Type your Hive account name.
  </p>

  <form onsubmit={(e) => { e.preventDefault(); lookup(); }}>
    <span class="at">@</span>
    <input
      bind:value={query}
      placeholder="your-hive-name"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
    />
    <button type="submit" disabled={looking || !clean(query)}>
      {looking ? "checking…" : "Check"}
    </button>
  </form>

  {#if asked && !looking}
    {#if row?.protocol}
      <div class="verdict out">
        <h2>@{asked} is a protocol account</h2>
        <p>
          It is burned to <span class="mono">@null</span> by name, not by
          inactivity, and its balance was never anybody's to claim.
        </p>
      </div>
    {:else if row?.in}
      <div class="verdict in">
        <h2>@{asked} — you are IN</h2>
        <dl>
          <dt>liquid</dt><dd class="mono">{lc(row.liquid)}</dd>
          <dt>staked (becomes a 30-day mint)</dt><dd class="mono">{lc(row.staked)}</dd>
          {#if row.last_lassecash}
            <dt>last LASSECASH action</dt><dd class="mono">{row.last_lassecash}</dd>
          {/if}
        </dl>
        {#if row.reason === "truncated_unresolved"}
          <p class="note">
            Your history was too long to walk to the end, so you are included
            rather than excluded — this snapshot never burns an account on
            missing data.
          </p>
        {/if}
        <p>
          Nothing is pushed to you. After launch you <b>claim</b> your own
          tokens with a proof, paying your own Resource Credits. Claim inside
          the first 30 days and the staked half becomes a real mint that earns
          and votes.
        </p>
      </div>
    {:else if missing}
      <div class="verdict none">
        <h2>@{asked} has never held LASSECASH</h2>
        <p>
          There is no balance for this account on Hive-Engine, so there is
          nothing to migrate. That is not a rejection — there is simply nothing
          there. If you think this is wrong, check the spelling.
        </p>
      </div>
    {:else if row}
      <div class="verdict out">
        <h2>@{asked} — you are NOT in, yet</h2>
        <dl>
          <dt>you hold</dt><dd class="mono">{lc(String(BigInt(row.liquid) + BigInt(row.staked)))}</dd>
          <dt>last LASSECASH action</dt>
          <dd class="mono">{row.last_lassecash ?? "no record"}</dd>
          {#if cutoffDate}
            <dt>needs to be after</dt><dd class="mono">{cutoffDate}</dd>
          {/if}
        </dl>
        <h3>What to do — it takes one minute</h3>
        <ol>
          <li>Open <a href="https://hive-engine.com/wallet" rel="noopener">hive-engine.com/wallet</a> or Tribaldex.</li>
          <li>Do <b>one</b> LASSECASH operation you sign yourself: send 1 LASSECASH
              to a friend, stake some, unstake some, or place a market order.</li>
          <li>That is it. You are in.</li>
        </ol>
        <p class="note">
          <b>Receiving does not count.</b> Neither does posting, commenting or
          voting — those use your posting key and a bot can do them. Only an
          operation <b>you signed</b> proves a person is there.
        </p>
      </div>
    {/if}

    {#if ops && ops.length > 0}
      <div class="panel ops">
        <h3>Recent LASSECASH activity on @{asked}</h3>
        <p class="dim small">
          Straight from Hive-Engine, live. The result above is rebuilt
          periodically, so an action you took today may not be reflected in it
          yet — but if you can see it here, the chain has it.
        </p>
        <table>
          <thead><tr><th>date</th><th>operation</th><th>amount</th><th>signed by you?</th></tr></thead>
          <tbody>
            {#each ops as o (o.transactionId + o.timestamp)}
              <tr>
                <td class="mono">{when(o.timestamp)}</td>
                <td class="mono">{o.operation.replace("tokens_", "")}</td>
                <td class="mono">{o.quantity}</td>
                <td>{selfSigned(o, asked) ? "yes" : "no — received"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if ops}
      <p class="dim">No LASSECASH operations found for @{asked} on Hive-Engine.</p>
    {/if}
  {/if}

  {#if index}
    <small class="dim foot">
      Checked against the {index.window_months}-month rule, cutoff
      <span class="mono">{cutoffDate}</span>. Data rebuilt
      <span class="mono">{index.generated.slice(0, 16).replace("T", " ")} UTC</span>
      from public Hive-Engine history. The rule that answers this page is the
      same code that takes the snapshot.
    </small>
  {/if}
</div>

<style>
  .wrap { max-width: 780px; margin: 0 auto; }
  .lede { color: var(--dim); }
  form { display: flex; align-items: center; gap: 0.5rem; margin: 1.4rem 0; }
  .at { color: var(--dim); font-size: 1.4rem; }
  input { flex: 1 1 auto; font-size: 1.1rem; padding: 0.7rem 0.9rem; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; color: var(--ink); font-family: inherit; }
  input:focus { outline: none; border-color: var(--gold); }
  button { padding: 0.7rem 1.4rem; font-size: 1rem; }
  .verdict { border-radius: 8px; padding: 1.1rem 1.3rem; margin-bottom: 1.2rem; background: var(--panel); border-left: 4px solid var(--line); }
  /* Gold for "act now", green for settled-good. Never red: nobody is losing
     value on this page — an account that is out can fix it in one minute. */
  .verdict.in { border-left-color: var(--green); }
  .verdict.in h2 { color: var(--green); }
  .verdict.out { border-left-color: var(--gold); }
  .verdict.out h2 { color: var(--gold); }
  .verdict.none { border-left-color: var(--line); }
  .verdict h2 { margin: 0 0 0.7rem; font-size: 1.15rem; }
  h3 { font-size: 0.95rem; margin: 1.1rem 0 0.5rem; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.35rem 1rem; margin: 0 0 0.9rem; }
  dt { color: var(--dim); font-size: 0.86rem; }
  dd { margin: 0; text-align: right; }
  ol { padding-left: 1.2rem; }
  ol li { margin-bottom: 0.4rem; }
  .note { font-size: 0.88rem; color: var(--dim); background: var(--panel-2); padding: 0.6rem 0.8rem; border-radius: 6px; }
  .ops { margin-bottom: 1.2rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: var(--dim); font-weight: 500; border-bottom: 1px solid var(--line); padding: 0.35rem 0.5rem 0.35rem 0; }
  td { padding: 0.3rem 0.5rem 0.3rem 0; border-bottom: 1px solid var(--line); }
  .small { font-size: 0.82rem; }
  .foot { display: block; margin-top: 1.5rem; }
</style>

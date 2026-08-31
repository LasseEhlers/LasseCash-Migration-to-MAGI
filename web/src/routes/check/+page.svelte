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
   * WHAT THE PAGE DOES COMPUTE is one thing: the shards are a photograph, so
   * an account that acts today reads "not in" until they are rebuilt. The live
   * Hive-Engine lookup lists the account's recent LASSECASH operations, and if
   * one of them is self-signed (the shared `selfSigned` rule from $api, the
   * same one the table column uses) and after the shards' own cutoff, the
   * verdict flips to IN. That is a read of the same rule one row earlier, not
   * a second implementation of it.
   */
  import Seo from "$lib/Seo.svelte";
  import { lc } from "$lib/format.js";
  import { cleanName, fetchLegacyQuote, fromUnits, selfSigned, shardOf, usdValue, type HeOp, type LegacyQuote } from "$api/index.js";
  import { SITE_OG_IMAGE, SITE_URL, SNAPSHOT_BLOCK, SNAPSHOT_WHEN } from "$lib/site.js";
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

  let query = $state("");
  let looking = $state(false);
  let asked = $state("");
  let row = $state<Row | null>(null);
  let missing = $state(false);
  /** null = not checked yet; true/false = Hive's answer. */
  let hiveExists = $state<boolean | null>(null);
  let index = $state<{ generated: string; window_months: number; cutoff: string } | null>(null);
  let ops = $state<HeOp[] | null>(null);
  /** The live Hive-Engine read failed (rate limit, timeout) — say so instead of
   *  silently showing "NOT in" with an empty table (airanmilian, 2026-08-30). */
  let liveError = $state(false);
  /** `/check?a=name` looks the name up on arrival — shareable in a message. */
  $effect(() => {
    const a = new URLSearchParams(window.location.search).get("a");
    if (a && !asked) { query = a; void lookup(); }
  });

  /**
   * A dollar figure next to the balance, from where LASSECASH trades TODAY —
   * the Hive-Engine Diesel pool via HIVE/USD. Fetched once per page load, in
   * the browser, never rendered server-side: it is two third-party spot prices
   * multiplied together and is labelled as exactly that. If either API is
   * down the row simply does not appear; a missing estimate is honest, a
   * stale or made-up one is not.
   */
  let quote = $state<LegacyQuote | null>(null);
  $effect(() => {
    fetchLegacyQuote().then((q) => { quote = q; }).catch(() => { quote = null; });
  });
  const usd = (units: bigint) => (quote ? usdValue(units, quote.usdPerLc) : null);



  async function lookup() {
    const name = cleanName(query);
    if (!name) return;
    looking = true;
    asked = name;
    row = null;
    missing = false;
    hiveExists = null;
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
      // A name with no LASSECASH record is either a real account that never
      // held any, or a typo. Those deserve different answers: Lasse typed
      // "reolandp" for @roelandp and was told the account had never held
      // LASSECASH, which was true of the typo and useless about the person.
      // Hive itself knows whether the account exists.
      if (missing) void existsOnHive(name);
      // Anyone not already qualifying wants to see whether the action they just
      // took has landed. Fetched only in that case — it is a third-party API.
      if (!row?.in) void recent(name);
    } finally {
      looking = false;
    }
  }

  async function existsOnHive(name: string) {
    try {
      const r = await fetch("https://api.hive.blog", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1,
          method: "condenser_api.get_accounts", params: [[name]] }),
      });
      const j = await r.json();
      hiveExists = Array.isArray(j.result) && j.result.length > 0;
    } catch {
      hiveExists = null;   // unknown — fall back to the generic wording
    }
  }

  async function recent(name: string) {
    liveError = false;
    try {
      const r = await fetch(
        `https://history.hive-engine.com/accountHistory?account=${encodeURIComponent(name)}&symbol=LASSECASH&limit=10`,
      );
      if (!r.ok) throw new Error(String(r.status));
      ops = await r.json();
    } catch {
      ops = [];
      liveError = true;
    }
  }

  const cutoffDate = $derived(index ? index.cutoff.slice(0, 10) : "");
  /**
   * The snapshot moment: block 109,504,918 ≈ 2026-08-31 12:00 UTC. After it
   * the verdict is FINAL — no action can change who is in, and an operation
   * signed after the block must never flip anyone (it exists only on the dead
   * chain). Time-based rather than height-based deliberately: this page has
   * no Hive client, and a minute of skew only delays the wording flip.
   */
  const SNAPSHOT_TS = Date.parse("2026-08-31T12:00:00Z");
  /**
   * FINAL means the BLOCK has passed, not the clock: Hive drops blocks, and
   * on launch morning 109,504,918 ran ~30 minutes behind its announced time.
   * A page that said "final, nothing can change it" while one signed op could
   * still save someone would be wrong in the worst possible direction — so we
   * ask the chain for its head block and flip on that. If the head cannot be
   * read, fail toward "not final yet" until well past any plausible drift
   * (four hours), because showing "what to do" too long is harmless and the
   * opposite is not.
   */
  let headBlock = $state<number | null>(null);
  $effect(() => {
    void fetch("https://api.hive.blog", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_dynamic_global_properties", params: [], id: 1 }),
    }).then((r) => r.json()).then((d) => { headBlock = d.result.head_block_number; }).catch(() => {});
  });
  const snapshotFinal = $derived(
    headBlock !== null ? headBlock >= SNAPSHOT_BLOCK
                       : Date.now() >= SNAPSHOT_TS + 4 * 3600_000,
  );
  /**
   * The live override. The shards are a photograph; a person who acted after
   * it was taken must not stare at "NOT in" with the proof of the opposite
   * listed underneath (@tibfox, 2026-08-27). This applies the same shared
   * `selfSigned` rule the table uses, against the same cutoff the shards
   * were built with — it re-derives nothing new, it reads one row earlier.
   */
  const liveOp = $derived.by(() => {
    if (!ops || !index) return null;
    const cutoff = Date.parse(index.cutoff);
    return ops.find((o) =>
      selfSigned(o, asked) && o.timestamp * 1000 >= cutoff &&
      (!snapshotFinal || o.timestamp * 1000 < SNAPSHOT_TS + 40 * 60_000)) ?? null;
  });
  function when(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
</script>

<Seo
  title="Am I in the LASSECASH snapshot?"
  description="Check whether your Hive account qualifies for the LASSECASH migration to MAGI, and what to do before the snapshot block if it does not."
  canonical={`${SITE_URL}/check`}
  image={SITE_OG_IMAGE}
/>

<div class="wrap">
  <h1>Am I in the snapshot?</h1>
  <p class="lede">
    {#if snapshotFinal}
      <b class="gold">The snapshot has been taken</b> at block
      <span class="mono">{SNAPSHOT_BLOCK.toLocaleString()}</span> and it is
      final. The chain goes live today at ≈ 18:00 UTC (20:00 CET) — claims
      open on the front page of lassecash.com. Type your Hive account name to
      see what the snapshot holds for you.
    {:else}
      LASSECASH is migrating to MAGI. To be included you must have <b>signed at
      least one LASSECASH transaction</b> on Hive-Engine in the six months before
      block <span class="mono">{SNAPSHOT_BLOCK.toLocaleString()}</span> —
      {SNAPSHOT_WHEN}. Type your Hive account name.
    {/if}
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
    <button type="submit" disabled={looking || !cleanName(query)}>
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
          <dt>liquid</dt><dd class="mono">{lc(fromUnits(BigInt(row.liquid)))}</dd>
          <dt>staked (becomes a 30-day mint)</dt><dd class="mono">{lc(fromUnits(BigInt(row.staked)))}</dd>
          {#if quote}
            <dt class="est">≈ worth today</dt>
            <dd class="mono est">${usd(BigInt(row.liquid) + BigInt(row.staked))}</dd>
          {/if}
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
    {:else if missing && hiveExists === false}
      <div class="verdict none">
        <h2>There is no Hive account called @{asked}</h2>
        <p>
          Check the spelling — it is easy to swap two letters. Account names are
          lowercase, and the <span class="mono">@</span> is not part of them.
        </p>
      </div>
    {:else if missing && liveOp}
      <div class="verdict in">
        <h2>@{asked} — you are IN</h2>
        <dl>
          <dt>last LASSECASH action</dt>
          <dd class="mono">{when(liveOp.timestamp)} ({liveOp.operation.replace("tokens_", "")})</dd>
        </dl>
        <p class="note">
          You had no LASSECASH when our data was last rebuilt, and you signed
          this since — the "signed by you: yes" row below. The snapshot reads
          the chain at the block, so whatever your wallet holds then migrates:
          liquid as liquid, staked as a 30-day mint.
        </p>
        <p>
          Nothing is pushed to you. After launch you <b>claim</b> your own
          tokens with a proof, paying your own Resource Credits.
        </p>
      </div>
    {:else if missing}
      <div class="verdict none">
        <h2>@{asked} has never held LASSECASH</h2>
        <p>
          {#if hiveExists}The account exists on Hive, but there{:else}There{/if}
          is no LASSECASH balance for it on Hive-Engine, so there is nothing to
          migrate. That is not a rejection — there is simply nothing there.
        </p>
      </div>
    {:else if row && liveOp}
      <div class="verdict in">
        <h2>@{asked} — you are IN</h2>
        <dl>
          <dt>liquid</dt><dd class="mono">{lc(fromUnits(BigInt(row.liquid)))}</dd>
          <dt>staked (becomes a 30-day mint)</dt><dd class="mono">{lc(fromUnits(BigInt(row.staked)))}</dd>
          {#if quote}
            <dt class="est">≈ worth today</dt>
            <dd class="mono est">${usd(BigInt(row.liquid) + BigInt(row.staked))}</dd>
          {/if}
          <dt>last LASSECASH action</dt>
          <dd class="mono">{when(liveOp.timestamp)} ({liveOp.operation.replace("tokens_", "")})</dd>
        </dl>
        <p class="note">
          Seen <b>live on Hive-Engine</b> — the row marked "signed by you: yes"
          in the table below. Our stored verdict was rebuilt before you signed
          it; the chain has it, and the chain is what the snapshot reads.
        </p>
        <p>
          Nothing is pushed to you. After launch you <b>claim</b> your own
          tokens with a proof, paying your own Resource Credits. Claim inside
          the first 30 days and the staked half becomes a real mint that earns
          and votes.
        </p>
      </div>
    {:else if row}
      <div class="verdict out">
        <h2>@{asked} — {snapshotFinal ? "not in the snapshot" : "you are NOT in, yet"}</h2>
        {#if snapshotFinal}
          <p class="note">
            The snapshot was taken at block {SNAPSHOT_BLOCK.toLocaleString("en-US")} —
            {SNAPSHOT_WHEN}. It is final and nothing can change it now. Under the
            rule announced one week in advance, holdings of accounts that never
            signed a LASSECASH operation in the six months before the block were
            credited to @null, recorded account by account, visible forever.
          </p>
        {/if}
        {#if liveError}
          <p class="note">
            <b>Could not reach Hive-Engine just now</b>, so anything you signed
            after our last rebuild is not being checked live.
            <button type="button" class="linkish" onclick={() => recent(asked)}>Try again</button>
          </p>
        {/if}
        <dl>
          <dt>liquid</dt><dd class="mono">{lc(fromUnits(BigInt(row.liquid)))}</dd>
          <dt>staked (becomes a 30-day mint if you are in)</dt><dd class="mono">{lc(fromUnits(BigInt(row.staked)))}</dd>
          {#if quote}
            <dt class="est">≈ worth today</dt>
            <dd class="mono est">${usd(BigInt(row.liquid) + BigInt(row.staked))}</dd>
          {/if}
          <dt>last LASSECASH action</dt>
          <dd class="mono">{row.last_lassecash ?? "no record"}</dd>
          {#if cutoffDate}
            <dt>needs to be after</dt><dd class="mono">{cutoffDate}</dd>
          {/if}
        </dl>
        {#if !snapshotFinal}
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
        {/if}
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
        <div class="scroll">
        <table>
          <thead><tr><th>date</th><th>operation</th><th>amount</th><th>signed by you?</th></tr></thead>
          <tbody>
            {#each ops as o (o.transactionId + o.timestamp)}
              <tr>
                <td class="mono">{when(o.timestamp)}</td>
                <td class="mono">{o.operation.replace("tokens_", "")}</td>
                <td class="mono">{o.quantity}</td>
                <td class={selfSigned(o, asked) ? "yes" : "no"}>
                  {#if selfSigned(o, asked)}yes{:else}no — from @{o.from ?? "?"}{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        </div>
      </div>
    {:else if ops}
      <p class="dim">No LASSECASH operations found for @{asked} on Hive-Engine.</p>
    {/if}
  {/if}

  {#if quote}
    <small class="dim foot">
      Dollar figures are an <b>estimate</b>: the SWAP.HIVE:LASSECASH Diesel pool
      on Hive-Engine (<span class="mono">{quote.hivePerLc}</span> HIVE per LASSECASH)
      times HIVE/USD (<span class="mono">{Number(quote.usdPerHive).toFixed(4)}</span>),
      read just now. That pool is thin and the price moves a lot; the LASSECASH
      amount is exact, the dollar value is not.
    </small>
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
  .linkish { background: none; border: 0; padding: 0; color: var(--gold); text-decoration: underline; cursor: pointer; font: inherit; }
  .verdict h2 { margin: 0 0 0.7rem; font-size: 1.15rem; }
  h3 { font-size: 0.95rem; margin: 1.1rem 0 0.5rem; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.35rem 1rem; margin: 0 0 0.9rem; }
  dt { color: var(--dim); font-size: 0.86rem; }
  dd { margin: 0; text-align: right; }
  ol { padding-left: 1.2rem; }
  ol li { margin-bottom: 0.4rem; }
  .note { font-size: 0.88rem; color: var(--dim); background: var(--panel-2); padding: 0.6rem 0.8rem; border-radius: 6px; }
  .ops { margin-bottom: 1.2rem; }
  /* The activity table has four columns and one of them holds an account
     name. On a 390px phone it would push the page wider than the viewport,
     and CLAUDE.md's rule is that the body must NEVER scroll horizontally —
     wide content scrolls inside its own container instead. */
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; min-width: 22rem; }
  th { text-align: left; color: var(--dim); font-weight: 500; border-bottom: 1px solid var(--line); padding: 0.35rem 0.5rem 0.35rem 0; }
  td { padding: 0.3rem 0.5rem 0.3rem 0; border-bottom: 1px solid var(--line); }
  .small { font-size: 0.82rem; }
  .foot { display: block; margin-top: 1.5rem; }
  dt.est, dd.est { color: var(--dim); font-style: italic; }

  @media (max-width: 560px) {
    /* The figures are long (7,001,275.990) and the labels are prose. Side by
       side they squeeze the number onto two lines; stacked, both stay whole. */
    dl { grid-template-columns: 1fr; gap: 0.1rem; }
    dt { margin-top: 0.5rem; }
    dd { text-align: left; }
    /* Thumb-sized target, and the button under the field rather than beside
       it — at 390px a side-by-side row leaves the input too narrow to read
       your own account name back. */
    form { flex-wrap: wrap; }
    input { flex: 1 1 100%; font-size: 1rem; }
    button { flex: 1 1 100%; padding: 0.8rem; }
    .at { display: none; }
    h1 { font-size: 1.5rem; }
    .verdict { padding: 0.9rem 1rem; }
  }
</style>

<script lang="ts">
  /**
   * The burn, audited in your own browser.
   *
   * At genesis every account that did not qualify had its LASSECASH and
   * LASSECASH POWER credited to @null — provably unspendable, because Hive's
   * null account has no keys. The per-account record is the published leaf
   * list; the chain holds the committed Merkle root and the aggregate.
   *
   * This page does three things, none of which requires trusting us:
   *   1. recomputes the root from the published file, in the browser, and
   *      compares it with the root the contract committed at genesis;
   *   2. reconciles the file's totals against the chain's own numbers;
   *   3. lists every burned account, searchable.
   *
   * Lasse asked for it 2026-09-11 to double-check the burn was done right.
   * It is public rather than an admin page on purpose — an audit only anyone
   * can run is worth more than one only the founder can.
   */
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import { chain, client } from "$lib/chain.svelte.js";
  import { lc } from "$lib/format.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";

  /** [account, liquid, staked, burned] exactly as the tree hashed it. */
  type Leaf = [string, string, string, boolean];

  let leaves = $state<Leaf[] | null>(null);
  let loadError = $state<string | null>(null);
  let query = $state("");
  let shown = $state(100);
  let rootFromFile = $state<string | null>(null);
  /** The root the contract committed at genesis — `cfg_migroot`, read live. */
  let chainRoot = $state<string | null>(null);
  let verifying = $state(false);

  onMount(async () => {
    try {
      const r = await fetch(`${base}/migration/leaves.json`);
      if (!r.ok) throw new Error(`leaves.json: ${r.status}`);
      leaves = (await r.json()) as Leaf[];
      chainRoot = await client.migrationRoot();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  });

  const burnedLeaves = $derived((leaves ?? []).filter((l) => l[3]));
  const claimableLeaves = $derived((leaves ?? []).filter((l) => !l[3]));
  const sum = (rows: Leaf[]) =>
    rows.reduce((a, l) => a + BigInt(l[1] || "0") + BigInt(l[2] || "0"), 0n);
  const burnedUnits = $derived(sum(burnedLeaves));
  const claimUnits = $derived(sum(claimableLeaves));

  const info = $derived(chain.info);
  const asUnits = (a: string | undefined) =>
    a ? BigInt(a.replace(".", "").replace(/^0+(?=\d)/, "") || "0") : 0n;
  /** Burns since genesis = null's live balance minus the genesis figure. */
  const sinceUnits = $derived(
    info ? asUnits(info.total_burned) - asUnits(info.snapshot_burned) : 0n,
  );
  const fmtUnits = (u: bigint) => {
    const s = (u < 0n ? -u : u).toString().padStart(9, "0");
    return `${u < 0n ? "-" : ""}${s.slice(0, -8)}.${s.slice(-8)}`;
  };

  const matchesChainBurn = $derived(
    !!info && leaves !== null && burnedUnits === asUnits(info.snapshot_burned),
  );
  const matchesChainClaim = $derived.by(() => {
    if (!info || leaves === null) return false;
    const snapshotTotal = asUnits(info.snapshot_total);
    return claimUnits === snapshotTotal - asUnits(info.snapshot_burned);
  });

  const rows = $derived.by(() => {
    const q = query.trim().toLowerCase().replace(/^@/, "");
    const list = q
      ? burnedLeaves.filter((l) => l[0].toLowerCase().includes(q))
      : burnedLeaves;
    return [...list]
      .sort((a, b) => {
        const x = BigInt(a[1]) + BigInt(a[2]), y = BigInt(b[1]) + BigInt(b[2]);
        return x > y ? -1 : x < y ? 1 : 0;
      })
      .slice(0, shown);
  });

  /**
   * The root, recomputed here: leaf = sha256(domain|account|liquid|staked|m|b),
   * parents hash the pair in SORTED order (so no direction bits are needed),
   * and an odd node at the end of a level is promoted unchanged — never
   * duplicated, which would let one proof serve two positions. Identical to
   * engine/merkle.go; if this disagrees with the chain, the file was edited.
   */
  async function verifyRoot() {
    if (!leaves || verifying) return;
    verifying = true;
    try {
      const enc = new TextEncoder();
      const sha = async (b: Uint8Array) =>
        new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
      let level: Uint8Array[] = [];
      for (const [acct, liquid, staked, burned] of leaves) {
        level.push(await sha(enc.encode(
          `lassecash-migration-leaf-v1|${acct}|${liquid}|${staked}|${burned ? "b" : "m"}`)));
      }
      const less = (a: Uint8Array, b: Uint8Array) => {
        for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
        return false;
      };
      while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < level.length; i += 2) {
          if (i + 1 < level.length) {
            const [x, y] = less(level[i]!, level[i + 1]!)
              ? [level[i]!, level[i + 1]!] : [level[i + 1]!, level[i]!];
            const buf = new Uint8Array(64);
            buf.set(x, 0); buf.set(y, 32);
            next.push(await sha(buf));
          } else next.push(level[i]!);
        }
        level = next;
      }
      rootFromFile = [...level[0]!].map((n) => n.toString(16).padStart(2, "0")).join("");
    } finally {
      verifying = false;
    }
  }
</script>

<Seo
  title="The burn, audited"
  description="Every account that did not migrate, the amount credited to @null, and the Merkle root recomputed in your own browser."
  canonical={`${SITE_URL}/burned`}
  image={SITE_OG_IMAGE}
/>

<div class="wrap">
  <h1>The burn</h1>
  <p class="lede">
    At genesis every account that did not qualify had its LASSECASH and
    LASSECASH POWER credited to <strong>@null</strong> — Hive's null account has
    no keys, so nobody can ever spend it. Nothing here is taken on trust: the
    list below is the same file the Merkle root was built from, and you can
    recompute that root in this browser and compare it with what the contract
    committed.
  </p>

  {#if loadError}
    <p class="err">Could not load the leaf list: {loadError}</p>
  {:else if !leaves}
    <p class="empty">Loading the published leaf list…</p>
  {:else}
    <section class="panel">
      <div class="label">The file against the chain</div>
      <dl>
        <dt>Leaves published</dt>
        <dd class="mono">{leaves.length.toLocaleString()} — {claimableLeaves.length.toLocaleString()} claimable, {burnedLeaves.length.toLocaleString()} burned</dd>

        <dt>Burned at genesis, from the file</dt>
        <dd class="mono">{lc(fmtUnits(burnedUnits))}</dd>
        <dt>Burned at genesis, on chain</dt>
        <dd class="mono">
          {info ? lc(info.snapshot_burned) : "—"}
          {#if info}<span class="pill" class:ok={matchesChainBurn} class:bad={!matchesChainBurn}>{matchesChainBurn ? "match" : "MISMATCH"}</span>{/if}
        </dd>

        <dt>Claimable, from the file</dt>
        <dd class="mono">{lc(fmtUnits(claimUnits))}</dd>
        <dt>Claimable, on chain</dt>
        <dd class="mono">
          {info ? lc(fmtUnits(asUnits(info.snapshot_total) - asUnits(info.snapshot_burned))) : "—"}
          {#if info}<span class="pill" class:ok={matchesChainClaim} class:bad={!matchesChainClaim}>{matchesChainClaim ? "match" : "MISMATCH"}</span>{/if}
        </dd>
      </dl>

      <div class="rootrow">
        <button class="small" onclick={verifyRoot} disabled={verifying}>
          {verifying ? "Hashing 11,238 leaves…" : "Recompute the root from this file"}
        </button>
        {#if rootFromFile}
          <span class="pill" class:ok={rootFromFile === chainRoot} class:bad={rootFromFile !== chainRoot}>
            {rootFromFile === chainRoot ? "identical to the chain's root" : "DOES NOT MATCH"}
          </span>
        {/if}
      </div>
      {#if rootFromFile}
        <p class="note mono small-cid">file&nbsp;&nbsp;{rootFromFile}</p>
        <p class="note mono small-cid">chain&nbsp;{chainRoot ?? "—"}</p>
      {/if}
    </section>

    <section class="panel">
      <div class="label">@null's balance today</div>
      <dl>
        <dt>Burned at genesis</dt><dd class="mono">{info ? lc(info.snapshot_burned) : "—"}</dd>
        <dt>Burned since</dt>
        <dd class="mono">{info ? lc(fmtUnits(sinceUnits)) : "—"}
          <small class="dim">— promoted posts, payouts the author chose to burn, and anything sent to @null</small>
        </dd>
        <dt>Held by @null now</dt><dd class="mono gold">{info ? lc(info.total_burned) : "—"}</dd>
      </dl>
    </section>

    <section class="panel">
      <div class="thead">
        <h2>Every burned account</h2>
        <input class="mono" placeholder="search an account" bind:value={query} />
      </div>
      <div class="scroll">
        <table>
          <thead><tr><th>Account</th><th class="num">Liquid</th><th class="num">Power</th><th class="num">Total</th></tr></thead>
          <tbody>
            {#each rows as l (l[0])}
              <tr>
                <td class="mono">@{l[0].replace(/^hive:/, "")}</td>
                <td class="num mono">{lc(fmtUnits(BigInt(l[1])), 2)}</td>
                <td class="num mono">{lc(fmtUnits(BigInt(l[2])), 2)}</td>
                <td class="num mono">{lc(fmtUnits(BigInt(l[1]) + BigInt(l[2])), 2)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if rows.length === 0}
        <p class="empty">No burned account matches that.</p>
      {:else if !query && shown < burnedLeaves.length}
        <button class="small" onclick={() => (shown += 500)}>
          Show more — {shown.toLocaleString()} of {burnedLeaves.length.toLocaleString()}
        </button>
      {/if}
    </section>
  {/if}
</div>

<style>
  .wrap { max-width: 1000px; margin: 0 auto; padding: 1rem; }
  h1 { margin: 0 0 0.4rem; }
  .lede { color: var(--dim); max-width: 62ch; }
  .panel { border: 1px solid var(--line); background: var(--panel); padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .label { font-family: var(--mono); font-size: 0.8rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); margin-bottom: 0.6rem; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.35rem 1rem; margin: 0; }
  dt { color: var(--dim); }
  dd { margin: 0; text-align: right; }
  .rootrow { display: flex; gap: 0.7rem; align-items: center; flex-wrap: wrap; margin-top: 0.8rem; }
  .small-cid { font-size: 0.78rem; word-break: break-all; margin: 0.2rem 0 0; }
  .thead { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .thead h2 { font-size: 1rem; margin: 0; }
  .thead input { background: #0d1117; border: 1px solid var(--line); color: var(--fg); padding: 0.4rem 0.6rem; border-radius: 4px; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.6rem; }
  th, td { padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line); }
  th { font-family: var(--mono); font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--dim); text-align: left; }
  .num { text-align: right; }
  .pill.ok { color: var(--green, #5ad37a); }
  .pill.bad { color: var(--red, #f25f5c); }
  .err { color: var(--red, #f25f5c); }
</style>

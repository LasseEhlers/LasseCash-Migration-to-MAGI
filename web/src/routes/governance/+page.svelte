<script lang="ts">
  /**
   * Governance — the standing-median board.
   *
   * There are no proposals, no quorum, no voting rounds and nothing to time or
   * snipe. Each of the top ten L-Share holders keeps a standing preferred value
   * for every governable parameter, changeable at any time, and the LOWER
   * MEDIAN of those preferences is simply what is in force, continuously.
   *
   * WHAT THIS PAGE IS FOR. After the key burn nobody can add a parameter,
   * change a bound or ship new logic — so the small set of dials that CAN move
   * is the entire mutable surface of the protocol. It should be public,
   * legible, and show who is turning what.
   *
   * NOTHING IS COMPUTED HERE. `engine.consensusGroup` ranks the board into ten
   * seats; `engine.effectiveValue` clamps each preference into the parameter's
   * hardcoded bounds and takes the lower median. Both are the identical Go the
   * contract runs in `EffectiveParam`. The one arithmetic on this page is a
   * subtraction — how many more L-Shares seat ten needs — and it is labelled as
   * a display figure, because it is.
   */
  import { onMount } from "svelte";
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, lc, lcShort } from "$lib/format.js";
  import { governableParams, readGovernance, type GovernanceView } from "$lib/governance.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_NAME, SITE_URL } from "$lib/site.js";
  import { compare, constants, fromUnits, toUnits, type EffectiveValue } from "$api/index.js";

  let view = $state<GovernanceView | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  /** paramKey -> the value this member is about to set. */
  let drafts = $state<Record<string, string>>({});
  let saving = $state<string | null>(null);

  const params = $derived(chain.ready ? governableParams() : []);

  /** The signed-in account's seat, if it holds one. */
  const mySeat = $derived.by(() => {
    if (!chain.account || !view) return null;
    const i = view.seats.findIndex((m) => m.account === chain.account);
    return i < 0 ? null : { rank: i + 1, member: view.seats[i]! };
  });

  /**
   * How many more L-Shares the signed-in account needs for seat ten.
   *
   * A SUBTRACTION FOR DISPLAY, and nothing more — it decides nothing and the
   * chain never sees it. `toUnits`/`fromUnits` keep it in base units, because
   * L-Share balances leave JavaScript's safe integer range long before the
   * hardcap does.
   */
  const shortfall = $derived.by(() => {
    if (!view || mySeat || !chain.me) return null;
    if (view.seats.length < 10) return null; // there is a free seat already
    const tenth = view.seats[9]!;
    const gap = toUnits(tenth.shares) - toUnits(chain.me.shares);
    return gap > 0n ? fromUnits(gap) : null;
  });

  async function load() {
    try {
      view = await readGovernance(params.map((p) => p.key));
      // Seed every editable field with what is in force, so a member nudging
      // one value never has to retype the others.
      const next: Record<string, string> = {};
      for (const p of params) next[p.key] = view.values.get(p.key)?.value ?? "0";
      drafts = next;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Waits for the engine: the parameter KEYS come out of `constants()`, so
  // there is nothing to fetch until the WASM is callable.
  $effect(() => {
    if (chain.ready && view === null && loading) void load();
  });
  onMount(() => { if (!chain.ready) loading = true; });

  /** A member's own standing preference for a parameter, or null. */
  function preferenceOf(account: string, key: string): string | null {
    const row = view?.rows.find((r) => r.account === account);
    const raw = row?.preferences[key];
    return raw ? fromUnits(BigInt(raw)) : null;
  }

  function inBounds(v: EffectiveValue, value: string): boolean {
    return compare(value, v.min) >= 0 && compare(value, v.max) <= 0;
  }

  async function setParam(key: string, v: EffectiveValue) {
    const value = drafts[key] ?? "";
    if (!inBounds(v, value)) return;
    saving = key;
    try {
      // The chain takes BASE UNITS; the bounds it enforces are the same ones
      // shown above the slider, hardcoded in the contract and un-negotiable.
      error = await chain.submit(() => client.setParam(key, toUnits(value).toString()));
      if (!error) await load();
    } finally {
      saving = null;
    }
  }

  /** Slider granularity: a thousandth of the range, never zero. */
  function stepFor(v: EffectiveValue): number {
    const span = Number(v.max) - Number(v.min);
    return span > 0 ? Math.max(span / 1000, 0.00000001) : 1;
  }
</script>

<Seo
  title="Governance"
  description="The ten seats, their standing preferences, and the median in force for every governable LasseCash parameter."
  canonical={`${SITE_URL}/governance`}
  schema={{
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${SITE_NAME} — Governance`,
    url: `${SITE_URL}/governance`,
  }}
/>

<div class="grid">
  <section class="panel intro">
    <h2>Median governance</h2>
    <p>
      Each of the top ten L-Share holders keeps a <strong>standing preferred
      value</strong> for every governable parameter, changeable at any time, and
      the <strong class="gold">median of those ten numbers is what is in
      force</strong> — no proposals, no quorum, no voting rounds.
    </p>
    <p>
      Every parameter carries a <strong>hardcoded floor and ceiling that no vote
      can leave</strong>: the committee can move a value inside its range and
      can never move the range, no matter who controls the seats.
    </p>
    <p class="fine dim">
      L-Shares buy a seat, not extra weight within it — each seat contributes
      exactly one number to the median, so an extreme vote is self-neutralising.
      Even parity takes the lower median, in exact integers, so every node
      computes the same value. Everything NOT listed below is immutable: the
      51M hardcap, the halving curve, the 0% swap fee, both 1.5x ceilings, the
      50/25/25 split.
    </p>
  </section>

  {#if error}<div class="panel err">{error}</div>{/if}

  {#if !chain.ready || loading}
    <p class="empty"><strong>Reading the board…</strong></p>
  {:else if !view}
    <p class="empty"><strong>Could not read governance from the chain.</strong></p>
  {:else}
    <!-- Who holds the ten seats. Derived by the engine from live L-Share
         balances, which is the same derivation a foreign dApp contract makes
         against the frozen public state ABI. -->
    <section class="panel">
      <h2>The ten seats</h2>
      {#if view.seats.length === 0}
        <p class="dim auto">No account holds L-Shares yet — the registered defaults stand.</p>
      {:else}
        <ol class="seats">
          {#each view.seats as seat, i (seat.account)}
            <li class:me={seat.account === chain.account}>
              <span class="rank mono">{i + 1}</span>
              <a class="who" href="/{displayName(seat.account)}">{displayName(seat.account)}</a>
              <span class="shares mono">{lcShort(seat.shares)}</span>
            </li>
          {/each}
        </ol>
      {/if}

      {#if chain.account && !mySeat}
        <p class="standing dim">
          {#if shortfall}
            <strong>Not in the top 10</strong> — {lc(shortfall, 3)} more L-Shares
            for seat 10.
            <span class="fine">(seat 10 holds {lc(view.seats[9]?.shares ?? "0", 3)}; you hold {lc(chain.me?.shares ?? "0", 3)} — a display figure, and both move.)</span>
          {:else if view.seats.length < 10}
            <strong>Seats are unfilled.</strong> Mint LASSECASH and call
            <span class="mono">promote</span> to take one.
          {:else}
            <strong>Not in the top 10.</strong>
          {/if}
        </p>
      {:else if mySeat}
        <p class="standing seated">
          <strong class="gold">You hold seat {mySeat.rank}.</strong>
          Your preferences below are live — the median moves the moment you set one.
        </p>
      {/if}
    </section>

    {#each params as p (p.key)}
      {@const v = view.values.get(p.key)}
      {#if v?.ok}
        <section class="panel param">
          <h2>{p.label}</h2>
          <p class="what dim">{p.what}</p>

          <div class="headline">
            <div class="force">
              <span class="k">Median in force</span>
              <span class="val gold mono">{lc(v.value, 3)}</span>
              <span class="unit">{p.unit === "shares" ? "L-Shares" : "LASSECASH"}</span>
            </div>
            <dl class="bounds">
              <dt>Floor</dt><dd class="mono">{lc(v.min, 3)}</dd>
              <dt>Default</dt><dd class="mono">{lc(v.defaultValue, 3)}</dd>
              <dt>Ceiling</dt><dd class="mono">{lc(v.max, 3)}</dd>
            </dl>
          </div>
          <p class="fine dim">
            Floor and ceiling are hardcoded in the contract. They are not
            themselves governable — a bounds table a committee could widen would
            be no bounds at all.
          </p>

          <!-- The ten standing preferences that produce the median above. -->
          <table>
            <thead>
              <tr><th>Seat</th><th>Member</th><th class="num">L-Shares</th><th class="num">Standing preference</th></tr>
            </thead>
            <tbody>
              {#each view.seats as seat, i (seat.account)}
                {@const pref = preferenceOf(seat.account, p.key)}
                <tr class:me={seat.account === chain.account}>
                  <td class="mono dim">{i + 1}</td>
                  <td><a href="/{displayName(seat.account)}">{displayName(seat.account)}</a></td>
                  <td class="num mono dim">{lcShort(seat.shares)}</td>
                  <td class="num mono">
                    {#if pref}
                      {lc(pref, 3)}
                    {:else}
                      <!-- ABSENT IS NOT ZERO. The engine skips a member who has
                           never voted rather than counting them at the floor. -->
                      <span class="dim">not voted</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>

          {#if mySeat}
            <div class="editor">
              <label class="row-edit">
                <span class="k">Your preference</span>
                <input
                  type="range"
                  min={Number(v.min)}
                  max={Number(v.max)}
                  step={stepFor(v)}
                  value={Number(drafts[p.key] ?? v.value)}
                  oninput={(e) => (drafts = { ...drafts, [p.key]: e.currentTarget.value })}
                />
              </label>
              <div class="exact">
                <input
                  inputmode="decimal"
                  bind:value={drafts[p.key]}
                  aria-label="{p.label} exact value"
                />
                <button
                  class="small"
                  onclick={() => setParam(p.key, v)}
                  disabled={chain.busy || saving === p.key || !inBounds(v, drafts[p.key] ?? "")}
                >
                  {saving === p.key ? "Setting…" : "Set"}
                </button>
              </div>
              {#if !inBounds(v, drafts[p.key] ?? "")}
                <p class="oob">
                  Outside [{lc(v.min, 3)} … {lc(v.max, 3)}]. The chain refuses
                  this rather than silently clamping it to something you did not
                  choose.
                </p>
              {/if}
            </div>
          {/if}
        </section>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .intro p { margin: 0 0 0.6rem; font-size: var(--t-sm); line-height: 1.7; max-width: 68ch; }
  .intro p:last-child { margin: 0; }
  .fine { font-size: var(--t-tiny); line-height: 1.6; }
  .auto { font-size: var(--t-sm); margin: 0; }
  .err { color: var(--red); font-size: var(--t-sm); }

  .seats { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.2rem; }
  .seats li {
    display: flex; align-items: center; gap: 0.6rem; padding: 0.25rem 0.4rem;
    border-radius: var(--r-sm); font-size: var(--t-sm);
  }
  .seats li.me { background: rgba(255, 210, 63, 0.08); }
  .seats .rank { color: var(--dimmer); width: 1.4rem; font-size: var(--t-micro); }
  .seats .who { color: var(--gold); font-family: var(--mono); font-weight: 700; }
  .seats .who:hover { text-decoration: underline; }
  .seats .shares { margin-left: auto; color: var(--dim); font-size: var(--t-tiny); }

  .standing {
    margin: 0.85rem 0 0; font-size: var(--t-sm); line-height: 1.6;
    border-top: 1px solid var(--line-soft); padding-top: 0.7rem;
  }
  .standing.seated { color: var(--dim); }

  .what { margin: 0 0 0.85rem; font-size: var(--t-sm); line-height: 1.6; max-width: 68ch; }

  .headline { display: flex; gap: 1.6rem; flex-wrap: wrap; align-items: flex-end; }
  .force .k {
    display: block; color: var(--dim); font-size: var(--t-micro);
    letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700;
    font-family: var(--mono);
  }
  .force .val {
    font-size: var(--t-xl); font-weight: 800; font-variant-numeric: tabular-nums;
    text-shadow: var(--glow-gold); line-height: 1.2;
  }
  .force .unit { color: var(--dimmer); font-size: var(--t-micro); font-family: var(--mono); margin-left: 0.35rem; }

  .bounds {
    display: grid; grid-template-columns: auto auto; gap: 0.2rem 0.8rem;
    margin: 0; font-size: var(--t-tiny);
  }
  .bounds dt { color: var(--dim); }
  .bounds dd { margin: 0; text-align: right; }

  .param .fine { margin: 0.5rem 0 0.9rem; }

  table { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
  th {
    text-align: left; color: var(--dim); font-weight: 700; font-size: var(--t-micro);
    letter-spacing: 0.1em; text-transform: uppercase; font-family: var(--mono);
    border-bottom: 1px solid var(--line); padding: 0.3rem 0.5rem;
  }
  td { padding: 0.28rem 0.5rem; border-bottom: 1px solid var(--line-soft); }
  th.num, td.num { text-align: right; }
  tr.me td { background: rgba(255, 210, 63, 0.06); }
  td a { color: var(--ink); font-family: var(--mono); }
  td a:hover { color: var(--gold); }

  .editor {
    margin-top: 0.9rem; padding-top: 0.8rem; border-top: 1px solid var(--line);
  }
  .row-edit .k {
    display: block; color: var(--dim); font-size: var(--t-micro);
    letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700;
    font-family: var(--mono); margin-bottom: 0.3rem;
  }
  .row-edit input[type="range"] { width: 100%; }
  .exact { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
  .exact input { flex: 1 1 auto; }
  .oob { color: var(--amber); font-size: var(--t-tiny); margin: 0.45rem 0 0; line-height: 1.55; }

  @media (max-width: 720px) {
    .headline { gap: 0.9rem; }
    table { display: block; overflow-x: auto; }
  }
</style>

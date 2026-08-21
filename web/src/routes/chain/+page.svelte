<script lang="ts">
  /**
   * Chain — supply, emission and governance.
   *
   * The supply figures are the ones critics will check, so they are shown
   * plainly and sourced from chain state, not from anything computed here.
   */
  import { chain } from "$lib/chain.svelte.js";
  import { displayName, lc, lcShort } from "$lib/format.js";
  import { blockSplit, constants, toBaseUnitArg } from "$api/index.js";

  const info = $derived(chain.info);
  const C = $derived(chain.ready ? constants() : null);

  const HARDCAP = 51_000_000;
  const EMISSION_CAP = 20_000_000;

  /** Headroom under the 51M hardcap: migrated + everything still to be emitted. */
  const maxEver = $derived(
    info ? Number(info.migrated_supply) + EMISSION_CAP : 0,
  );
  const emittedPct = $derived(
    info ? (Number(info.total_emitted) / EMISSION_CAP) * 100 : 0,
  );

  /** How one block reward divides. Engine-computed, so it can never drift. */
  const split = $derived(
    chain.ready ? blockSplit(toBaseUnitArg("100")) : null,
  );

  const yearsIn = $derived(
    info ? (info.height - info.genesis_height) / (365 * 28_800) : 0,
  );
</script>

<div class="grid">
  <section class="stats">
    <div class="panel stat">
      <div class="label">Migrated supply</div>
      <div class="value">{info ? lcShort(info.migrated_supply) : "—"}</div>
      <div class="sub">credited at the snapshot</div>
    </div>
    <div class="panel stat">
      <div class="label">Emitted since genesis</div>
      <div class="value gold">{info ? lcShort(info.total_emitted) : "—"}</div>
      <div class="sub">{emittedPct.toFixed(3)}% of the 20M cap</div>
    </div>
    <div class="panel stat">
      <div class="label">Burned</div>
      <div class="value">{info ? lcShort(info.total_burned) : "—"}</div>
      <div class="sub">destroyed permanently</div>
    </div>
    <div class="panel stat">
      <div class="label">Chain age</div>
      <div class="value">{yearsIn.toFixed(2)}y</div>
      <div class="sub">height {info?.height.toLocaleString() ?? "—"}</div>
    </div>
  </section>

  <div class="row layout">
    <section class="panel">
      <h2>Supply against the hardcap</h2>
      {#if info}
        <div class="bar">
          <div class="seg migrated" style="width:{(Number(info.migrated_supply) / HARDCAP) * 100}%"></div>
          <div class="seg emitted" style="width:{(Number(info.total_emitted) / HARDCAP) * 100}%"></div>
          <div class="seg future" style="width:{((EMISSION_CAP - Number(info.total_emitted)) / HARDCAP) * 100}%"></div>
        </div>
        <div class="legend">
          <span><i class="migrated"></i> migrated {lcShort(info.migrated_supply)}</span>
          <span><i class="emitted"></i> emitted {lcShort(info.total_emitted)}</span>
          <span><i class="future"></i> still to emit</span>
          <span><i class="head"></i> headroom</span>
        </div>
        <dl>
          <dt>Migrated supply</dt><dd class="mono">{lc(info.migrated_supply)}</dd>
          <dt>+ maximum future emission</dt><dd class="mono">20,000,000.000</dd>
          <dt>= maximum ever</dt><dd class="mono gold">{lc(String(maxEver.toFixed(8)))}</dd>
          <dt>Historic hardcap</dt><dd class="mono">51,000,000.000</dd>
          <dt><strong>Headroom</strong></dt>
          <dd class="mono green"><strong>{lc(String((HARDCAP - maxEver).toFixed(8)))}</strong></dd>
        </dl>
        <small class="dim">
          The 51M cap covers everything ever issued, before and after migration.
          Emission approaches 20M asymptotically and never reaches it — every
          division floors, so rounding can only ever under-issue.
        </small>
      {/if}
    </section>

    <aside class="side">
      <div class="panel">
        <h2>Where each block reward goes</h2>
        {#if split}
          <ul class="split">
            <li>
              <span class="k">Proof-of-Brain</span>
              <span class="v mono">{Number(split.proofOfBrain).toFixed(0)}%</span>
              <ul>
                <!-- Shown as a share of the Proof-of-Brain slice they sit
                     under, not of the whole block reward: nested beneath "50%",
                     12.5% and 37.5% read as though they do not add up. -->
                <li>
                  <span class="k">Viral — 7 day</span>
                  <span class="v mono">{((Number(split.viral) / Number(split.proofOfBrain)) * 100).toFixed(0)}% of it</span>
                </li>
                <li>
                  <span class="k">Deep — 30 day</span>
                  <span class="v mono">{((Number(split.deep) / Number(split.proofOfBrain)) * 100).toFixed(0)}% of it</span>
                </li>
              </ul>
            </li>
            <li><span class="k">L-Share yield</span><span class="v mono">{Number(split.lshare).toFixed(0)}%</span></li>
            <li><span class="k">Liquidity</span><span class="v mono">{Number(split.liquidity).toFixed(0)}%</span></li>
          </ul>
        {/if}
      </div>

      {#if info}
        <div class="panel">
          <h2>Unclaimed reward pools</h2>
          <dl>
            <dt>L-Share</dt><dd class="mono gold">{lc(info.pool_lshare)}</dd>
            <dt>Viral</dt><dd class="mono">{lc(info.pool_viral)}</dd>
            <dt>Deep</dt><dd class="mono">{lc(info.pool_deep)}</dd>
            <dt>Liquidity</dt><dd class="mono">{lc(info.pool_liquidity)}</dd>
          </dl>
        </div>
      {/if}
    </aside>
  </div>

  <section class="panel">
    <h2>Consensus group — the top 10 L-Share holders</h2>
    {#if info && info.consensus_group.length > 0}
      <ol class="group">
        {#each info.consensus_group as account, i (account)}
          <li>
            <span class="rank mono">{i + 1}</span>
            <span class="who">{displayName(account)}</span>
            {#if account === chain.account}<span class="pill info">you</span>{/if}
          </li>
        {/each}
      </ol>
    {:else}
      <p class="empty">No L-Shares minted yet.</p>
    {/if}
    <small class="dim">
      There are no proposals. Each member keeps a standing preferred value for
      each governable parameter, and the <strong>median</strong> is what applies —
      continuously, with nothing to time or tally. Every parameter carries
      hardcoded bounds the group cannot leave, so even total capture of all ten
      seats cannot push a value out of range.
    </small>
  </section>

  {#if C}
    <section class="panel">
      <h2>Protocol constants</h2>
      <div class="consts">
        <span><b class="mono">{C.maxMintDays}</b> days maximum mint</span>
        <span><b class="mono">{C.graceDays}</b> day grace after maturity</span>
        <span><b class="mono">{C.bleedDays}</b> day bleed to zero</span>
        <span><b class="mono">{C.goodAcctGrace}</b> day grace with Good Accounting</span>
        <span><b class="mono">{C.loyaltyMaxDays}</b> days to max liquidity loyalty</span>
        <span><b class="mono">{C.fullVoteCostPct}%</b> vote power per full vote</span>
        <span><b class="mono">{C.secondsPerHeight}s</b> per height</span>
        <span><b class="mono">{C.decimals}</b> decimals</span>
      </div>
      <small class="dim">Read from the engine — the interface never hardcodes a bound the chain enforces.</small>
    </section>
  {/if}
</div>

<style>
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
  @media (max-width: 720px) {
    /* Two-up rather than one tall column per figure. */
    .stats { grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  }
  .layout { align-items: flex-start; }
  .layout > section { flex: 1 1 520px; }
  .side { flex: 1 1 300px; display: flex; flex-direction: column; gap: 1rem; }
  .bar { display: flex; height: 26px; border-radius: 6px; overflow: hidden; background: #0d1117; border: 1px solid var(--line); }
  .seg.migrated { background: var(--gold); }
  .seg.emitted { background: var(--green); }
  .seg.future { background: #2f4a3c; }
  .legend { display: flex; gap: 1rem; flex-wrap: wrap; margin: 0.6rem 0 1rem; font-size: 0.78rem; color: var(--dim); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 0.3rem; }
  .legend i.migrated { background: var(--gold); }
  .legend i.emitted { background: var(--green); }
  .legend i.future { background: #2f4a3c; }
  .legend i.head { background: #0d1117; border: 1px solid var(--line); }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.4rem 1rem; margin: 0 0 0.8rem; }
  dt { color: var(--dim); font-size: 0.86rem; }
  dd { margin: 0; text-align: right; }
  ul.split { list-style: none; margin: 0; padding: 0; }
  ul.split ul { list-style: none; margin: 0.3rem 0 0.3rem 1rem; padding: 0; }
  ul.split li { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; padding: 0.25rem 0; }
  ul.split li ul { grid-column: 1 / -1; }
  ul.split .k { color: var(--dim); font-size: 0.88rem; }
  ol.group { list-style: none; margin: 0 0 0.9rem; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 0.4rem; }
  ol.group li { display: flex; align-items: center; gap: 0.55rem; background: var(--panel-2); border-radius: 6px; padding: 0.4rem 0.6rem; }
  .rank { color: var(--dim); width: 1.4rem; }
  .who { font-weight: 600; }
  .consts { display: flex; flex-wrap: wrap; gap: 0.5rem 1.4rem; margin-bottom: 0.7rem; font-size: 0.88rem; color: var(--dim); }
  .consts b { color: var(--ink); }
</style>

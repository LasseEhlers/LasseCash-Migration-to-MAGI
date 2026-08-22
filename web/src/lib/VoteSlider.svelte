<script lang="ts">
  /**
   * The vote slider.
   *
   * THIS IS WHY THE GOLDEN RULE CHANGED. A backend round-trip on every drag
   * event would feel broken — and it would buy latency without buying accuracy,
   * because the real payout depends on every vote cast between preview and
   * broadcast. So the estimate is computed locally by the browser engine (the
   * same Go code the chain runs) and labelled as an estimate.
   *
   * The vote power cost is EXACT — it is a pure function of the weight. The
   * LASSECASH figure is an ESTIMATE, because it divides a pool that is still
   * growing among rshares that are still arriving.
   */
  import { chain, client, wallet } from "$lib/chain.svelte.js";
  import { lc, fractionPct } from "$lib/format.js";
  import { voteCost, voteWeight, votePower, toBaseUnitArg, type PostView } from "$api/index.js";

  let { post, onvoted }: { post: PostView; onvoted?: () => void } = $props();

  // Remembered per browser: a curator's habitual weight (the old site's "7%"
  // people) should not reset to 100% every time — a 100% fat-finger cannot be
  // undone on the contract, only replaced.
  const WEIGHT_KEY = "lassecash:vote-weight";
  let weight = $state(100);
  try {
    const saved = Number(localStorage.getItem(WEIGHT_KEY));
    if (saved >= 1 && saved <= 100) weight = saved;
  } catch { /* no storage: default stands */ }
  let open = $state(false);
  let error = $state<string | null>(null);

  const me = $derived(chain.me);
  const height = $derived(chain.info?.height ?? 0);
  const isDeep = $derived(post.window === "deep");

  /** Current vote power for this window. EXACT — regeneration is deterministic. */
  const power = $derived.by(() => {
    if (!chain.ready || !me) return null;
    return isDeep ? me.vote_power.deep : me.vote_power.viral;
  });

  /** What this vote costs in power. EXACT. */
  const cost = $derived(chain.ready ? voteCost(weight) : "0.00000000");

  const canAfford = $derived(power !== null && Number(cost) <= Number(power));

  /**
   * ESTIMATE of what this vote adds to the post's payout.
   *
   * rshares are exact; converting them to LASSECASH divides a pool that is
   * still growing among rshares still arriving, so the figure will move.
   */
  const estimate = $derived.by(() => {
    if (!chain.ready || !me || !chain.info) return null;
    try {
      const myRshares = voteWeight(toBaseUnitArg(me.shares), toBaseUnitArg(cost));
      const postRshares = Number(post.rshares);
      const newTotal = postRshares + Number(toBaseUnitArg(myRshares));
      if (newTotal <= 0) return null;
      // The post's slice grows by my share of the new total.
      const pending = Number(post.pending_payout);
      const added = pending * (Number(toBaseUnitArg(myRshares)) / newTotal);
      return { rshares: myRshares, added: added.toFixed(8) };
    } catch { return null; }
  });

  async function cast() {
    error = null;
    error = await chain.submit(() => client.vote(post.author, post.permlink, weight));
    if (!error) {
      try { localStorage.setItem(WEIGHT_KEY, String(weight)); } catch { /* fine */ }
      open = false; onvoted?.();
    }
  }
</script>

{#if !open}
  <button class="ghost small" onclick={() => (open = true)} disabled={!chain.account}>
    {chain.account ? "Vote" : "Sign in to vote"}
  </button>
{:else}
  <div class="voter">
    <div class="head">
      <strong>{weight}%</strong>
      <button class="ghost small" onclick={() => (open = false)}>✕</button>
    </div>

    <input type="range" min="1" max="100" bind:value={weight} />

    <div class="readout">
      <div class="line">
        <span class="dim">Costs</span>
        <b class="mono" class:red={!canAfford}>{fractionPct(cost)}</b>
        <span class="dim">of your {isDeep ? "deep" : "viral"} power</span>
      </div>
      {#if power !== null}
        <div class="meter">
          <div class="fill" style="width:{Number(power) * 100}%"></div>
          <div class="spend" style="width:{Math.min(Number(cost), Number(power)) * 100}%"></div>
        </div>
        <div class="line small">
          <span class="dim">{fractionPct(power)} available · recharges fully in {isDeep ? 30 : 7} days</span>
        </div>
      {/if}

      {#if !post.registered}
        <!-- The cost above is the same either way: it is a pure function of
             the weight and this account's shares. What is different is what
             the vote DOES — it registers the post, which is worth saying
             plainly, because the voter is doing the author a favour they
             cannot do for themselves from another frontend. -->
        <p class="estimate">
          Your vote opens this post's 7-day window. It has no reward figure yet
          because the chain has no record of it — casting the first vote
          registers it as a viral post.
        </p>
      {:else if estimate}
        <div class="line">
          <span class="dim">Adds about</span>
          <b class="gold mono">{lc(estimate.added, 4)}</b>
          <span class="dim">LASSECASH to this post</span>
        </div>
        <p class="estimate">
          Estimate — the pool grows every block and other votes are still
          arriving. Payout is settled when the window closes.
        </p>
      {/if}
    </div>

    {#if wallet}
      <p class="estimate">Also casts your Hive vote at {weight}% — one confirm, like the old tribe.</p>
    {/if}
    {#if error}<p class="err">{error}</p>{/if}
    <button class="small" onclick={cast} disabled={!canAfford || chain.busy}>
      {canAfford ? "Cast vote" : "Not enough vote power"}
    </button>
  </div>
{/if}

<style>
  .voter {
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 8px; padding: 0.7rem; min-width: 280px;
  }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
  .head strong { font-size: 1.15rem; color: var(--gold); font-family: var(--mono); }
  .readout { margin: 0.55rem 0; }
  .line { display: flex; align-items: baseline; gap: 0.35rem; flex-wrap: wrap; font-size: 0.85rem; margin-bottom: 0.3rem; }
  .line.small { font-size: 0.75rem; }
  .meter { position: relative; height: 6px; background: #0d1117; border-radius: 3px; overflow: hidden; margin: 0.35rem 0; }
  .meter .fill { position: absolute; inset: 0 auto 0 0; background: var(--blue); }
  .meter .spend { position: absolute; inset: 0 auto 0 0; background: var(--gold); }
  .estimate { margin: 0.4rem 0 0; font-size: 0.73rem; color: var(--dim); line-height: 1.5; }
  .err { color: var(--red); font-size: 0.8rem; margin: 0.3rem 0; }
  .voter > button:last-child { width: 100%; margin-top: 0.4rem; }
</style>

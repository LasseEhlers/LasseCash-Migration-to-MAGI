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

  /**
   * YOUR EXISTING WEIGHT ON *THIS* POST, when you have already voted it.
   *
   * The remembered weight above is your habit, not your vote. Opening a post
   * you voted at 100% showed the slider at 7% because 7% was the last thing
   * you used somewhere else — so it read as "already changed" when the chain
   * still held 100%. 2026-09-02: a re-vote was skipped on that basis, and the
   * post that actually got changed was a different one with a similar name.
   *
   * The chain is the authority, so when it knows your vote, that is what the
   * slider opens on. The habit still applies to posts you have not voted.
   */
  let myWeight = $state<number | null>(null);
  /** Your EXACT rshares on this post, straight off the `pv_` record. Derived
   *  from the rounded weight instead, a same-weight re-vote left a residue of
   *  a few base units and reported "adds 0.0000" rather than "no change". */
  let myRsharesOnPost = $state(0);
  $effect(() => {
    const who = chain.account;
    if (!who || !post.registered) { myWeight = null; return; }
    void client.postVotes(post.author, post.permlink)
      .then((vs) => {
        const mine = vs.find((v) => v.voter === who);
        if (!mine || !me) { myWeight = null; myRsharesOnPost = 0; return; }
        myRsharesOnPost = Number(mine.rshares) || 0;
        // rshares = shares x powerSpent, and a 100% vote spends a tenth of the
        // meter — so weight = rshares / (shares / 10), read back exactly.
        //
        // `mine.rshares` is ALREADY base units (it comes straight off the `pv_`
        // record); `me.shares` is a decimal Amount. Converting both would
        // multiply the first by 1e8 again, which is what made every weight land
        // outside 1..100 and read as "never voted".
        const full = Number(toBaseUnitArg(me.shares)) / 10;
        const w = full > 0 ? Math.round((Number(mine.rshares) / full) * 100) : 0;
        myWeight = w >= 1 && w <= 100 ? w : null;
      })
      .catch(() => { myWeight = null; myRsharesOnPost = 0; });
  });
  // Opening the panel adopts your existing vote, not your habit.
  $effect(() => { if (open && myWeight !== null) weight = myWeight; });

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
   * A VOTE WITH NO L-SHARES IS A REFUSAL, AND THE PAGE HAD NO IDEA.
   *
   * Vote power and vote weight are different things. Someone who has never
   * minted has a FULL power meter — regeneration does not care whether you
   * hold anything — but weight is `shares x power spent`, so their vote is
   * worth exactly nothing and the contract refuses it: "no L-Shares, no vote
   * weight".
   *
   * canAfford only ever checked the meter, so the button was enabled and the
   * call could not succeed. It happened four times on 2026-09-02 alone, to
   * @tonyz, @lazzvi and @condeas — @condeas being the pool's first outside
   * LP, who has real money in the pool and still could not vote. Each attempt
   * cost them RC and told them nothing.
   */
  const hasShares = $derived(!!me && Number(me.shares) > 0);

  /**
   * WHAT SHARE OF THIS POST THIS VOTE WOULD TAKE.
   *
   * Only shown when it is LARGE. For a mid-sized or small holder the figure is
   * a few percent and saying so is discouraging noise — the number only means
   * anything to someone whose vote can drown out everyone else's, which is the
   * situation it exists to warn about.
   *
   * That situation is real here: one account holds 80.6% of live L-Shares, so
   * a full vote takes 93% of a post the largest other holder voted at 100%.
   * The old tribe's answer was a hand-remembered "never above 7%"; this makes
   * the same judgement visible at the moment the slider moves, and it tracks
   * automatically as others mint rather than being a number to remember.
   */
  const WHALE_SHARE = 0.5;
  const myShare = $derived.by(() => {
    if (!me || !chain.ready) return null;
    try {
      const mine = Number(toBaseUnitArg(voteWeight(toBaseUnitArg(me.shares), toBaseUnitArg(cost))));
      if (mine <= 0) return null;
      // Replacing your own vote does not add to the post twice.
      const existing = existingRshares;
      const others = Math.max(0, Number(post.rshares) - existing);
      // NOBODY ELSE HAS VOTED: taking "100%" is arithmetically true and
      // completely uninformative — there is no one to crowd out. Warning here
      // would fire on every fresh post for every account, which is the noise
      // this is meant to avoid.
      if (others <= 0) return null;
      return mine / (mine + others);
    } catch { return null; }
  });
  const dominates = $derived(myShare !== null && myShare >= WHALE_SHARE);

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

      // A VOTE REPLACES YOUR OWN, IT DOES NOT STACK ON IT.
      //
      // post.rshares ALREADY CONTAINS your existing vote, so adding yours on
      // top counted you twice: a post you had voted at 7% offered to "add"
      // another 74.29 LASSECASH for re-voting at the same 7%, when the net
      // change is exactly zero. Found 2026-09-02.
      //
      // What the post actually gains is the DIFFERENCE between the vote you
      // are about to cast and the one you already hold.
      // SAME WEIGHT IS DECIDED ON THE WEIGHT, not on the rshares.
      // Recomputing your existing rshares in floating point leaves a residue
      // of a few base units against the contract's integer math, which read as
      // "you are lowering this vote" when nothing had changed at all.
      const unchanged = myWeight !== null && weight === myWeight;
      const delta = unchanged ? 0 : Number(toBaseUnitArg(myRshares)) - existingRshares;
      const newTotal = postRshares + delta;
      if (newTotal <= 0) return null;
      if (delta <= 0) return { rshares: myRshares, added: "0.00000000", delta };
      const pending = Number(post.pending_payout);
      const added = pending * (delta / newTotal);
      return { rshares: myRshares, added: added.toFixed(8), delta };
    } catch { return null; }
  });

  // Derived from the same lookup that gives myWeight — this used to be a
  // second, identical postVotes call.
  const mine = $derived(myWeight !== null);

  /** Rshares this account already has on this post, 0 if it has not voted. */
  const existingRshares = $derived(myWeight !== null ? myRsharesOnPost : 0);

  async function remove() {
    error = null;
    error = await chain.submit(() => client.unvote(post.author, post.permlink));
    if (!error) { myWeight = null; myRsharesOnPost = 0; open = false; onvoted?.(); }
  }

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
      {:else if estimate && estimate.delta <= 0}
        <!-- Re-voting at the same weight, or lower. The chain REPLACES your
             vote rather than adding to it, so there is nothing to promise. -->
        <div class="line">
          <span class="dim">
            {#if estimate.delta === 0}
              You already hold this post at {weight}% — re-voting changes nothing.
            {:else}
              Lowering your vote: this takes weight back off the post.
            {/if}
          </span>
        </div>
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
      <p class="estimate">Also casts your Hive vote at {weight}% — one confirm.</p>
    {/if}
    {#if mine}
      <button class="ghost small" onclick={remove} disabled={chain.busy}
        title="Takes back exactly what your vote added, on LasseCash and on Hive. Spent vote power is not refunded.">
        Remove my vote
      </button>
    {/if}
    {#if error}<p class="err">{error}</p>{/if}
    <button class="small" onclick={cast} disabled={!hasShares || !canAfford || chain.busy}>
      {#if !hasShares}Mint to get vote weight
      {:else if !canAfford}Not enough vote power
      {:else}Cast vote{/if}
    </button>
    {#if !hasShares}
      <p class="noshares">
        A vote's weight is your L-Shares × the power you spend, so with none it
        would count for nothing and the chain refuses it.
        <a href="/mint">Lock LASSECASH to get L-Shares →</a>
      </p>
    {/if}
    <!-- SAID AS THE GAIN, NOT THE LOSS, and the gain is the true half.
         Every Hive-Engine veteran expects Scotbot behaviour — it read Hive and
         computed rewards off-chain, so voting from PeakD paid you here. That
         is gone, and "your PeakD vote does not count" is both accurate and
         needlessly negative.
         The same fact stated forwards: this vote earns curation on BOTH
         chains for one signature, and curators take 25% of every payout here,
         paid automatically. Nobody gives anything up by voting here, which
         makes it the easiest habit to change. -->
    {#if dominates && myShare !== null}
      <p class="whale">
        At {weight}% this vote takes <b>{(myShare * 100).toFixed(0)}%</b> of this
        post's reward. Everyone else who votes it shares the rest.
      </p>
    {/if}
    <p class="here">
      <b>This vote pays twice.</b> One signature casts your Hive vote and your
      LasseCash vote at the same weight — you earn curation on both. A vote
      from another frontend earns Hive alone.
    </p>
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
  .here { margin: 0.6rem 0 0; font-size: 0.68rem; color: var(--dim); line-height: 1.5;
          border-top: 1px solid var(--line); padding-top: 0.5rem; }
  .here b { color: var(--gold); }
  .noshares { margin: 0.5rem 0 0; font-size: 0.7rem; color: var(--dim); line-height: 1.5; }
  .noshares a { color: var(--gold); }
  /* Gold, never red: nothing is being lost here and red is reserved for value
     actively disappearing. This is a judgement call being surfaced, not an
     error — the vote is entirely legitimate. */
  .whale { margin: 0.5rem 0 0; padding: 0.5rem 0.6rem; font-size: 0.7rem;
           line-height: 1.5; color: var(--dim);
           border-left: 2px solid var(--gold-dim); }
  .whale b { color: var(--gold); }
  .err { color: var(--red); font-size: 0.8rem; margin: 0.3rem 0; }
  .voter > button:last-child { width: 100%; margin-top: 0.4rem; }
</style>

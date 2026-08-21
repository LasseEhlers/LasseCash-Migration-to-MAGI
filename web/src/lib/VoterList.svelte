<script lang="ts">
  /**
   * The vote count, as a button that opens the list of voters.
   *
   * ONE component for the feed card and the post page, so the two can never
   * disagree about who voted or with what weight.
   *
   * FETCHED ON CLICK, never on load. Most readers never open this, and on MAGI
   * the list costs a transaction-history query per post — paying that for
   * fifty feed cards nobody expanded would be pure waste.
   *
   * WHAT THE NUMBERS ARE. `rshares` is raw vote weight, not LASSECASH: an
   * account's L-Shares multiplied by the power it spent. The share shown
   * beside it is that weight over the post's total, which is EXACTLY how the
   * contract splits the curator pot — so it is computed by the engine
   * (`estimateRewardShare`), not by arithmetic here. See CLAUDE.md, golden
   * rule: the formula lives in Go, in one place.
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, pct } from "$lib/format.js";
  import { estimateRewardShare, type PostVote, type PostView } from "$api/index.js";

  let { post }: { post: PostView } = $props();

  let open = $state(false);
  let votes = $state<PostVote[] | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function toggle() {
    open = !open;
    if (!open || votes !== null || loading) return;
    loading = true;
    try {
      votes = await client.postVotes(post.author, post.permlink);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  /**
   * A voter's share of the post's vote weight, as a percentage.
   *
   * The engine divides a 100-unit "pool" in the same proportion it divides a
   * real one. Passing a literal percentage through the money path is the point:
   * it is the same floor-toward-zero division the chain performs, so the
   * figure on screen cannot drift from the one that gets paid.
   */
  const HUNDRED_UNITS = "10000000000";
  function share(v: PostVote): string | null {
    if (!chain.ready || Number(post.rshares) <= 0) return null;
    return estimateRewardShare(HUNDRED_UNITS, v.rshares, post.rshares);
  }

  /**
   * True when the chain has fewer vote records than the post counted votes.
   *
   * The record is deleted the moment its curator is paid, so this is the
   * ordinary state of a settled post — not a loading gap. Say so rather than
   * showing a list that quietly contradicts the count above it.
   */
  const settledAway = $derived(
    votes !== null && votes.length < post.votes ? post.votes - votes.length : 0,
  );

  function profile(account: string) {
    return `/${displayName(account)}`;
  }
</script>

<div class="voters">
  <button
    class="count mono"
    onclick={toggle}
    aria-expanded={open}
    disabled={post.votes === 0}
  >
    <span class="caret" class:open>▸</span>
    {post.votes} vote{post.votes === 1 ? "" : "s"}
  </button>

  {#if open}
    {#if loading}
      <p class="note dim">Loading voters…</p>
    {:else if error}
      <p class="note amber">{error}</p>
    {:else if votes && votes.length > 0}
      <ul class="list">
        {#each votes as v (v.voter)}
          {@const s = share(v)}
          <li>
            <a class="who mono" href={profile(v.voter)}>{displayName(v.voter)}</a>
            <span class="weight mono dim">{v.rshares}</span>
            <span class="share mono gold">{s ? pct(s) : "—"}</span>
          </li>
        {/each}
      </ul>
      <p class="note dim">
        Share of this post's vote weight — the same proportion the curator pot
        is split by. The middle column is raw rshares, not LASSECASH.
      </p>
      {#if settledAway > 0}
        <p class="note dim">
          {settledAway} more {settledAway === 1 ? "vote has" : "votes have"} already
          been paid out; the chain deletes a vote record once its curator is settled.
        </p>
      {/if}
    {:else}
      <p class="note dim">
        {#if post.votes > 0}
          Every vote on this post has been paid out — the chain deletes a vote
          record once its curator is settled.
        {:else}
          No votes yet.
        {/if}
      </p>
    {/if}
  {/if}
</div>

<style>
  .voters { min-width: 0; }

  .count {
    background: none; border: 0; padding: 0; color: var(--dim);
    font-size: var(--t-sm); font-weight: 600; letter-spacing: 0;
    display: inline-flex; align-items: center; gap: 0.3rem;
  }
  .count:hover:not(:disabled) { color: var(--cyan); box-shadow: none; filter: none; }
  .count:disabled { opacity: 1; cursor: default; }

  .caret { display: inline-block; transition: transform 0.12s; font-size: 0.7em; }
  .caret.open { transform: rotate(90deg); }

  .list {
    list-style: none; margin: 0.5rem 0 0; padding: 0;
    border: 1px solid var(--line-soft); border-radius: var(--r-sm);
    background: #05070a;
    max-height: 15rem; overflow-y: auto;
  }
  .list li {
    display: grid; grid-template-columns: 1fr auto auto;
    gap: 0.7rem; align-items: baseline;
    padding: 0.32rem 0.55rem;
    border-bottom: 1px solid var(--line-soft);
    font-size: var(--t-tiny);
  }
  .list li:last-child { border-bottom: 0; }
  .who { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who:hover { color: var(--gold); }
  .weight { font-variant-numeric: tabular-nums; }
  .share { font-variant-numeric: tabular-nums; min-width: 3.6rem; text-align: right; }

  .note { margin: 0.4rem 0 0; font-size: var(--t-micro); line-height: 1.5; }
</style>

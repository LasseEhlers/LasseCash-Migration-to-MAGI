<script lang="ts">
  /**
   * Promote-by-burn.
   *
   * Steem's promoted posts died in a dead tab where 0.00001 bought a position.
   * Here the money is DESTROYED — burned to `hive:null`, provably unspendable,
   * visible forever — and what it buys is one clearly labelled slot every fifth
   * row of the same Trending list, never above the voted posts.
   *
   * TWO THINGS THIS SCREEN OWES THE USER, and both are load-bearing:
   *
   *  1. A LOUD confirmation with the amount IN RED. Red on this site is
   *     reserved for value actively being lost (CLAUDE.md, visual design) and
   *     an irreversible burn is the purest case of it. There is no undo, no
   *     refund and no admin who can help.
   *  2. The truth about the window. The chain refuses a promotion once
   *     `promoteCutoffPct` of the payout window has elapsed — nobody should buy
   *     a slot that ends in ten minutes — so the button disappears rather than
   *     letting someone sign a transaction the chain will reject.
   *
   * The minimum is GOVERNED (`promote.min_burn`), so it is read from the chain
   * through the engine's median, never hardcoded here.
   */
  import { onMount } from "svelte";
  import { chain, client } from "$lib/chain.svelte.js";
  import { durationWords, lc } from "$lib/format.js";
  import { readGovernedValue } from "$lib/governance.js";
  import Hbd from "$lib/Hbd.svelte";
  import { compare, constants, isPositive, type PostView } from "$api/index.js";

  let { post, onpromoted }: { post: PostView; onpromoted?: () => void } = $props();

  let open = $state(false);
  let confirming = $state(false);
  let amount = $state("");
  let minBurn = $state<string | null>(null);
  let error = $state<string | null>(null);

  const height = $derived(chain.info?.height ?? 0);

  /**
   * The height at which promotion closes.
   *
   * The engine owns the CUTOFF FRACTION and the window lengths; this multiplies
   * them out. That is calendar plumbing, not economics — no money is decided
   * here, and the chain refuses the call itself if this is ever wrong. Every
   * input comes from `constants()`, so a governance or protocol change moves
   * this without a code change.
   */
  const cutoffHeight = $derived.by(() => {
    if (!chain.ready) return 0;
    const c = constants();
    const days = post.window === "deep" ? c.deepPayoutDays : c.viralPayoutDays;
    const windowHeights = days * Number(c.heightsPerDay);
    return post.created_height + Math.floor((windowHeights * c.promoteCutoffPct) / 100);
  });

  /** Promotion is a live option only inside the window and before the cutoff. */
  const openForPromotion = $derived(
    chain.ready && !post.paid_out && !post.parent_permlink && height < cutoffHeight,
  );

  const enough = $derived(
    minBurn !== null && isPositive(amount || "0") && compare(amount || "0", minBurn) >= 0,
  );

  onMount(async () => {
    const v = await readGovernedValue(constants().paramPromoteMinBurn);
    if (v) {
      minBurn = v.value;
      amount = v.value;
    }
  });

  function start() {
    open = true;
    confirming = false;
    error = null;
  }

  async function submit() {
    error = null;
    // NEVER on one click. The money is gone the moment this lands.
    if (!confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    error = await chain.submit(() => client.promotePost(post.author, post.permlink, amount));
    if (!error) {
      open = false;
      onpromoted?.();
    }
  }
</script>

{#if openForPromotion}
  {#if !open}
    <button class="ghost small" onclick={start} disabled={!chain.account}>
      {chain.account ? "Promote" : "Sign in to promote"}
    </button>
    <small class="dim note">
      Burn LASSECASH for a labelled slot in Trending. Closes in
      {durationWords(cutoffHeight - height)}.
    </small>
  {:else}
    <div class="promote">
      <div class="head">
        <strong>Promote this post</strong>
        <button class="ghost small" onclick={() => (open = false)} aria-label="Close">✕</button>
      </div>

      <label class="field">
        <span class="k">LASSECASH to burn</span>
        <input inputmode="decimal" bind:value={amount} placeholder="0.00000000" />
      </label>
      <div class="hint">
        {#if minBurn !== null}
          <span class="dim">Minimum {lc(minBurn)} — set by the top 10, inside hardcoded bounds.</span>
        {:else}
          <span class="dim">Reading the governed minimum…</span>
        {/if}
        <Hbd {amount} />
      </div>

      {#if confirming}
        <!-- RED, because the amount is value actively being destroyed. -->
        <div class="confirm">
          <p>
            You are about to burn
            <strong class="red">{lc(amount, 3)} LASSECASH</strong>
            to promote this post.
          </p>
          <p><strong>This cannot be undone.</strong></p>
          <p class="dim">
            It buys a labelled slot in Trending until the post pays out. The
            burn goes to <span class="mono">@null</span> — unspendable, and
            visible on-chain forever.
          </p>
        </div>
      {/if}

      {#if error}<p class="err">{error}</p>{/if}

      <div class="actions">
        {#if confirming}
          <button class="ghost small" onclick={() => (confirming = false)}>Cancel</button>
        {/if}
        <button
          class="small"
          class:danger={confirming}
          onclick={submit}
          disabled={!enough || chain.busy}
        >
          {#if !enough && minBurn !== null}
            Minimum {lc(minBurn, 0)}
          {:else if confirming}
            Burn {lc(amount, 3)} LASSECASH
          {:else}
            Promote…
          {/if}
        </button>
      </div>
    </div>
  {/if}
{:else if chain.ready && !post.paid_out && !post.parent_permlink}
  <small class="dim note">
    Promotion closed — more than {constants().promoteCutoffPct}% of the payout
    window has elapsed.
  </small>
{/if}

<style>
  .note { display: block; margin-top: 0.35rem; line-height: 1.5; font-size: var(--t-micro); }

  .promote {
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: var(--r); padding: 0.7rem; text-align: left;
  }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
  .head strong { font-size: var(--t-sm); color: var(--gold); font-family: var(--mono); }

  .field { display: block; }
  .field .k {
    display: block; color: var(--dim); font-size: var(--t-micro);
    letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700;
    font-family: var(--mono); margin-bottom: 0.25rem;
  }
  .field input { width: 100%; }

  .hint {
    display: flex; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;
    font-size: var(--t-micro); line-height: 1.5; margin: 0.35rem 0 0;
  }

  .confirm {
    background: rgba(255, 77, 77, 0.08); border: 1px solid rgba(255, 77, 77, 0.35);
    border-radius: var(--r-sm); padding: 0.6rem 0.7rem; margin: 0.6rem 0 0;
    font-size: var(--t-sm); line-height: 1.55;
  }
  .confirm p { margin: 0 0 0.35rem; }
  .confirm p:last-child { margin: 0; font-size: var(--t-tiny); }

  .err { color: var(--red); font-size: var(--t-sm); margin: 0.5rem 0 0; }
  .actions { display: flex; gap: 0.4rem; justify-content: flex-end; margin-top: 0.6rem; }
</style>

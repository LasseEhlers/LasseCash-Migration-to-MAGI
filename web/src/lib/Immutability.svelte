<script lang="ts">
  /**
   * The key-burn panel: what the owner key can still do, and for how long.
   *
   * WHY THIS EXISTS. "No admin keys" is the central claim of the migration, and
   * for the first 40 days it is not yet true — the key survives so a defect
   * found on the live chain can be repaired. A promise that the key will be
   * destroyed later is worth exactly as much as the reader's trust in Lasse,
   * which is the thing the whole project is trying to stop depending on.
   *
   * So this panel does not assert anything. It shows the two facts a reader can
   * verify themselves: the block at which the key dies, and whether a code
   * update is queued right now. Both come from the chain. When there is nothing
   * pending it says so; when there is, it shows the proposer, the CID of the
   * new code and the exact block it could activate — which is at least 48 hours
   * away, because the state engine will not run new code before
   * submitHeight + 57,600.
   *
   * After the burn block the panel becomes permanent: not "none pending", but
   * "none possible".
   */
  import { chain } from "$lib/chain.svelte.js";
  import { CONTRACT_ID, WALLET_MODE } from "$lib/chain.svelte.js";
  import { KEY_BURN_HEIGHTS, MAGI_GRAPHQL } from "$lib/site.js";

  type Pending = {
    id: string;
    code: string;
    proposer: string;
    creation_height: number;
    activation_height: number;
  };

  let pending = $state<Pending[] | null>(null);
  let checked = $state<Date | null>(null);
  let failed = $state(false);

  const info = $derived(chain.info);
  /** The announced burn height, derived from genesis so it cannot be typed wrong. */
  const burnHeight = $derived(info ? info.genesis_height + KEY_BURN_HEIGHTS : 0);
  const burned = $derived(!!info && info.height >= burnHeight);
  const daysLeft = $derived(
    info && !burned ? Math.max(0, (burnHeight - info.height) / 28_800) : 0,
  );

  /**
   * Ask the node what is queued for this contract.
   *
   * A null result means "nothing queued" — the same answer as an empty list,
   * and the common case. A network failure is NOT reported as "nothing
   * pending": saying the queue is clean when we could not read it would be the
   * one lie this panel exists to avoid.
   */
  async function poll() {
    if (!WALLET_MODE) return;
    const query = `{ findPendingContractUpdates(filterOptions:{byId:${JSON.stringify(CONTRACT_ID)}}){ id code proposer creation_height activation_height } }`;
    try {
      const res = await fetch(MAGI_GRAPHQL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const json = await res.json();
      if (json.errors) throw new Error(json.errors[0]?.message ?? "query failed");
      pending = json.data?.findPendingContractUpdates ?? [];
      failed = false;
    } catch {
      failed = true;
    }
    checked = new Date();
  }

  $effect(() => {
    if (!WALLET_MODE) return;
    poll();
    const t = setInterval(poll, 60_000);
    return () => clearInterval(t);
  });
</script>

{#if WALLET_MODE && info}
  <section class="panel">
    <h2>Admin keys</h2>

    {#if burned}
      <p class="verdict gone">
        <b>The owner key is destroyed.</b> No code update can be proposed for this
        contract by anyone, including its author. The rules are final.
      </p>
    {:else}
      <p class="verdict live">
        The owner key still exists, and will be destroyed at block
        <b class="mono">{burnHeight.toLocaleString()}</b> —
        <b class="mono">{daysLeft.toFixed(1)}</b> days from now.
      </p>
      <p class="dim small">
        Until then it can do exactly one thing: propose a code update. It cannot
        move anyone's tokens. Every proposal is visible here for 48 hours before
        it can take effect, and can be cancelled inside that window.
      </p>
    {/if}

    <h3>Pending code updates</h3>
    {#if failed}
      <p class="unknown">Could not reach the node — status unknown. This is not
        the same as "none pending".</p>
    {:else if pending === null}
      <p class="dim">checking…</p>
    {:else if pending.length === 0}
      <p class="clean">
        <b>None.</b>{#if burned} And none is now possible.{/if}
      </p>
    {:else}
      {#each pending as p (p.code)}
        <dl class="update">
          <dt>proposed by</dt><dd class="mono">{p.proposer}</dd>
          <dt>new code</dt><dd class="mono break">{p.code}</dd>
          <dt>proposed at block</dt><dd class="mono">{p.creation_height.toLocaleString()}</dd>
          <dt>can activate at</dt><dd class="mono">{p.activation_height.toLocaleString()}</dd>
          <dt>which is in</dt>
          <dd class="mono">
            {Math.max(0, (p.activation_height - info.height) / 1200).toFixed(1)} hours
          </dd>
        </dl>
      {/each}
      <small class="dim">
        The code field is a content hash of the proposed WASM — fetch it and compare
        it against what is running before it activates.
      </small>
    {/if}

    <small class="dim">
      contract <span class="mono break">{CONTRACT_ID}</span>
      {#if checked}· checked {checked.toLocaleTimeString()}{/if}
      · verify with <span class="mono">findPendingContractUpdates</span> against
      <span class="mono break">{MAGI_GRAPHQL}</span>
    </small>
  </section>
{/if}

<style>
  h3 { font-size: 0.9rem; margin: 1.1rem 0 0.4rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .verdict { margin: 0 0 0.5rem; }
  /* Gold, never red: a live owner key is a disclosed, time-limited fact, not
     value being lost. Red here would train people to ignore it where it is real. */
  .verdict.live b { color: var(--gold); }
  .verdict.gone b { color: var(--green); }
  .clean b { color: var(--green); }
  .unknown { color: var(--gold); }
  .small, small { font-size: 0.78rem; }
  small.dim { display: block; margin-top: 0.7rem; }
  .break { word-break: break-all; }
  dl.update { display: grid; grid-template-columns: auto 1fr; gap: 0.3rem 1rem; margin: 0 0 0.8rem; padding: 0.6rem; background: var(--panel-2); border-radius: 6px; border-left: 3px solid var(--gold); }
  dt { color: var(--dim); font-size: 0.82rem; }
  dd { margin: 0; font-size: 0.86rem; }
</style>

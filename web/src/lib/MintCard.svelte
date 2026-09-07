<script lang="ts">
  /**
   * One mint, as a card.
   *
   * A table was the wrong container: eight columns clipped the primary action
   * on a narrow viewport and left the lifecycle timeline no room. The timeline
   * is the point — it is what makes the bleed obvious before it costs anyone
   * money — so the layout is built around it.
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { durationWords, fractionPct, lc, shortDate } from "$lib/format.js";
  import MintTimeline from "$lib/MintTimeline.svelte";
  import Hbd from "$lib/Hbd.svelte";
  import type { MintView } from "$api/index.js";
  import { constants } from "$api/index.js";

  let { mint }: { mint: MintView } = $props();

  let error = $state<string | null>(null);
  let confirming = $state(false);

  const height = $derived(chain.info?.height ?? 0);
  const bleeding = $derived(
    mint.bleed_remaining_pct !== "1.00000000" && mint.bleed_remaining_pct !== "0.00000000",
  );
  const gone = $derived(mint.bleed_remaining_pct === "0.00000000");
  const early = $derived(!mint.mature);
  /**
   * Matured, but the maturity day has not closed, so `claim_mint` is refused.
   * Deliberate on the chain: settling before the day's checkpoint exists would
   * hand one mint the whole day's emission. The button must not offer a call
   * the chain will reject — on day 30 every migration mint is in this state at
   * once. Found on production 2026-09-07.
   */
  const waiting = $derived(mint.mature && !mint.claimable);
  // Read the windows from the engine, never retype them. This tooltip said
  // "from 30 days" and "the 30-day grace" long after GraceDays was widened
  // 30 -> 90 on 2026-08-22, so it told every reader the wrong deadline for
  // the one action that cannot be taken late.
  // constants() throws until the engine WASM has loaded, and this card can
  // render on a cold page, so it is guarded like /chain does it.
  const grace = $derived(chain.ready ? constants().graceDays : 90);
  const bleed = $derived(chain.ready ? constants().bleedDays : 90);

  async function close() {
    error = null;
    // Ending early forfeits yield and slashes principal — never on one click.
    if (early && !confirming) { confirming = true; return; }
    confirming = false;
    error = await chain.submit(() => client.claimMint(mint.id));
  }
  async function arm() {
    error = null;
    error = await chain.submit(() => client.armGoodAccounting(mint.id));
  }
</script>

<article class="mint" class:alarm={bleeding} class:dead={gone}>
  <header>
    <span class="id mono">MINT #{mint.id}</span>
    <span class="term">
      {mint.days >= 365 ? `${(mint.days / 365).toFixed(1)} years` : `${mint.days} days`}
      <span class="dim">· matures {shortDate(mint.maturity_time)}</span>
    </span>
    {#if gone}
      <span class="pill bad">liquidated</span>
    {:else if bleeding}
      <span class="pill bad">bleeding · {fractionPct(mint.bleed_remaining_pct)} left</span>
    {:else if mint.claimable}
      <span class="pill warn">ready to claim</span>
    {:else if mint.mature}
      <!-- Matured, but the chain refuses a claim until the maturity DAY has
           closed. Saying "ready" here sends the user into a refusal, and on
           day 30 it would send the whole community into one at once. -->
      <span class="pill info">matures today · claimable tomorrow</span>
    {:else}
      <span class="pill ok">{durationWords(mint.maturity_height - height)} left</span>
    {/if}
    {#if mint.good_accounting && !gone}
      <!-- A SECOND pill, not a branch. Armed state must stay visible after
           maturity, which is exactly when it is doing something, and it used
           to sit below `mature` in the chain above so it vanished the moment
           it took effect. Putting it in the chain also made the countdown
           show on bleeding and claimable mints. -->
      <span class="pill info">3y grace</span>
    {/if}
  </header>

  <div class="figures">
    <div>
      <span class="k">Principal</span>
      <span class="v mono">{lc(mint.principal)}</span>
    </div>
    <div>
      <span class="k">L-Shares</span>
      <span class="v mono gold">{lc(mint.shares)}</span>
    </div>
    <div>
      <span class="k">Yield earned</span>
      <span class="v mono">{lc(mint.pending_yield)}</span>
      <Hbd amount={mint.pending_yield} block />
    </div>
    <div>
      <span class="k">If claimed now</span>
      <span class="v mono" class:green={mint.mature && !bleeding} class:red={early || bleeding}>
        {lc(mint.if_claimed_now)}
      </span>
      <Hbd amount={mint.if_claimed_now} block />
    </div>
  </div>

  <MintTimeline {mint} {height} />

  {#if error}<p class="err">{error}</p>{/if}

  {#if confirming}
    <div class="confirm">
      <p>
        Ending early forfeits <strong class="red">all {lc(mint.pending_yield)} LASSECASH of yield</strong>
        and slashes principal. You receive <strong>{lc(mint.if_claimed_now)} LASSECASH</strong>
        and give up <strong class="red">{lc(mint.slashed_if_claimed_now)} LASSECASH</strong>
        to the reward pool.
      </p>
      <p class="dim">
        Recovery rises to 100% at maturity — {durationWords(mint.maturity_height - height)} away.
      </p>
    </div>
  {/if}

  <footer>
    {#if mint.can_arm_good_accounting}
      <button
        class="ghost small"
        onclick={arm}
        disabled={chain.busy}
        title={`Good Accounting — tax planning. Extends the grace period after maturity from ${grace} days to 3 years, so you can choose which tax year to realise the payout in. Only you can arm it, and only during the ${grace}-day grace after maturity — once the bleed has started it is too late. The ordinary ${bleed}-day bleed still follows the extended grace.`}
      >Good Accounting</button>
    {/if}
    {#if confirming}
      <button class="ghost small" onclick={() => (confirming = false)}>Cancel</button>
    {/if}
    <button
      class="small"
      class:danger={early}
      class:urgent={bleeding}
      onclick={close}
      disabled={chain.busy || gone || waiting}
      title={waiting
        ? "This mint matured today. The chain will not settle it until the day has closed, so that everyone maturing today is paid from the same checkpoint. Claimable tomorrow — nothing is lost by waiting."
        : undefined}
    >
      {#if gone}Nothing left
      {:else if confirming}Confirm — lose {lc(mint.slashed_if_claimed_now)}
      {:else if early}End early
      {:else if waiting}Claimable tomorrow
      {:else}Claim{/if}
    </button>
  </footer>
</article>

<style>
  .mint {
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line);
    border-radius: var(--r);
    padding: 0.85rem 0.95rem;
  }
  .mint.alarm { border-color: rgba(255, 77, 77, 0.55); box-shadow: 0 0 22px rgba(255, 77, 77, 0.1) inset; }
  .mint.dead { opacity: 0.55; }

  header { display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .id { font-size: var(--t-micro); letter-spacing: 0.14em; color: var(--dim); font-weight: 700; }
  .term { font-size: var(--t-sm); font-family: var(--mono); }
  header .pill { margin-left: auto; }

  .figures {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(122px, 1fr));
    gap: 0.55rem 0.9rem; margin-bottom: 0.9rem;
  }
  .figures .k {
    display: block; color: var(--dim); font-size: var(--t-micro);
    letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700;
    font-family: var(--mono);
  }
  .figures .v { display: block; font-size: var(--t-base); font-variant-numeric: tabular-nums; }

  .confirm {
    background: rgba(255, 77, 77, 0.08); border: 1px solid rgba(255, 77, 77, 0.35);
    border-radius: var(--r-sm); padding: 0.6rem 0.7rem; margin: 0.75rem 0 0;
    font-size: var(--t-sm); line-height: 1.55;
  }
  .confirm p { margin: 0 0 0.3rem; }
  .confirm p:last-child { margin: 0; font-size: var(--t-tiny); }

  .err { color: var(--red); font-size: var(--t-sm); margin: 0.6rem 0 0; }

  footer { display: flex; gap: 0.4rem; justify-content: flex-end; margin-top: 0.85rem; flex-wrap: wrap; }

  /* A bleeding mint is losing money every block: make its exit unmissable. */
  footer :global(button.urgent) {
    animation: pulse 1.8s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 210, 63, 0.55); }
    50% { box-shadow: 0 0 0 6px rgba(255, 210, 63, 0); }
  }
  @media (prefers-reduced-motion: reduce) {
    footer :global(button.urgent) { animation: none; box-shadow: var(--glow-gold); }
  }
</style>

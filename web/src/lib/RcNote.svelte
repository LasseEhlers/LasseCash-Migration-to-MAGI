<script lang="ts">
  /**
   * "You are nearly out of credits, and here is what to do about it."
   *
   * THE WALL THIS EXISTS FOR. On MAGI every action costs resource credits,
   * capacity is the account's HBD balance in milli plus 10,000 free, and
   * spent credits come back over five days. A fresh account therefore gets
   * ONE claim plus a couple of actions — and the claim is the first thing
   * everybody does. @psyopdailydao claimed on 2026-09-15, tried to mint 100
   * LASSECASH twice within eight minutes, watched both transactions fail on
   * chain with no explanation, and has not come back since.
   *
   * On 30 September every migration mint matures at once and thousands of
   * people may do exactly that sequence on the same day. So the warning has
   * to arrive BEFORE the attempt, not as an error afterwards.
   *
   * IT IS GOLD, NOT RED. Nothing is being lost and nothing is broken — the
   * account simply has to wait or deposit. CLAUDE.md reserves red for value
   * actively disappearing; using it here would train people to ignore it
   * where it is real.
   *
   * It shows itself only when it applies: signed in, meter read, and fewer
   * credits left than an ordinary action costs.
   */
  import { chain } from "$lib/chain.svelte.js";

  /** A mint is ~5,850 credits since the token ledger (5,475 mint + 369
   *  allowance, measured 2026-10-04) and the site keeps a 30% margin, so it
   *  needs ~7,600 free; a claim ~9,500; a vote ~1,000. Below this the most
   *  common action is refused, which is the moment to say something. */
  const LOW = 8_000;
  /** Capacity with no HBD deposited: the free allowance and nothing else. */
  const FREE_ONLY = 10_000;

  const rc = $derived(chain.rc);
  const show = $derived(!!chain.account && !!rc && rc.max > 0 && rc.amount < LOW);
  const freeOnly = $derived(!!rc && rc.max <= FREE_ONLY);
  const n = (x: number) => Math.trunc(x).toLocaleString();
</script>

{#if chain.account && chain.rcUnknown && !rc}
  <!-- MAGI cannot show this account's meter (no HBD record yet, 2026-10-08:
       @cinqowy failed four mints without ever seeing a warning). -->
  <div class="rcnote">
    <strong>MAGI can't show your action credits yet.</strong>
    Accounts that have never held HBD on MAGI only have the free credits, which are
    not enough for a mint.
    <span class="fix">
      Deposit a few <strong>HBD on MAGI</strong> — about 5 is plenty: each 1 HBD adds 1,000
      credits, it is <strong>collateral, not a fee</strong>, and it makes your credits visible.
      <a href="/wallet">Deposit HBD →</a>
    </span>
  </div>
{:else if show && rc}
  <div class="rcnote">
    <strong>You are low on action credits.</strong>
    <span class="mono">{n(rc.amount)}</span> of <span class="mono">{n(rc.max)}</span> left.
    {#if freeOnly}
      Every account gets 10,000 free credits, and claiming uses most of them —
      enough for the claim and little else.
    {:else}
      Credits are spent by every action and come back over five days.
    {/if}
    <span class="fix">
      To act now, deposit <strong>HBD on MAGI</strong>: each 1 HBD adds 1,000
      credits, and it is <strong>collateral, not a fee</strong> — you can withdraw
      it whenever you like. As a guide, about 10 HBD covers occasional use, 25 HBD
      voting and posting most days, and 100 HBD active trading or curating with
      almost no waiting.
      <a href="/wallet">Deposit HBD →</a>
    </span>
  </div>
{/if}

<style>
  .rcnote {
    margin: 0 0 0.75rem;
    padding: 0.6rem 0.9rem;
    border: 1px solid rgba(255, 210, 63, 0.45);
    border-left-width: 3px;
    background: rgba(255, 210, 63, 0.07);
    color: var(--fg, #e8e6e1);
    font-size: 0.92rem;
    line-height: 1.5;
  }
  .rcnote strong { color: var(--gold, #ffd23f); }
  .mono { font-family: var(--mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
  .fix { display: block; margin-top: 0.3rem; }
  .rcnote a { color: var(--cyan, #6ee7f0); white-space: nowrap; }
</style>

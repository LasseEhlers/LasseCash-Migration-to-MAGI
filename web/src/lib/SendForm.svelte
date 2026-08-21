<script lang="ts">
  /**
   * Send LASSECASH to another account.
   *
   * There is NO MEMO FIELD, and that is not an oversight: the `transfer`
   * entrypoint takes `<to>|<amount>` and nothing else, so a memo box would
   * collect text the chain then silently discards.
   *
   * Two guards stand between a typo and a signature:
   *
   *  1. The amount is parsed by `toBaseUnitArg` — the same conversion the
   *     client uses on submit — so anything malformed is refused HERE rather
   *     than becoming a wrong transaction.
   *  2. A one-line confirmation restates the amount and the recipient in the
   *     form a human reads. A transfer is irreversible and there is no
   *     recall; the extra click is cheap next to that.
   */
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, lc } from "$lib/format.js";
  import { compare, toBaseUnitArg } from "$api/index.js";

  let to = $state("");
  let amount = $state("");
  let confirming = $state(false);
  let error = $state<string | null>(null);
  let sent = $state<string | null>(null);

  const balance = $derived(chain.me?.balance ?? "0.00000000");

  /**
   * Fully qualify the recipient exactly as the chain addresses accounts:
   * `hive:alice`, never bare `alice` — see CLAUDE.md, public state ABI. An
   * address that already names its namespace (`hive:`, `did:pkh:…`) is left
   * alone, so this can never mangle a non-Hive account into a Hive one.
   */
  const recipient = $derived.by(() => {
    const raw = to.trim().replace(/^@/, "").toLowerCase();
    if (raw === "") return "";
    return raw.includes(":") ? raw : `hive:${raw}`;
  });

  /**
   * Why the form cannot be submitted yet, or null when it can.
   *
   * A single derived reason keeps the button state and the message from ever
   * disagreeing about whether the input is usable.
   */
  const blocked = $derived.by(() => {
    // Not signed in is not a validation failure — the button already says so.
    if (!chain.account) return null;
    if (recipient === "") return null; // nothing typed yet; not an error
    if (recipient === chain.account) return "That is your own account.";
    if (amount.trim() === "") return null;
    let units: string;
    try {
      units = toBaseUnitArg(amount);
    } catch (e) {
      return e instanceof Error ? e.message : "Not a valid amount.";
    }
    if (units === "0") return "Enter an amount above zero.";
    if (compare(amount, balance) > 0) return `You hold ${lc(balance)} LC.`;
    return null;
  });

  const ready = $derived(
    !!chain.account && recipient !== "" && amount.trim() !== "" &&
    blocked === null && !chain.busy,
  );

  function max() {
    // The whole balance, at full precision — `lc()` trims for display and
    // would leave dust behind if it were fed back into a transaction.
    amount = balance;
  }

  function review() {
    error = null;
    sent = null;
    confirming = true;
  }

  async function send() {
    const shown = `${lc(amount)} LC to ${displayName(recipient)}`;
    // `chain.submit` refreshes the account view either way, so the balance
    // and the mint list are current the moment this returns.
    const failure = await chain.submit(() => client.transfer(recipient, amount));
    confirming = false;
    if (failure) {
      // The contract's own words. They carry RAW BASE UNITS, which is why the
      // amount above is formatted separately rather than read out of here.
      error = failure;
      return;
    }
    error = null;
    sent = `Sent ${shown}.`;
    to = "";
    amount = "";
  }
</script>

<div class="panel">
  <h2>Send LASSECASH</h2>

  <label class="field">
    <span>To</span>
    <input
      bind:value={to}
      placeholder="zaxan"
      autocomplete="off"
      spellcheck="false"
      disabled={confirming}
    />
    {#if recipient && !confirming}
      <small class="dim">Goes to <span class="mono">{recipient}</span></small>
    {/if}
  </label>

  <!-- The Max button sits OUTSIDE the label: a button inside one also
       activates the label's control, so clicking it would yank focus into the
       field it just filled. -->
  <div class="field">
    <span class="cap">Amount</span>
    <div class="withmax">
      <input inputmode="decimal" bind:value={amount} placeholder="0.00000000" disabled={confirming} />
      <button class="ghost small" onclick={max} disabled={confirming || !chain.account}>Max</button>
    </div>
    <small class="dim">Balance <span class="mono">{lc(balance, 8)}</span> LC</small>
  </div>

  {#if confirming}
    <!-- One line, stating exactly what is about to happen. A transfer cannot
         be undone, so the last thing on screen before signing is the plain
         reading of it. -->
    <p class="confirm">
      Send <strong class="gold mono">{lc(amount)}</strong> LC to
      <strong class="gold mono">{displayName(recipient)}</strong>?
    </p>
    <div class="pair">
      <button onclick={send} disabled={chain.busy}>
        {chain.busy ? "Sending…" : "Confirm"}
      </button>
      <button class="ghost" onclick={() => (confirming = false)} disabled={chain.busy}>
        Cancel
      </button>
    </div>
  {:else}
    <button onclick={review} disabled={!ready}>
      {chain.account ? "Send" : "Sign in to send"}
    </button>
  {/if}

  <!-- AMBER, not red. Red means value is actively draining — the bleed, the
       early-end slash — and a mistyped amount is not that. -->
  {#if blocked && !confirming}<p class="note amber">{blocked}</p>{/if}
  {#if error}<p class="note amber">{error}</p>{/if}
  {#if sent}<p class="note green">{sent}</p>{/if}
</div>

<style>
  /* Mirrors the global `label.field > span` caption, which only targets a
     real <label> — this field is a <div> for the reason noted in the markup. */
  .cap {
    display: block; color: var(--dim); font-size: var(--t-micro);
    letter-spacing: 0.13em; text-transform: uppercase;
    font-weight: 700; margin-bottom: 0.3rem; font-family: var(--mono);
  }
  .field { display: block; margin-bottom: 0.85rem; }
  .field small { display: block; margin-top: 0.28rem; font-size: var(--t-tiny); }

  .withmax { display: flex; gap: 0.4rem; }
  .withmax input { flex: 1 1 auto; }
  .withmax button { flex: 0 0 auto; }

  .confirm {
    background: var(--panel-2); border: 1px solid var(--gold-dim);
    border-radius: var(--r-sm); padding: 0.7rem 0.8rem;
    margin: 0 0 0.7rem; font-size: var(--t-sm); line-height: 1.6;
  }
  .pair { display: flex; gap: 0.5rem; }
  .pair button { flex: 1 1 0; }

  /* Only the panel's own actions stretch — not the Max button nested in a row. */
  .panel > button { width: 100%; }
  .note { margin: 0.6rem 0 0; font-size: var(--t-sm); line-height: 1.5; }
</style>

<script lang="ts">
  /**
   * The migration claim panel.
   *
   * THE MIGRATION IS CLAIM-BASED. The owner commits one Merkle root; every
   * holder claims their own leaf with a proof and pays their own free RC.
   * Pushing 9,921 accounts would have cost thousands of HBD of parked RC.
   *
   * So this panel is the only place most holders ever meet LasseCash on MAGI,
   * and it has to be honest about a clock that started WITHOUT them: the
   * 30-day migration mint has been running since genesis whether or not
   * anyone claimed it. Day 30 it matures, day 60 it starts bleeding, day 150
   * it is gone. Every figure shown here comes from the engine's own
   * `previewMintClose` on a synthetic mint describing exactly that position —
   * nothing on this page works out what a claim is worth.
   *
   * The panel hides itself unless there is something to do: a committed root,
   * a leaf for this account in the published shard, and no receipt on-chain.
   */
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { chain, client } from "$lib/chain.svelte.js";
  import { durationWords, lc, shortDate } from "$lib/format.js";
  import { constants, fromUnits, previewMintClose, type MintPreview } from "$api/index.js";

  /** One account's row in a published proof shard. */
  interface Leaf {
    liquid: string;
    staked: string;
    burned: boolean;
    proof: string[];
  }

  let leaf = $state<Leaf | null>(null);
  let error = $state<string | null>(null);
  /** Set when the served proofs were built from a different snapshot. */
  let rootMismatch = $state(false);

  /**
   * Shard files, cached per session.
   *
   * Sharded by the first two characters of the account name so a claim costs
   * one ~60 KB fetch rather than the 12 MB full proof set.
   */
  const shards = new Map<string, Promise<Record<string, Leaf>>>();

  /** Mirrors migtree.Shard in Go — the same two characters name the same file. */
  function shardOf(name: string): string {
    const alnum = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 2; i++) {
      const c = name[i] ?? "";
      out += (i === 0 ? alnum : alnum + ".-").includes(c) ? c : "_";
    }
    return out;
  }

  function shard(name: string): Promise<Record<string, Leaf>> {
    const key = shardOf(name);
    let p = shards.get(key);
    if (!p) {
      p = fetch(`${base}/migration/proofs/${key}.json`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
      shards.set(key, p);
    }
    return p;
  }

  /**
   * Load this account's position.
   *
   * Order matters: the on-chain receipt is checked before the proof is
   * fetched, so an account that has already claimed never downloads a shard
   * it cannot use.
   */
  async function load(account: string | null) {
    leaf = null;
    error = null;
    rootMismatch = false;
    if (!account) return;

    try {
      const root = await client.migrationRoot();
      if (!root) return; // no snapshot committed — nothing to claim yet
      if (await client.migrationRecord(account)) return; // already settled

      // The proofs shipped with the site must belong to the root the CHAIN
      // committed. If they do not, every claim would be rejected with nothing
      // on the page to explain it, so say so instead of offering a button.
      const published = await fetch(`${base}/migration/root.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!published || published.root !== root) {
        rootMismatch = !!published;
        return;
      }

      const rows = await shard(account.replace(/^hive:/, ""));
      leaf = rows[account] ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void load(chain.account);
  });

  const height = $derived(chain.info?.height ?? 0);
  const genesis = $derived(chain.info?.genesis_height ?? 0);

  /**
   * The migration mint this leaf's LASSECASH POWER already is, described the
   * way the contract describes it: L-Shares 1:1 with the stake (legacy stake
   * keeps the weight it had, no multipliers), locked for
   * `MigrationMintDays` from GENESIS — not from the claim.
   */
  const preview = $derived.by<MintPreview | null>(() => {
    if (!chain.ready || !chain.info || !leaf || leaf.burned) return null;
    const principal = fromUnits(BigInt(leaf.staked));
    return previewMintClose(
      {
        principal,
        shares: principal,
        start_height: genesis,
        days: constants().migrationMintDays,
        good_accounting: false,
      },
      height,
      "0", // a migration mint earns no yield before it is claimed
    );
  });

  const matured = $derived(preview !== null && height >= preview.maturityHeight);
  /** Claiming closes when the mint finishes bleeding — one timeline, not two. */
  const closed = $derived(preview !== null && height >= preview.liquidationHeight);
  const hasStake = $derived(!!leaf && leaf.staked !== "0");

  /**
   * When the migration mint matures, in wall-clock terms.
   *
   * Heights to a date is clock arithmetic, not economics: the height itself
   * came from the engine's preview, and `secondsPerHeight` is read from the
   * engine rather than assumed.
   */
  const maturityDate = $derived.by(() => {
    if (!preview || !chain.info) return null;
    const ms = (preview.maturityHeight - height) * constants().secondsPerHeight * 1000;
    return new Date(Date.parse(chain.info.timestamp) + ms).toISOString();
  });

  async function claim() {
    if (!leaf) return;
    error = null;
    // Base units straight from the leaf: they are inside the Merkle hash, so
    // anything that reformats them breaks the proof.
    // Liquid-only or already-matured claims take the cheap path (no mint is
    // created), so the wallet asks for a small rc_limit instead of the
    // staked-claim worst case. Measured on the devnet, 2026-08-21.
    const cheap = leaf!.staked === "0" || matured;
    error = await chain.submit(() =>
      client.claimMigration(leaf!.liquid, leaf!.staked, leaf!.proof, { cheap }));
    // The receipt now exists on-chain, so the panel is done: the position is
    // in the mint list below, where every other mint lives.
    if (!error) {
      leaf = null;
      // Claiming was the errand. What comes next is the site itself, so a
      // successful claim lands on the feed rather than leaving the claimant
      // staring at the page whose one job they just finished. The mint is on
      // Mint whenever they want it; nothing here is hidden by moving on.
      await goto("/feed");
    }
  }
</script>

{#if rootMismatch}
  <section class="panel claim">
    <h2>Migration</h2>
    <p class="dim">
      The migration proofs served with this site were built from a different
      snapshot than the one this chain committed. Claiming is disabled until
      they match — nothing is lost, and no claim would have been accepted.
    </p>
  </section>
{:else if leaf && leaf.burned}
  <!-- Quiet, deliberately. A burned account has no decision to make and no
       button to press; what it needs is a straight answer. -->
  <section class="panel claim burned">
    <h2>Migration</h2>
    <p class="dim">
      This account did not qualify for the migration — its
      <span class="mono">{lc(fromUnits(BigInt(leaf.liquid)))}</span> LASSECASH and
      <span class="mono">{lc(fromUnits(BigInt(leaf.staked)))}</span> LASSECASH POWER
      went to <span class="mono">@null</span>, where they stay visible forever.
      The snapshot is published in full, and this account is in it.
    </p>
  </section>
{:else if leaf && chain.ready}
  <!-- chain.ready gates this branch because every figure below is an engine
       call: rendering before the WASM is up would throw, not degrade. -->
  <section class="panel claim">
    <h2>Your migration</h2>

    <div class="snapshot">
      <div>
        <span class="k">Liquid LASSECASH</span>
        <span class="v mono">{lc(fromUnits(BigInt(leaf.liquid)))}</span>
      </div>
      <div>
        <span class="k">LASSECASH POWER</span>
        <span class="v mono">{lc(fromUnits(BigInt(leaf.staked)))}</span>
        <span class="note dim">becomes a {constants().migrationMintDays}-day mint, L-Shares 1:1</span>
      </div>
    </div>

    {#if closed}
      <p class="shut">
        <strong>The claim window has closed.</strong>
        The migration mint finished bleeding at day
        {constants().migrationMintDays + constants().graceDays + constants().bleedDays};
        what was never claimed has recycled into the L-Share reward pool.
      </p>
    {:else if preview}
      <div class="yield">
        <div class="lead">What claiming now yields</div>

        {#if !matured || !hasStake}
          <div class="hero mono gold">{lc(fromUnits(BigInt(leaf.liquid)))}</div>
          <div class="hero-sub">LASSECASH, liquid immediately</div>
          {#if hasStake}
            <p class="line">
              plus a {constants().migrationMintDays}-day migration mint of
              <span class="mono">{lc(fromUnits(BigInt(leaf.staked)))}</span> LC,
              maturing {maturityDate ? shortDate(maturityDate) : "—"} — in
              <strong>{durationWords(preview.maturityHeight - height)}</strong>.
              It has been running on the shared clock since genesis, so claiming
              does not restart it; it starts earning and voting for you from now.
            </p>
          {/if}
        {:else}
          <div class="hero mono gold">{lc(preview.toOwner)}</div>
          <div class="hero-sub">from your LASSECASH POWER, paid straight to liquid</div>
          <p class="line">
            plus <span class="mono">{lc(fromUnits(BigInt(leaf.liquid)))}</span>
            liquid LASSECASH from the snapshot.
          </p>
          {#if preview.toRewardPool !== "0.00000000"}
            <p class="line bled">
              <span class="mono">{lc(preview.toRewardPool)}</span> has already bled
              away to the L-Share reward pool. The mint matured on day
              {constants().migrationMintDays} and the bleed does not pause for
              anyone.
            </p>
          {/if}
        {/if}

        <p class="deadline dim">
          Claim window closes in
          <strong>{durationWords(preview.liquidationHeight - height)}</strong>.
          After that the position recycles into the reward pool and cannot be
          recovered.
        </p>
      </div>

      <button onclick={claim} disabled={chain.busy}>
        {chain.busy ? "Claiming…" : "Claim"}
      </button>
      <!-- Mobile wallet paths are untested at launch (deferred 2026-08-27,
           LAUNCH-RUNBOOK §8). Remove this line once they are. -->
      <p class="deadline dim">
        Claim from a <strong>desktop browser with Hive Keychain</strong> —
        phone support follows in the first week.
      </p>
    {:else}
      <p class="dim">Loading the engine…</p>
    {/if}

    {#if error}<p class="err">{error}</p>{/if}
  </section>
{/if}

<style>
  .claim { border-color: var(--gold-dim); }
  .burned { border-color: var(--line); }

  .snapshot {
    display: flex; gap: 2rem; flex-wrap: wrap;
    padding-bottom: 0.9rem; margin-bottom: 0.9rem;
    border-bottom: 1px solid var(--line-soft);
  }
  .snapshot .k {
    display: block; color: var(--dim); font-size: var(--t-micro);
    letter-spacing: 0.13em; text-transform: uppercase; font-weight: 700;
    font-family: var(--mono);
  }
  .snapshot .v { display: block; font-size: var(--t-lg); font-weight: 700; }
  .snapshot .note { display: block; font-size: var(--t-tiny); }

  .lead {
    color: var(--dim); font-size: var(--t-micro); letter-spacing: 0.13em;
    text-transform: uppercase; font-weight: 700; font-family: var(--mono);
  }
  /* HERO NUMBER — the only thing on this panel that glows. */
  .hero {
    font-size: var(--t-hero); font-weight: 800; line-height: 1.15;
    margin-top: 0.15rem; text-shadow: var(--glow-gold);
  }
  .hero-sub { color: var(--dim); font-size: var(--t-sm); margin-bottom: 0.55rem; }
  .line { margin: 0.35rem 0; font-size: var(--t-sm); }
  /* RED IS RESERVED for value actively being lost. A bleed qualifies. */
  .line.bled { color: #ffc9c9; }
  .line.bled .mono { color: var(--red); font-weight: 700; }
  .deadline { margin: 0.7rem 0 0.9rem; font-size: var(--t-tiny); }
  .shut { color: var(--dim); font-size: var(--t-sm); }
  .shut strong { color: var(--ink); display: block; font-family: var(--mono); }
  .err { color: var(--red); font-size: var(--t-sm); margin: 0.6rem 0 0; }
</style>

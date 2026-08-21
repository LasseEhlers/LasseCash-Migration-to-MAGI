<script lang="ts">
  /**
   * An account's public profile — `/@lasseehlers`.
   *
   * Everything here is READ FROM THE CHAIN and already computed there: the
   * balance, the L-Shares, and the consensus group itself. Nothing on this page
   * is derived in TypeScript.
   *
   * L-Shares are the hero figure because they are the thing that matters about
   * an account: they are its voting weight, its claim on the yield pool, and
   * what puts it in the governing top 10. The balance is just cash.
   */
  import { page } from "$app/state";
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, lc, lcShort, shortDate, durationWords } from "$lib/format.js";
  import { excerpt } from "$lib/markdown.js";
  import type { AccountView, PostView } from "$api/index.js";

  /**
   * The URL carries the DISPLAY name; the chain uses the qualified address.
   *
   * Same rule as everywhere else: `hive:alice`, never bare `alice`, and an
   * address that already names its namespace is left alone so a `did:pkh:…`
   * account is never mangled into a Hive one.
   */
  const account = $derived.by(() => {
    const raw = decodeURIComponent(page.params.account ?? "").replace(/^@/, "");
    return raw.includes(":") ? raw : `hive:${raw}`;
  });

  let view = $state<AccountView | null>(null);
  let posts = $state<PostView[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(name: string) {
    loading = true;
    try {
      // TODO: there is no author index. The contract cannot enumerate posts
      // (unbounded iteration does not fit in the gas budget), so the feed's own
      // discovery list is filtered client-side — which means a prolific author
      // whose posts fall outside the newest 200 will look quieter than they
      // are. A real indexer-side author index is the fix, not a bigger limit.
      const [a, all] = await Promise.all([client.accountOf(name), client.posts(200)]);
      view = a;
      posts = all.filter((p) => p.author === name);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Covers the first load AND every later one: clicking a voter's name from
  // another profile changes only the parameter, so a mount-only fetch would
  // leave the previous account's figures on screen.
  $effect(() => { void load(account); });

  const height = $derived(chain.info?.height ?? 0);

  /**
   * Whether this account currently holds one of the ten governing seats.
   *
   * Read from the chain's own `consensus_group`, which the engine derives — the
   * page does no ranking of its own. Seats move as shares move, so this is a
   * statement about right now and nothing more.
   */
  const onCouncil = $derived(chain.info?.consensus_group.includes(account) ?? false);
  const isMe = $derived(chain.account === account);
  const openMints = $derived((view?.mints ?? []).filter((m) => !m.ended).length);

  function href(p: PostView) {
    return `/post/${encodeURIComponent(p.author)}/${encodeURIComponent(p.permlink)}`;
  }
</script>

<svelte:head>
  <title>{displayName(account)} · LasseCash</title>
</svelte:head>

<div class="grid">
  <section class="panel head">
    <div class="who">
      <h1 class="mono">{displayName(account)}</h1>
      <div class="badges">
        {#if onCouncil}
          <span class="pill warn">consensus seat</span>
        {/if}
        {#if isMe}<span class="pill info">you</span>{/if}
      </div>
    </div>

    <div class="hero">
      <div class="value gold">{view ? lcShort(view.shares) : "—"}</div>
      <div class="cap">L-Shares</div>
      <div class="exact mono dim">{view ? lc(view.shares) : ""}</div>
    </div>
  </section>

  {#if error}
    <p class="empty"><strong>Could not read this account.</strong>{error}</p>
  {:else if loading && !view}
    <p class="empty">Loading…</p>
  {:else if view}
    <section class="stats">
      <div class="panel stat">
        <div class="label">Liquid</div>
        <div class="value">{lcShort(view.balance)}</div>
        <div class="sub mono">{lc(view.balance)} LASSECASH</div>
      </div>
      <div class="panel stat">
        <div class="label">Open mints</div>
        <div class="value">{openMints}</div>
        <div class="sub">time-locked position{openMints === 1 ? "" : "s"}</div>
      </div>
      <div class="panel stat">
        <div class="label">Governance</div>
        <div class="value {onCouncil ? 'green' : 'dim'}">{onCouncil ? "Seated" : "—"}</div>
        <div class="sub">
          {onCouncil
            ? "one of the ten standing preferences"
            : "L-Shares buy a seat, not extra weight in one"}
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Posts</h2>
      {#if posts.length === 0}
        <p class="empty"><strong>Nothing published.</strong>Or nothing in the most recent 200 posts.</p>
      {:else}
        <ul class="posts">
          {#each posts as p (p.permlink)}
            <li>
              <a href={href(p)}>
                <span class="pill {p.window === 'deep' ? 'info' : 'warn'}">{p.window}</span>
                <span class="title">{p.title}</span>
              </a>
              <div class="line dim">
                <span>{shortDate(p.created_time)}</span>
                <span class="mono">{p.votes} vote{p.votes === 1 ? "" : "s"}</span>
                {#if p.paid_out}
                  <span class="pill ok">paid out</span>
                {:else}
                  <span class="mono gold">{lc(p.pending_payout)} LC</span>
                  <span>
                    {p.payable ? "window closed" : `pays in ${durationWords(p.payout_height - height)}`}
                  </span>
                {/if}
              </div>
              {#if p.summary || p.body_excerpt}
                <p class="blurb">{p.summary || excerpt(p.body_excerpt ?? "", 160)}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .head { display: flex; align-items: center; gap: 1.4rem; flex-wrap: wrap; }
  .who { flex: 1 1 auto; min-width: 0; }
  h1 { margin: 0; font-size: var(--t-xl); letter-spacing: 0.02em; word-break: break-all; }
  .badges { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.45rem; }

  .hero { text-align: right; flex: 0 0 auto; }
  /* HERO NUMBER — the only glow on this page. */
  .hero .value {
    font-family: var(--mono); font-size: var(--t-hero); font-weight: 800;
    font-variant-numeric: tabular-nums; line-height: 1.15;
    text-shadow: var(--glow-gold);
  }
  .hero .cap {
    color: var(--dim); font-size: var(--t-micro); letter-spacing: 0.13em;
    text-transform: uppercase; font-weight: 700; font-family: var(--mono);
  }
  .hero .exact { font-size: var(--t-tiny); margin-top: 0.15rem; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
  @media (max-width: 720px) {
    .stats { grid-template-columns: 1fr 1fr; gap: 0.6rem; }
    .hero { text-align: left; }
  }
  .stat .value.dim { text-shadow: none; }

  .posts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.9rem; }
  .posts li { border-bottom: 1px solid var(--line-soft); padding-bottom: 0.8rem; }
  .posts li:last-child { border-bottom: 0; padding-bottom: 0; }
  .posts a { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .posts a:hover .title { color: var(--gold); }
  .title { font-weight: 700; font-size: var(--t-lg); line-height: 1.35; }
  .line {
    display: flex; gap: 0.7rem; flex-wrap: wrap; align-items: center;
    font-size: var(--t-tiny); margin-top: 0.3rem;
  }
  .blurb { margin: 0.35rem 0 0; color: var(--dim); font-size: var(--t-sm); line-height: 1.55; }
  .empty { padding: 1.2rem 1rem; }
</style>

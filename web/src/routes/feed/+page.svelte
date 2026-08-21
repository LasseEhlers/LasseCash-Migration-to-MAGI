<script lang="ts">
  /**
   * LasseMedia feed.
   *
   * The card is a LINK — the whole thing, not a hidden "read more". Hive posts
   * are image-heavy, so a cover image is pulled from the body when the author
   * did not think to add one, and a video post falls back to its YouTube
   * thumbnail rather than appearing as a wall of text.
   *
   * That link is an OVERLAY, not a wrapping anchor: the author's name is its
   * own link to their profile, and nesting anchors is invalid HTML. The vote
   * control and the voter list sit above the overlay for the same reason they
   * used to sit outside the anchor — dragging the slider must not navigate.
   */
  import { onMount } from "svelte";
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, lc, shortDate, durationWords } from "$lib/format.js";
  import { coverImage, excerpt } from "$lib/markdown.js";
  import VoteSlider from "$lib/VoteSlider.svelte";
  import VoterList from "$lib/VoterList.svelte";
  import { compare, PayoutMode, type PostView } from "$api/index.js";

  let posts = $state<PostView[]>([]);
  let filter = $state<"all" | "viral" | "deep">("all");
  let error = $state<string | null>(null);
  let loading = $state(true);

  /**
   * Trending or newest.
   *
   * SORT AND FILTER ARE SEPARATE CONTROLS on purpose: "the newest viral posts"
   * is a reasonable thing to want, and folding the two into one row of buttons
   * would make it unaskable.
   */
  type Sort = "trending" | "new";
  const SORT_KEY = "lassecash:feedSort";
  let sort = $state<Sort>("trending");

  // Restored in onMount rather than at module scope: this is a static build and
  // the same module is evaluated during SSR, where localStorage does not exist.
  // Every access is guarded anyway — a private window can throw on read.
  function restoreSort() {
    try {
      const saved = localStorage.getItem(SORT_KEY);
      if (saved === "trending" || saved === "new") sort = saved;
    } catch { /* no stored preference is a fine state to be in */ }
  }
  function setSort(next: Sort) {
    sort = next;
    try { localStorage.setItem(SORT_KEY, next); } catch { /* not worth an error */ }
  }

  async function load() {
    try {
      posts = await client.posts(50);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
  onMount(() => { restoreSort(); void load(); });

  /**
   * The rendered list: filtered, then ordered.
   *
   * NOTHING IS COMPUTED HERE. Trending orders by `pending_payout`, which the
   * chain worked out against the live window pool, and New orders by the height
   * the post was registered at. Both are chain facts; this only arranges them.
   *
   * `compare` does the ordering because a payout is a decimal STRING — sorting
   * these as JavaScript numbers would start misplacing posts as soon as a
   * payout passed the safe integer range.
   */
  const shown = $derived.by(() => {
    const base = filter === "all" ? posts : posts.filter((p) => p.window === filter);
    const out = [...base];
    if (sort === "trending") {
      out.sort((a, b) => compare(b.pending_payout, a.pending_payout));
    } else {
      out.sort((a, b) => b.created_height - a.created_height);
    }
    return out;
  });
  const height = $derived(chain.info?.height ?? 0);
  const awaitingPayout = $derived(posts.filter((p) => p.payable));

  function href(p: PostView) {
    return `/post/${encodeURIComponent(p.author)}/${encodeURIComponent(p.permlink)}`;
  }
  function cover(p: PostView) {
    return coverImage(p.body_excerpt ?? "");
  }
  function blurb(p: PostView) {
    return p.summary || excerpt(p.body_excerpt ?? "", 160);
  }

  async function payout(p: PostView) {
    error = await chain.submit(() => client.payout(p.author, p.permlink));
    await load();
  }
</script>

<div class="grid">
  <div class="bar">
    <div class="filters">
      <button class="ghost" class:active={filter === "all"} onclick={() => (filter = "all")}>All</button>
      <button class="ghost" class:active={filter === "viral"} onclick={() => (filter = "viral")}>
        Viral <small>7d · 25%</small>
      </button>
      <button class="ghost" class:active={filter === "deep"} onclick={() => (filter = "deep")}>
        Deep <small>30d · 75%</small>
      </button>
    </div>
    <div class="sorts">
      <button class="ghost" class:active={sort === "trending"} onclick={() => setSort("trending")}>
        Trending
      </button>
      <button class="ghost" class:active={sort === "new"} onclick={() => setSort("new")}>
        New
      </button>
    </div>
    <a class="write" href="/compose">Write →</a>
  </div>

  {#if awaitingPayout.length > 0}
    <div class="panel settle">
      <strong class="gold">
        {awaitingPayout.length} post{awaitingPayout.length > 1 ? "s have" : " has"} closed and not been settled.
      </strong>
      Anyone can trigger a payout — an absent author must never strand their curators.
    </div>
  {/if}

  {#if error}<div class="panel err">{error}</div>{/if}

  {#if loading}
    <p class="empty">Loading content…</p>
  {:else if shown.length === 0}
    <p class="empty">
      <strong>Nothing here yet.</strong>
      {filter === "all" ? "Be the first to publish." : `No ${filter} posts.`}
    </p>
  {:else}
    <div class="feed">
      {#each shown as post (post.author + "/" + post.permlink)}
        {@const img = cover(post)}
        <article class="post panel" class:settled={post.paid_out}>
          <!-- The whole card is still one click target, but as an OVERLAY
               rather than a wrapping <a>. An anchor cannot legally contain
               another anchor, and the author's name has to be a real link to
               their profile — so the card link sits underneath everything and
               the interactive parts are lifted above it. -->
          <a class="cardlink" href={href(post)} aria-label={post.title}></a>
          <div class="link">
            {#if img}
              <div class="thumb">
                <img src={img} alt="" loading="lazy" />
              </div>
            {/if}
            <div class="body">
              <div class="meta">
                <span class="pill {post.window === 'deep' ? 'info' : 'warn'}">{post.window}</span>
                <a class="author" href="/{displayName(post.author)}">{displayName(post.author)}</a>
                <span class="dim">{shortDate(post.created_time)}</span>
                {#if post.payout_mode === PayoutMode.Burn}
                  <span class="pill bad">burns rewards</span>
                {:else if post.payout_mode === PayoutMode.PowerUp}
                  <span class="pill ok">100% minted</span>
                {/if}
              </div>

              <h3>{post.title}</h3>
              {#if blurb(post)}<p class="summary">{blurb(post)}</p>{/if}

              {#if post.tags && post.tags.length}
                <div class="tags">
                  {#each post.tags.slice(0, 5) as t (t)}<span class="tag">{t}</span>{/each}
                </div>
              {/if}

              <div class="stats">
                {#if post.paid_out}
                  <span class="pill ok">paid out</span>

                {:else}
                  <span class="pending mono gold">{lc(post.pending_payout)} LC</span>
                  <span class="dim">
                    {#if post.payable}window closed{:else}pays in {durationWords(post.payout_height - height)}{/if}
                  </span>
                {/if}
              </div>
            </div>
          </div>

          <!-- Above the card link: dragging the vote slider must not navigate,
               and the voter list opens in place rather than going anywhere. -->
          <div class="actions">
            <VoterList {post} />
            {#if post.paid_out}
              <!-- Nothing to click. Curation settles itself on the 1st: the
                   chain queues what each curator is owed and the monthly
                   settle drains it. See CLAUDE.md, curation queue. -->
              <span class="auto dim">settles on the 1st</span>
            {:else if post.payable}
              <button class="small" onclick={() => payout(post)} disabled={chain.busy}>
                Settle payout
              </button>
            {:else}
              <VoteSlider {post} onvoted={load} />
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .bar { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .filters { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .filters button.active { border-color: var(--gold); color: var(--gold); background: rgba(255, 210, 63, 0.07); }
  .filters small { display: block; font-size: var(--t-micro); opacity: 0.65; font-weight: 500; }
  .sorts { display: flex; gap: 0.4rem; }
  .sorts button.active { border-color: var(--gold); color: var(--gold); background: rgba(255, 210, 63, 0.07); }
  .write { margin-left: auto; color: var(--cyan); font-weight: 700; font-family: var(--mono); font-size: var(--t-sm); }

  .settle { border-color: var(--gold-dim); font-size: var(--t-sm); }
  .err { color: var(--red); }

  .feed { display: grid; gap: 0.85rem; }
  .post { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; padding: 0; overflow: hidden; }
  .post.settled { opacity: 0.72; }
  .post:hover { border-color: var(--line-hot); }

  /* The card-wide click target. Positioned, so it paints over the static
     content beneath it; anything that must stay clickable is lifted with
     `position: relative` below. */
  .cardlink { position: absolute; inset: 0; z-index: 0; }

  .link {
    flex: 1 1 420px; min-width: 0; display: flex; gap: 1rem;
    padding: 0.95rem 0 0.95rem 1rem; align-items: flex-start;
  }
  .thumb {
    flex: 0 0 132px; height: 96px; border-radius: var(--r-sm);
    overflow: hidden; background: #05070a; border: 1px solid var(--line-soft);
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .body { flex: 1 1 auto; min-width: 0; }
  .meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: var(--t-sm); }
  /* Lifted above the card overlay so it reaches the profile rather than the post. */
  .meta .author {
    font-weight: 700; color: var(--gold); font-family: var(--mono);
    position: relative; z-index: 1;
  }
  .meta .author:hover { text-decoration: underline; }

  h3 { margin: 0.4rem 0 0.3rem; font-size: var(--t-lg); line-height: 1.35; }
  .post:hover h3 { color: var(--gold); }
  .summary { margin: 0 0 0.5rem; color: var(--dim); font-size: var(--t-sm); line-height: 1.55; }

  .tags { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .tag {
    font-size: var(--t-micro); color: var(--dimmer); font-family: var(--mono);
    border: 1px solid var(--line-soft); padding: 0.08rem 0.4rem; border-radius: var(--r-sm);
  }

  .stats { display: flex; gap: 0.8rem; flex-wrap: wrap; align-items: center; font-size: var(--t-sm); color: var(--dim); }
  .pending { text-shadow: var(--glow-gold); font-weight: 700; }

  .auto { font-size: var(--t-tiny); font-family: var(--mono); text-align: right; }

  .actions {
    flex: 0 1 300px; display: flex; flex-direction: column;
    gap: 0.4rem; align-items: flex-end; padding: 0.95rem 1rem 0.95rem 0;
    position: relative; z-index: 1;   /* above the card overlay */
  }

  @media (max-width: 720px) {
    .link { flex-wrap: wrap; padding: 0.85rem 0.85rem 0.5rem; }
    .thumb { flex: 1 1 100%; height: 170px; }
    .auto { font-size: var(--t-tiny); font-family: var(--mono); text-align: right; }

  .actions { flex: 1 1 100%; align-items: stretch; padding: 0 0.85rem 0.85rem; }
  }
</style>

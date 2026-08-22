<script lang="ts">
  /** Tags beyond the first 10 collapse — they reach other outposts without wallpapering the page. */
  let allTags = $state(false);
  /**
   * A single post — the CANONICAL URL, `/@author/permlink`.
   *
   * Two sources, because that is genuinely how it works: the body comes from
   * the CONTENT layer (Hive in production) and the reward figures come from the
   * CHAIN. What changed with SSR is only WHEN each arrives.
   *
   *  - The article is rendered on the SERVER and is present in the raw HTML.
   *    That is what makes the post readable by search engines and AI crawlers,
   *    which is the thing every Hive frontend gets wrong.
   *  - The money — pending payout, the vote slider, the voter list — still
   *    loads in the BROWSER, from the chain, exactly as before. It is per-user
   *    and it moves every block, so it must never be baked into cached HTML.
   *
   * "Registered on-chain but never published" stays a real state that renders,
   * not an error: publishing writes the article first and registers it second.
   */
  import { onMount } from "svelte";
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, durationWords, lc, shortDate } from "$lib/format.js";
  import { renderMarkdown } from "$lib/markdown.js";
  import Seo from "$lib/Seo.svelte";
  import Comments from "$lib/Comments.svelte";
  import Hbd from "$lib/Hbd.svelte";
  import PromoteForm from "$lib/PromoteForm.svelte";
  import PromotedBadge from "$lib/PromotedBadge.svelte";
  import VoteSlider from "$lib/VoteSlider.svelte";
  import VoterList from "$lib/VoterList.svelte";
  import { SITE_NAME, SITE_URL, absolute, metaDescription, profileUrl } from "$lib/site.js";
  import { PayoutMode, type PostView } from "$api/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const a = $derived(data.article);

  /** The chain half: fetched in the browser, never server-rendered. */
  let post = $state<PostView | null>(null);
  let loadingMoney = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    try {
      const posts = await client.posts(200);
      post =
        posts.find((p) => p.author === a.author && p.permlink === a.permlink) ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loadingMoney = false;
    }
  }
  onMount(load);

  const height = $derived(chain.info?.height ?? 0);
  const rendered = $derived(a.body ? renderMarkdown(a.body) : "");
  const description = $derived(
    metaDescription(a.summary || `${a.title} — by @${a.handle} on ${SITE_NAME}.`),
  );
  const cover = $derived(a.cover ? absolute(a.cover) : null);

  /**
   * `Article` structured data.
   *
   * Built from CONTENT fields only. A crawler is being told who wrote this,
   * when, and which URL is the original — nothing about rewards, which would be
   * stale the moment it was serialised.
   */
  const schema = $derived({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.title,
    description,
    author: {
      "@type": "Person",
      name: `@${a.handle}`,
      url: profileUrl(a.author),
    },
    ...(a.created ? { datePublished: a.created } : {}),
    ...(cover ? { image: [cover] } : {}),
    url: a.canonical,
    mainEntityOfPage: { "@type": "WebPage", "@id": a.canonical },
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
      url: SITE_URL,
    },
    ...(a.tags.length ? { keywords: a.tags.join(", ") } : {}),
  });

  async function payout() {
    if (!post) return;
    error = await chain.submit(() => client.payout(post!.author, post!.permlink));
    await load();
  }
</script>

<Seo
  title={a.title}
  {description}
  canonical={a.canonical}
  image={cover}
  type="article"
  {schema}
  published={a.created}
  author={`@${a.handle}`}
  tags={a.tags}
/>

<div class="grid">
  <a class="back" href="/feed">← Feed</a>

  {#if !a.registered && !a.published}
    <p class="empty"><strong>Not found.</strong> This post is not registered on-chain.</p>
  {:else}
    <div class="row layout">
      <article class="panel article">
        <div class="meta">
          {#if a.window}
            <span class="pill {a.window === 'deep' ? 'info' : 'warn'}">{a.window}</span>
          {/if}
          <a class="author" href="/@{a.handle}">{displayName(a.author)}</a>
          {#if a.created}<span class="dim">{shortDate(a.created)}</span>{/if}
          {#if post?.payout_mode === PayoutMode.Burn}
            <span class="pill bad">burns rewards</span>
          {:else if post?.payout_mode === PayoutMode.PowerUp}
            <span class="pill ok">100% minted</span>
          {/if}
          <PromotedBadge promoted={post?.promoted} />
        </div>

        <h1>{a.title}</h1>

        {#if a.published}
          <!-- renderMarkdown escapes before emitting any tag. Same renderer on
               the server and in the browser, so what a crawler reads is byte
               for byte what a reader sees. -->
          <div class="rendered">{@html rendered}</div>
        {:else}
          <p class="unpublished">
            Registered on-chain, but the body was never published to the content
            layer. The payout window is still open.
          </p>
        {/if}

        {#if a.tags.length}
          <div class="tags">
            {#each (allTags ? a.tags : a.tags.slice(0, 10)) as t (t)}<span class="tag">{t}</span>{/each}
            {#if a.tags.length > 10 && !allTags}
              <button class="tag more" onclick={() => (allTags = true)}>+{a.tags.length - 10} more</button>
            {/if}
          </div>
        {/if}

        <p class="raw">
          <a href="{a.path}.md" rel="alternate" type="text/markdown">read as markdown</a>
        </p>
      </article>

      <aside class="side">
        <div class="panel">
          <h2>Rewards</h2>
          {#if loadingMoney}
            <p class="auto dim">Reading the chain…</p>
          {:else if !post}
            <p class="auto dim">Not registered on-chain — nothing to pay out.</p>
          {:else if !post.registered}
            <!-- On Hive under the `lassecash` tag, by an author who clears the
                 viral threshold — so it is shown here. It has no contract
                 record yet, so there is no pending payout to show and no
                 window running. The vote below is what opens both. -->
            <p class="auto dim">
              <strong>Not registered yet</strong> — the first vote opens the
              7-day window.
            </p>
          {:else}
            <!-- The vote count opens the voter list in place. It sits above the
                 figures rather than inside the <dl>, because expanding it would
                 otherwise push a definition list open mid-row. -->
            <div class="voters"><VoterList {post} /></div>

            <dl>
              {#if post.paid_out}
                <dt>Status</dt><dd><span class="pill ok">paid out</span></dd>
                {#if Number(post.curator_pot) > 0}
                  <dt>Still owed to curators</dt>
                  <dd class="mono">{lc(post.curator_pot)}</dd>
                {/if}
              {:else}
                <dt>Pending</dt>
                <dd class="mono gold">
                  {lc(post.pending_payout)}
                  <Hbd amount={post.pending_payout} block />
                </dd>
                <dt>Pays</dt>
                <dd class="mono">
                  {post.payable ? "window closed" : durationWords(post.payout_height - height)}
                </dd>
              {/if}
            </dl>
          {/if}
          <small class="dim">
            75% to the author, 25% split among curators by vote weight.
          </small>
        </div>

        {#if post}
          <div class="panel">
            <h2>{post.paid_out ? "Curation" : "Vote"}</h2>
            {#if !post.registered}
              <!-- Voting IS the registration — the contract registers an
                   author|permlink it does not recognise on the first vote. -->
              <VoteSlider {post} onvoted={load} />
            {:else if post.paid_out}
              <p class="auto">
                <strong class="green">Settled.</strong>
                Curators are paid automatically on the 1st — the chain remembers
                what each one is owed, so nobody has to claim anything. Anything
                still unclaimed after a year returns to the reward pool.
              </p>
            {:else if post.payable}
              <button onclick={payout} disabled={chain.busy}>Settle payout</button>
              <small class="dim">
                Permissionless — an absent author must never strand their curators.
              </small>
            {:else}
              <VoteSlider {post} onvoted={load} />
            {/if}
          </div>
        {/if}

        <!-- Promotion burns LASSECASH against a post RECORD and a running
             window. Neither exists yet on an unregistered post, so the
             contract would refuse the call — the panel stays away until the
             first vote has opened the window. -->
        {#if post && post.registered && !post.parent_permlink}
          <div class="panel">
            <h2>Promote</h2>
            <p class="auto">
              Burn LASSECASH to buy this post a clearly labelled slot in
              Trending — every fifth row, ordered by burn, <strong>never above
              the voted posts</strong>. Money and votes are not mixed.
            </p>
            <div class="promote-slot">
              <PromoteForm {post} onpromoted={load} />
            </div>
          </div>
        {/if}

        {#if error}<div class="panel err">{error}</div>{/if}
      </aside>
    </div>

    <!-- Comments hang off the CHAIN half, not the server-rendered article: a
         reply's pending reward moves every block and must never be baked into
         cached HTML. A registered post with no replies still renders the box. -->
    {#if post && post.registered && !post.parent_permlink}
      <Comments {post} />
    {/if}
  {/if}
</div>

<style>
  .back { color: var(--cyan); font-family: var(--mono); font-size: var(--t-sm); }
  .layout { align-items: flex-start; }
  .article { flex: 1 1 600px; }
  .side { flex: 1 1 300px; display: flex; flex-direction: column; gap: 1rem; }
  .side button { width: 100%; margin-bottom: 0.5rem; }
  .auto { margin: 0; font-size: var(--t-sm); color: var(--dim); line-height: 1.6; }

  .meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: var(--t-sm); }
  .meta .author { font-weight: 700; color: var(--gold); font-family: var(--mono); }
  .meta .author:hover { text-decoration: underline; }

  .voters { margin-bottom: 0.7rem; }
  .promote-slot { margin-top: 0.6rem; }

  h1 { margin: 0.6rem 0 1rem; font-size: 1.65rem; line-height: 1.3; }

  .unpublished {
    color: var(--dim); font-size: var(--t-sm); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0.8rem;
  }

  .tags { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 1.2rem; }
  .tag {
    font-size: var(--t-micro); color: var(--dimmer); font-family: var(--mono);
    border: 1px solid var(--line-soft); padding: 0.1rem 0.42rem; border-radius: var(--r-sm);
  }
  .raw { margin: 1.2rem 0 0; font-size: var(--t-micro); font-family: var(--mono); }
  .raw a { color: var(--dimmer); }
  .raw a:hover { color: var(--cyan); }

  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.4rem 1rem; margin: 0 0 0.6rem; }
  dt { color: var(--dim); font-size: var(--t-sm); }
  dd { margin: 0; text-align: right; }
  .err { color: var(--red); font-size: var(--t-sm); }

  .rendered { line-height: 1.75; font-size: 1rem; }
  .rendered :global(h1) { font-size: 1.35rem; margin: 1.4rem 0 0.55rem; }
  .rendered :global(h2) { font-size: 1.16rem; margin: 1.25rem 0 0.5rem; }
  .rendered :global(h3) { font-size: 1.02rem; margin: 1.1rem 0 0.45rem; }
  .rendered :global(a) { color: var(--cyan); text-decoration: underline; }
  .rendered :global(img) {
    max-width: 100%; height: auto; border-radius: var(--r-sm);
    display: block; margin: 1.1rem 0;
  }
  .rendered :global(blockquote) {
    margin: 1rem 0; padding: 0.4rem 0 0.4rem 0.9rem;
    border-left: 3px solid var(--gold-dim); color: var(--dim);
  }
  .rendered :global(pre) {
    background: #05070a; border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: 0.75rem; overflow-x: auto; font-size: var(--t-sm);
  }
  .rendered :global(.embed) {
    position: relative; padding-bottom: 56.25%; height: 0;
    margin: 1.1rem 0; border-radius: var(--r-sm); overflow: hidden;
  }
  .rendered :global(.embed iframe) { position: absolute; inset: 0; width: 100%; height: 100%; }
</style>

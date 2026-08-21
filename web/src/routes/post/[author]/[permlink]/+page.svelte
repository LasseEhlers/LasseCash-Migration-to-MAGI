<script lang="ts">
  /**
   * A single post.
   *
   * The body is fetched from the CONTENT layer (Hive in production) while the
   * reward figures come from the CHAIN. Two sources, because that is genuinely
   * how it works — the contract stores no article text.
   *
   * That also means "registered but never published" is a real state, not an
   * error, and this page has to render it rather than break.
   */
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { chain, client } from "$lib/chain.svelte.js";
  import { displayName, durationWords, lc, shortDate } from "$lib/format.js";
  import { renderMarkdown } from "$lib/markdown.js";
  import VoteSlider from "$lib/VoteSlider.svelte";
  import { PayoutMode, type Content, type PostView } from "$api/index.js";

  const author = $derived(decodeURIComponent(page.params.author ?? ""));
  const permlink = $derived(page.params.permlink ?? "");

  let post = $state<PostView | null>(null);
  let content = $state<Content | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    try {
      const [posts, body] = await Promise.all([
        client.posts(200),
        client.content(author, permlink),
      ]);
      post = posts.find((p) => p.author === author && p.permlink === permlink) ?? null;
      content = body;
      error = post ? null : "This post is not registered on-chain.";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
  onMount(load);

  const height = $derived(chain.info?.height ?? 0);
  const rendered = $derived(content?.body ? renderMarkdown(content.body) : "");

  async function payout() {
    if (!post) return;
    error = await chain.submit(() => client.payout(post!.author, post!.permlink));
    await load();
  }
</script>

<svelte:head>
  <title>{content?.title ?? permlink} · LasseCash</title>
</svelte:head>

<div class="grid">
  <a class="back" href="/feed">← Feed</a>

  {#if loading}
    <p class="empty">Loading…</p>
  {:else if !post}
    <p class="empty"><strong>Not found.</strong>{error}</p>
  {:else}
    <div class="row layout">
      <article class="panel article">
        <div class="meta">
          <span class="pill {post.window === 'deep' ? 'info' : 'warn'}">{post.window}</span>
          <span class="author">{displayName(post.author)}</span>
          <span class="dim">{shortDate(post.created_time)}</span>
          {#if post.payout_mode === PayoutMode.Burn}
            <span class="pill bad">burns rewards</span>
          {:else if post.payout_mode === PayoutMode.PowerUp}
            <span class="pill ok">100% minted</span>
          {/if}
        </div>

        <h1>{content?.title ?? post.title}</h1>

        {#if content?.body}
          <!-- renderMarkdown escapes before emitting any tag. -->
          <div class="rendered">{@html rendered}</div>
        {:else}
          <p class="unpublished">
            Registered on-chain, but the body was never published to the content
            layer. The payout window is still open.
          </p>
        {/if}

        {#if content?.tags?.length}
          <div class="tags">
            {#each content.tags as t (t)}<span class="tag">{t}</span>{/each}
          </div>
        {/if}
      </article>

      <aside class="side">
        <div class="panel">
          <h2>Rewards</h2>
          <dl>
            <dt>Votes</dt><dd class="mono">{post.votes}</dd>
            {#if post.paid_out}
              <dt>Status</dt><dd><span class="pill ok">paid out</span></dd>
              {#if Number(post.curator_pot) > 0}
                <dt>Still owed to curators</dt>
                <dd class="mono">{lc(post.curator_pot)}</dd>
              {/if}
            {:else}
              <dt>Pending</dt><dd class="mono gold">{lc(post.pending_payout)}</dd>
              <dt>Pays</dt>
              <dd class="mono">
                {post.payable ? "window closed" : durationWords(post.payout_height - height)}
              </dd>
            {/if}
          </dl>
          <small class="dim">
            75% to the author, 25% split among curators by vote weight.
          </small>
        </div>

        <div class="panel">
          <h2>{post.paid_out ? "Curation" : "Vote"}</h2>
          {#if post.paid_out}
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

        {#if error}<div class="panel err">{error}</div>{/if}
      </aside>
    </div>
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

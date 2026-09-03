<script lang="ts">
  /**
   * Comments — registered replies, and the box that writes one.
   *
   * A comment on LasseCash is a REGISTERED reply: the same post machinery with
   * a parent reference, running viral economics (7-day window, viral pool,
   * viral vote meter) but gated by its own lower stake threshold. So a good
   * comment earns real money, and a tip bot never appears at all.
   *
   * THE PREFLIGHT IS THE WHOLE POINT OF THE THRESHOLD. Publishing is two steps
   * — body to Hive, then registration with the contract — and they happen in
   * that order because an unregistered comment is recoverable while a payout
   * window over nothing is not. But it means a below-threshold reply would be
   * written to Hive and THEN refused by the chain, leaving the author with a
   * comment that exists and earns nothing, with no explanation. So the
   * threshold is checked here, from the engine's median of the top ten's
   * preferences, before anything is written anywhere.
   *
   * Nobody is censored: a below-threshold reply still exists on Hive and is
   * readable on every other frontend. It is simply not part of LasseCash.
   *
   * THREADED, Hive-style — decided 2026-09-03 (supersedes the one-level
   * KISS rule). Reply depth is unlimited, because that is how Hive
   * conversations actually shape themselves and the contract already allows
   * it (a registered comment is a registered record, so it can be a parent).
   * The INDENT is capped at three levels: unlimited indentation is the
   * diagonal staircase every Hive frontend suffers from; past the cap a
   * reply shows who it answers instead of marching further right.
   */
  import { onMount } from "svelte";
  import { chain, client, wallet } from "$lib/chain.svelte.js";
  import { displayName, lc, shortDate } from "$lib/format.js";
  import { renderMarkdown } from "$lib/markdown.js";
  import { readGovernedValue } from "$lib/governance.js";
  import Hbd from "$lib/Hbd.svelte";
  import VoteSlider from "$lib/VoteSlider.svelte";
  import { compare, constants, type PostView } from "$api/index.js";

  let { post }: { post: PostView } = $props();

  /** The replies, with their bodies attached. */
  type Reply = { view: PostView; body: string };
  let replies = $state<Reply[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** The reply box. */
  let draft = $state("");
  /** Which comment the box answers; null = the post itself. */
  let replyTo = $state<{ author: string; permlink: string } | null>(null);
  let box = $state<HTMLTextAreaElement | null>(null);
  /**
   * The composer lives at the top of the section, so from a Reply button far
   * down a thread, retargeting it LOOKED like nothing happened (Lasse,
   * 2026-09-03: "must be a bug!!"). The click now carries the reader to the
   * box and puts the cursor in it.
   */
  function replyToComment(author: string, permlink: string) {
    replyTo = { author, permlink };
    queueMicrotask(() => {
      box?.scrollIntoView({ behavior: "smooth", block: "center" });
      box?.focus();
    });
  }
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  /** Same path as the Write page: wallet-signed upload to images.hive.blog. */
  async function uploadFiles(files: Iterable<File>) {
    const user = chain.account?.replace(/^hive:/, "");
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!wallet || !user || images.length === 0) return false;
    uploading = true;
    error = null;
    try {
      for (const f of images) {
        const url = await wallet.uploadImage(f, user);
        draft += `${draft && !draft.endsWith("\n") ? "\n" : ""}![${f.name.replace(/[\]\[]/g, "")}](${url})\n`;
      }
    } catch (e) {
      error = `Image upload failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      uploading = false;
    }
    return true;
  }
  function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void uploadFiles(files); }
  }
  function onDrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void uploadFiles(files); }
  }
  let previewing = $state(false);
  let posting = $state(false);
  let threshold = $state<string | null>(null);

  const me = $derived(chain.me);

  /**
   * Whether the signed-in account clears the comment threshold.
   *
   * Null means NOT KNOWN — the chain has not answered yet, or the key is not
   * registered. A preflight that cannot read the threshold must refuse to
   * promise anything rather than assume the reply will be accepted.
   */
  const clearsThreshold = $derived.by(() => {
    if (!me || threshold === null) return null;
    return compare(me.shares, threshold) >= 0;
  });

  /**
   * Ranked: earning replies first, then by age.
   *
   * ARRANGING, not computing. `pending_payout` was worked out by the chain
   * against the live viral pool; `compare` orders the decimal strings as
   * numbers, which plain `<` would stop doing the moment a payout passed
   * JavaScript's safe integer range.
   */
  const ranked = $derived.by(() => {
    // TOP LEVEL keeps the money order; INSIDE a thread, time order — a
    // conversation read out of sequence is not a conversation. A reply whose
    // parent is missing from the list (filtered below threshold, or not yet
    // discovered) renders at top level rather than disappearing.
    const rootKey = `${post.author}/${post.permlink}`;
    const byKey = new Set(replies.map((r) => `${r.view.author}/${r.view.permlink}`));
    const children = new Map<string, Reply[]>();
    const roots: Reply[] = [];
    for (const r of replies) {
      const pk = `${r.view.parent_author}/${r.view.parent_permlink}`;
      if (pk !== rootKey && byKey.has(pk)) {
        const list = children.get(pk) ?? [];
        list.push(r);
        children.set(pk, list);
      } else {
        roots.push(r);
      }
    }
    roots.sort((a, b) => {
      // Registered replies rank above Hive-only ones, always. An unregistered
      // comment has no reward to compare, so ranking them together would put
      // a zero beside comments that are earning — the same rule the feed uses
      // for tagged-but-unregistered posts.
      const aOff = a.view.registered === false ? 1 : 0;
      const bOff = b.view.registered === false ? 1 : 0;
      if (aOff !== bOff) return aOff - bOff;
      const byReward = compare(b.view.pending_payout, a.view.pending_payout);
      if (byReward !== 0) return byReward;
      return a.view.created_height - b.view.created_height;
    });
    const byAge = (a: Reply, b: Reply) =>
      a.view.created_time < b.view.created_time ? -1 : a.view.created_time > b.view.created_time ? 1 : 0;
    const out: { r: Reply; depth: number }[] = [];
    const walk = (r: Reply, depth: number) => {
      out.push({ r, depth });
      for (const k of (children.get(`${r.view.author}/${r.view.permlink}`) ?? []).sort(byAge)) {
        walk(k, depth + 1);
      }
    };
    for (const r of roots) walk(r, 0);
    return out;
  });

  async function load() {
    try {
      const views = await client.comments(post.author, post.permlink);
      // Bodies live on the CONTENT layer, exactly like an article's. Fetched in
      // parallel because a comment list is small; the excerpt on the view is
      // capped and would silently truncate a long reply.
      const bodies = await Promise.all(
        views.map((v) =>
          client.content(v.author, v.permlink).catch(() => null),
        ),
      );
      replies = views.map((view, i) => ({
        view,
        body: bodies[i]?.body || view.body_excerpt || "",
      }));
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    void load();
    const v = await readGovernedValue(constants().paramPostThresholdComment);
    threshold = v ? v.value : null;
  });

  async function submit() {
    if (!draft.trim()) return;
    error = null;
    posting = true;
    try {
      const res = await client.comment({
        body: draft.trim(),
        parentAuthor: replyTo?.author ?? post.author,
        parentPermlink: replyTo?.permlink ?? post.permlink,
      });
      if (!res.ok) {
        // Contract messages carry RAW BASE UNITS and are diagnostic. This one
        // is the threshold refusal, which the preflight should have caught —
        // show it rather than swallow it.
        error = res.msg;
        return;
      }
      if (res.txId) {
        // Hive has the reply; wait for MAGI's verdict on the registration.
        const refused = await chain.awaitVerdict(res.txId, JSON.stringify(chain.me));
        if (refused) { error = refused; return; }
      }
      draft = "";
      replyTo = null;
      previewing = false;
      await load();
      await chain.refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      posting = false;
    }
  }
</script>

<section class="panel comments">
  <h2>
    Comments
    {#if !loading}<span class="count mono">{replies.length}</span>{/if}
  </h2>

  <p class="rule dim">
    A registered reply earns like a viral post — 7 days, the viral pool, real
    curation. That is why it takes stake to write one.
  </p>

  <!-- The reply box. Preflighted BEFORE anything is written to Hive. -->
  {#if !chain.account}
    <p class="gate dim">Sign in to reply.</p>
  {:else if clearsThreshold === null}
    <p class="gate dim">Reading the comment threshold from the chain…</p>
  {:else if !clearsThreshold}
    <p class="gate refuse">
      <strong>You need {lc(threshold ?? "0", 0)} L-Shares to comment.</strong>
      You hold {lc(me?.shares ?? "0", 0)}. The threshold is set by the top 10
      inside hardcoded bounds — mint LASSECASH to earn L-Shares and grow into it.
    </p>
  {:else}
    <div class="box">
      {#if replyTo}
        <p class="dim tiny replying">
          Replying to <b>{displayName(replyTo.author)}</b> ·
          <button class="linkish" onclick={() => (replyTo = null)}>reply to the post instead</button>
        </p>
      {/if}
      <textarea
        bind:this={box}
        bind:value={draft}
        rows="4"
        onpaste={onPaste}
        ondrop={onDrop}
        ondragover={(e) => e.preventDefault()}
        placeholder="Reply in markdown. A comment worth reading is worth paying for. Paste or drop an image to upload it."
      ></textarea>
      {#if wallet}
        <input type="file" accept="image/*" multiple hidden bind:this={fileInput}
          onchange={(e) => { const el = e.currentTarget; void uploadFiles(el.files ?? []); el.value = ""; }} />
        <p class="dim tiny">
          {#if uploading}Uploading to Hive's image server — your wallet signs…{:else}<button class="linkish" onclick={() => fileInput?.click()}>Add image</button> · or paste / drop one{/if}
        </p>
      {/if}
      {#if previewing && draft.trim()}
        <!-- The SAME renderer the post page and the feed use: what you write is
             byte for byte what everybody reads. -->
        <div class="preview rendered">{@html renderMarkdown(draft)}</div>
      {/if}
      <div class="boxactions">
        <button class="ghost small" onclick={() => (previewing = !previewing)} disabled={!draft.trim()}>
          {previewing ? "Edit" : "Preview"}
        </button>
        <button class="small" onclick={submit} disabled={!draft.trim() || posting || chain.busy}>
          {posting ? "Publishing…" : "Comment"}
        </button>
      </div>
      <small class="dim">
        Published to the content layer first, then registered on-chain — in that
        order, so a failed registration never leaves a payout window over
        nothing.
      </small>
    </div>
  {/if}

  {#if error}<p class="err">{error}</p>{/if}

  {#if loading}
    <p class="dim empty-note">Reading the chain…</p>
  {:else if ranked.length === 0}
    <p class="dim empty-note">No comments yet.</p>
  {:else}
    <ul class="list">
      {#each ranked as { r: { view, body }, depth } (view.author + "/" + view.permlink)}
        <!-- Indent is CAPPED: past three levels the thread stops marching
             right and the "→ name" marker carries who answers whom. -->
        <li class="comment" class:settled={view.paid_out} class:offchain={view.registered === false}
            class:context={view.shown_for_context}
            class:nested={depth > 0} style:margin-left="{Math.min(depth, 3) * 1.4}rem">
          <div class="cmeta">
            <a class="author" href="/{displayName(view.author)}">{displayName(view.author)}</a>
            {#if depth > 0}
              <span class="dim tiny">→ {displayName(view.parent_author)}</span>
            {/if}
            <span class="dim">{shortDate(view.created_time)}</span>
            {#if view.registered === false}
              <!-- Written from another Hive frontend by an author who clears
                   the comment threshold. Shown because it is part of the
                   conversation; marked because it earns nothing — only a
                   registered reply does. -->
              <span class="pill dimpill"
                title={view.shown_for_context
                  ? "Written on Hive by an author below the comment threshold — shown because someone qualified replied to it. It earns nothing."
                  : "Written on Hive, not registered with the contract — it earns nothing."}>
                {view.shown_for_context ? "context" : "from Hive"}
              </span>
            {:else if view.paid_out}
              <span class="pill ok">paid out</span>
            {:else}
              <span class="reward mono gold">{lc(view.pending_payout, 3)} LASSECASH</span>
              <Hbd amount={view.pending_payout} />
            {/if}
          </div>
          <div class="cbody rendered">{@html renderMarkdown(body)}</div>
          <div class="cactions">
            {#if view.registered === false}
              <!-- NO VOTE ON A HIVE-ONLY REPLY.
                   A first vote registers whatever it lands on, and for a
                   reply that means creating a record with ALWAYS-VIRAL
                   economics and the default split — terms its author never
                   chose, on a comment they wrote somewhere else. It also
                   opens a 7-day window from the vote rather than from the
                   comment. The author registers their own reply by writing it
                   here; a reader should not do it for them by accident. -->
              <span class="dim tiny">
                written on Hive — reply to it there; its author can register it by replying here
              </span>
            {:else if !view.paid_out && !view.payable}
              <VoteSlider post={view} onvoted={load} />
            {:else if view.payable}
              <span class="dim tiny">window closed — settles with the post</span>
            {:else}
              <span class="dim tiny">settles on the 1st</span>
            {/if}
            {#if view.registered !== false && clearsThreshold}
              <button class="ghost small" onclick={() => replyToComment(view.author, view.permlink)}>
                Reply
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  /* A comment is a small box; an image in one is an illustration, not a
     poster. Cap it, keep the aspect, and let the reader click through. */
  .preview :global(img), .cbody :global(img) {
    max-height: 320px; width: auto; max-width: 100%; border-radius: var(--r-sm);
  }

  .tiny { font-size: var(--t-tiny); margin: 0.3rem 0 0; }
  .linkish { background: none; border: 0; padding: 0; color: var(--cyan); cursor: pointer; font: inherit; box-shadow: none; }

  h2 { display: flex; align-items: center; gap: 0.5rem; }
  .count {
    font-size: var(--t-micro); color: var(--dim); border: 1px solid var(--line);
    border-radius: var(--r-sm); padding: 0.05rem 0.35rem;
  }
  .rule { margin: 0 0 0.8rem; font-size: var(--t-sm); line-height: 1.55; }

  .gate { font-size: var(--t-sm); line-height: 1.6; margin: 0 0 0.9rem; }
  .gate.refuse {
    color: var(--dim); background: var(--panel-2);
    border: 1px solid var(--line); border-left: 3px solid var(--amber);
    border-radius: var(--r-sm); padding: 0.65rem 0.75rem;
  }
  .gate.refuse strong { display: block; color: var(--amber); font-family: var(--mono); margin-bottom: 0.2rem; }

  /* app.css styles `input, select` but not `textarea`; without this the reply
     box renders as a white rectangle on a near-black page. */
  .box textarea {
    width: 100%; resize: vertical;
    background: #05070a; color: var(--ink);
    border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: 0.55rem 0.7rem;
    font-family: var(--sans); font-size: var(--t-sm); line-height: 1.6;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .box textarea:hover { border-color: var(--line-hot); }
  .box textarea:focus {
    outline: none; border-color: var(--cyan);
    box-shadow: 0 0 0 1px var(--cyan), 0 0 14px rgba(46, 230, 214, 0.18);
  }
  .boxactions { display: flex; gap: 0.4rem; justify-content: flex-end; margin: 0.45rem 0 0.35rem; }
  .box small { display: block; font-size: var(--t-micro); line-height: 1.5; }
  .preview {
    margin-top: 0.5rem; padding: 0.6rem 0.7rem; background: var(--panel-2);
    border: 1px solid var(--line); border-radius: var(--r-sm); font-size: var(--t-sm);
  }

  .err { color: var(--red); font-size: var(--t-sm); margin: 0.6rem 0 0; }
  .empty-note { font-size: var(--t-sm); margin: 0.9rem 0 0; }

  .list { list-style: none; margin: 1rem 0 0; padding: 0; display: grid; gap: 0.6rem; }
  /* A nested reply hangs off a faint rail — depth reads at a glance without
     the staircase. */
  .comment.nested { border-left: 2px solid var(--line); }
  /* Below-threshold, shown only because someone qualified engaged: readable,
     but visibly not a full citizen of the page. */
  .comment.context { opacity: 0.7; }
  .replying { margin: 0 0 0.4rem; }

  /* Deliberately LIGHTER than a post: no gradient, a hairline rule, a smaller
     type scale. A comment is part of a page, not a card competing with it. */
  .comment.offchain { opacity: 0.85; }
  .pill.dimpill { color: var(--dim); border: 1px solid var(--line); }
  .comment {
    border-top: 1px solid var(--line-soft);
    padding: 0.7rem 0 0.2rem;
  }
  .comment.settled { opacity: 0.72; }
  .cmeta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: var(--t-tiny); }
  .cmeta .author { font-weight: 700; color: var(--gold); font-family: var(--mono); }
  .cmeta .author:hover { text-decoration: underline; }
  .reward { font-weight: 700; }

  .cbody { margin: 0.4rem 0 0.5rem; font-size: var(--t-sm); line-height: 1.65; }
  .cbody :global(p) { margin: 0 0 0.5rem; }
  .cbody :global(p:last-child) { margin: 0; }
  .cbody :global(a) { color: var(--cyan); text-decoration: underline; }
  .cbody :global(img) { max-width: 100%; height: auto; border-radius: var(--r-sm); }
  .cbody :global(pre) {
    background: #05070a; border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: 0.6rem; overflow-x: auto; font-size: var(--t-tiny);
  }

  .cactions { display: flex; justify-content: flex-end; }
  .tiny { font-size: var(--t-micro); font-family: var(--mono); }
</style>

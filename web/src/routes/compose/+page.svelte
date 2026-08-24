<script lang="ts">
  /**
   * Publish to LasseMedia.
   *
   * Editor left, live preview RIGHT — the arrangement Hive authors already know
   * from hive.blog, and the only one where you can see an image or embed land
   * without scrolling away from what you are typing.
   *
   * Two things this screen must make true before anyone hits publish:
   *  1. The WINDOW choice is irreversible and worth ~3x (deep takes 75% of the
   *     pool against viral's 25%).
   *  2. The PAYOUT MODE is frozen with the post. "Burn" destroys the author's
   *     whole reward, so it is confirmed rather than clicked.
   */
  import { goto } from "$app/navigation";
  import { chain, client } from "$lib/chain.svelte.js";
  import { lc } from "$lib/format.js";
  import { renderMarkdown } from "$lib/markdown.js";
  import { PayoutMode, Window, permlinkFor } from "$api/index.js";
  import { wallet } from "$lib/chain.svelte.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";

  let title = $state("");
  let body = $state("");
  let summary = $state("");
  let tagInput = $state("");
  let tags = $state<string[]>([]);
  let window_ = $state<0 | 1>(0);
  let mode = $state<number>(PayoutMode.Split);
  let burnConfirmed = $state(false);
  let error = $state<string | null>(null);
  let published = $state<string | null>(null);
  let editor = $state<HTMLTextAreaElement | null>(null);

  const me = $derived(chain.me);
  const shares = $derived(me?.shares ?? "0.00000000");
  const rendered = $derived(renderMarkdown(body));

  /**
   * The LINK is the contract's key for the post and its URL forever, so it is
   * a field of its own: a long, descriptive headline and a short address are
   * both right, and authors used to get the second by editing the first after
   * publishing. Until the author touches it, it follows the title.
   */
  let link = $state("");
  let linkTouched = $state(false);
  const permlink = $derived(linkTouched ? permlinkFor(link) : permlinkFor(title));

  const canPublish = $derived(
    !!chain.account &&
      title.trim().length > 0 &&
      permlink.length > 0 &&
      !chain.busy &&
      (mode !== PayoutMode.Burn || burnConfirmed),
  );

  /**
   * Hive's tag rules: lowercase `[a-z0-9-]`, at most 24 characters. Count:
   * LasseCash allows 20 of the author's own (the old site's limit) plus
   * `lassecash` first, added at publish time — enough to reach every outpost
   * an author posts to; the post page shows the first 10 with an expander.
   * Tags decide NOTHING about visibility here: registration with the contract
   * does. A pasted "a b c" list is SPLIT, never glued into one tag.
   */
  const MAX_TAGS = 20;
  const MAX_TAG_LEN = 24;
  function addTag() {
    const parts = tagInput.split(/[\s,]+/);
    for (const raw of parts) {
      const t = raw.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, MAX_TAG_LEN);
      if (t && t !== "lassecash" && !tags.includes(t) && tags.length < MAX_TAGS) tags = [...tags, t];
    }
    tagInput = "";
  }
  function onTagKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " " || e.key === ",") {
      e.preventDefault();
      addTag();
    }
  }

  /** Insert at the cursor rather than appending — authors write mid-document. */
  function insert(text: string) {
    const el = editor;
    if (!el) { body += text; return; }
    const { selectionStart: a, selectionEnd: b } = el;
    body = body.slice(0, a) + text + body.slice(b);
    queueMicrotask(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = a + text.length;
    });
  }

  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  /**
   * Images go to Hive's own image server —
   * `POST https://images.hive.blog/:username/:signature`, the signature being
   * sha256("ImageSigningChallenge" + bytes) signed with the POSTING key. The
   * wallet signs; the file never touches our servers. Every existing Hive post
   * depends on that host, so it is maintained far beyond anything we could
   * run ourselves. Three ways in, all the same path: Ctrl+V an image, drop a
   * file on the editor, or the Image button. Without a wallet (dev chain) the
   * button falls back to asking for a URL.
   */
  async function uploadFiles(files: Iterable<File>) {
    const user = chain.account?.replace(/^hive:/, "");
    if (!wallet || !user) return false;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return false;
    uploading = true;
    error = null;
    try {
      for (const f of images) {
        const url = await wallet.uploadImage(f, user);
        insert(`\n![${f.name.replace(/[\]\[]/g, "")}](${url})\n`);
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
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void uploadFiles(files);
    }
  }
  function onDrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void uploadFiles(files);
    }
  }
  function addImage() {
    if (wallet && chain.account) { fileInput?.click(); return; }
    const url = prompt("Image URL");
    if (url && /^https?:\/\//i.test(url)) insert(`\n![](${url.trim()})\n`);
  }
  function addVideo() {
    const url = prompt("YouTube URL");
    if (url && /^https?:\/\//i.test(url)) insert(`\n${url.trim()}\n`);
  }

  async function publish() {
    error = null;
    published = null;
    chain.busy = true;
    try {
      const res = await client.publish({
        permlink,
        title: title.trim(),
        body,
        summary: summary.trim(),
        tags,
        window: window_ === 1 ? Window.Deep : Window.Viral,
        payoutMode: mode,
      });
      if (!res.ok) {
        error = res.msg;
        return;
      }
      if (res.txId) {
        // Hive has the article; now wait for MAGI's verdict on the registration.
        const refused = await chain.awaitVerdict(res.txId, JSON.stringify(chain.me));
        if (refused) { error = refused; return; }
      }
      published = res.permlink;
      const author = chain.account?.replace(/^hive:/, "") ?? "";
      title = "";
      link = "";
      linkTouched = false;
      body = "";
      summary = "";
      tags = [];
      burnConfirmed = false;
      await chain.refresh();
      // Hive-style: you see your post, not the empty editor.
      if (author) await goto(`/@${author}/${res.permlink}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      chain.busy = false;
    }
  }

</script>

<Seo
  title="Write"
  description="Publish to LasseMedia. Your post's canonical home is LasseCash, on every Hive frontend."
  canonical={`${SITE_URL}/compose`}
  image={SITE_OG_IMAGE}
/>

<div class="grid wide">
  {#if published}
    <div class="panel done">
      <strong class="gold">Published.</strong>
      Registered as <code>{published}</code> — the payout window is open.
      <a href="/feed">See it in the feed →</a>
    </div>
  {/if}

  <div class="split">
    <!-- EDITOR -->
    <section class="panel editor">
      <h2>Write</h2>

      <div class="windows">
        <button class="win" class:active={window_ === 0} onclick={() => (window_ = 0)}>
          <span class="wname">VIRAL</span>
          <span class="wmeta">pays in 7 days</span>
          <span class="wshare">25% of the pool</span>
        </button>
        <button class="win" class:active={window_ === 1} onclick={() => (window_ = 1)}>
          <span class="wname">DEEP</span>
          <span class="wmeta">pays in 30 days</span>
          <span class="wshare gold">75% of the pool</span>
        </button>
      </div>
      <p class="note">
        Deep draws on three times the reward pool but waits four times as long,
        and its votes regenerate over 30 days rather than 7.
        <strong>This cannot be changed after publishing.</strong>
      </p>

      <label class="field">
        <span>Title</span>
        <input bind:value={title} placeholder="Say something worth 30 days" />
      </label>

      <label class="field">
        <span>Link — short address of the post</span>
        <div class="linkrow">
          <span class="dim mono">/@{chain.account?.replace(/^hive:/, "") ?? "you"}/</span>
          <input
            class="mono"
            value={linkTouched ? link : permlink}
            oninput={(e) => { linkTouched = true; link = e.currentTarget.value; }}
            placeholder="from the title"
          />
        </div>
        <small class="dim">
          {#if permlink}Registered on-chain as <code>{permlink}</code> — this is the post's address forever.{:else}Letters and numbers; dashes between words.{/if}
        </small>
      </label>

      <div class="toolbar">
        <button class="ghost small" onclick={() => insert("**bold**")}>B</button>
        <button class="ghost small" onclick={() => insert("*italic*")}><em>i</em></button>
        <button class="ghost small" onclick={() => insert("\n## Heading\n")}>H</button>
        <button class="ghost small" onclick={() => insert("\n> quote\n")}>&ldquo;</button>
        <button class="ghost small" onclick={() => insert("\n- item\n")}>List</button>
        <button class="ghost small" onclick={addImage}>Image</button>
        <button class="ghost small" onclick={addVideo}>Video</button>
      </div>

      <input
        type="file" accept="image/*" multiple hidden
        bind:this={fileInput}
        onchange={(e) => { const el = e.currentTarget; void uploadFiles(el.files ?? []); el.value = ""; }}
      />
      <textarea
        bind:this={editor}
        bind:value={body}
        onpaste={onPaste}
        ondrop={onDrop}
        ondragover={(e) => e.preventDefault()}
        rows="18"
        placeholder="Write in markdown.&#10;&#10;Paste an image or YouTube URL on its own line and it embeds."
      ></textarea>

      <p class="note">
        {#if uploading}
          Uploading to Hive's image server — your wallet signs, the file never touches ours…
        {:else if wallet}
          Paste (Ctrl+V) or drop an image and it uploads to Hive's own image server, signed by your wallet.
        {:else}
          Image uploads need a wallet; on the dev chain, paste any image URL.
        {/if}
      </p>

      <label class="field">
        <span>Summary — shown in the feed</span>
        <input bind:value={summary} maxlength="140" placeholder="One line, 140 characters" />
        <small class="dim">{summary.length}/140</small>
      </label>

      <label class="field">
        <span>Tags</span>
        <input bind:value={tagInput} onkeydown={onTagKey} onblur={addTag} placeholder="enter or space to add" />
        <small class="dim">{tags.length}/{MAX_TAGS} · up to {MAX_TAG_LEN} letters each · <code>lassecash</code> is added automatically</small>
      </label>
      {#if tags.length}
        <div class="tags">
          {#each tags as t (t)}
            <button class="tag" onclick={() => (tags = tags.filter((x) => x !== t))}>
              {t} <span class="x">×</span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <!-- PREVIEW -->
    <section class="panel preview">
      <h2>Preview</h2>
      {#if title || body}
        <article class="rendered">
          {#if title}<h1 class="ptitle">{title}</h1>{/if}
          <!-- renderMarkdown escapes everything before emitting tags; never
               pass unescaped author content here. -->
          {@html rendered}
        </article>
      {:else}
        <p class="empty">Nothing written yet.</p>
      {/if}
    </section>
  </div>

  <!-- PAYOUT -->
  <div class="row">
    <section class="panel">
      <h2>Your reward</h2>
      <div class="modes">
        <label class:sel={mode === PayoutMode.Split}>
          <input type="radio" bind:group={mode} value={PayoutMode.Split} />
          <span class="mname">20% liquid · 80% minted</span>
          <span class="mdesc">
            A fifth arrives spendable. The rest accrues and becomes one mint on
            the 1st, at your chosen duration.
          </span>
        </label>
        <label class:sel={mode === PayoutMode.PowerUp}>
          <input type="radio" bind:group={mode} value={PayoutMode.PowerUp} />
          <span class="mname">100% minted</span>
          <span class="mdesc">Nothing liquid. All of it compounds into L-Shares.</span>
        </label>
        <label class:sel={mode === PayoutMode.Burn} class:danger={mode === PayoutMode.Burn}>
          <input type="radio" bind:group={mode} value={PayoutMode.Burn} />
          <span class="mname red">Burn it</span>
          <span class="mdesc">
            Your whole author reward is destroyed and recorded against total
            supply. Curators are still paid normally.
          </span>
        </label>
      </div>

      {#if mode === PayoutMode.Burn}
        <label class="confirm">
          <input type="checkbox" bind:checked={burnConfirmed} />
          <span>I understand this reward is destroyed and cannot be recovered.</span>
        </label>
      {/if}

      <p class="note">
        Applies to your reward only — it never changes what curators get.
        Frozen once published.
      </p>
    </section>

    <section class="panel publish">
      <h2>Publish</h2>
      <dl>
        <dt>Your L-Shares</dt>
        <dd class="mono gold">{lc(shares)}</dd>
        <dt>Window</dt>
        <dd class="mono">{window_ === 1 ? "Deep · 30 days" : "Viral · 7 days"}</dd>
      </dl>
      <small class="dim">
        Posting requires L-Shares, and the threshold is set by the top 10 — a
        governed value with hardcoded bounds. If publishing is refused, the
        chain says what you need.
      </small>
      {#if error}<p class="err">{error}</p>{/if}
      <button onclick={publish} disabled={!canPublish}>
        {#if !chain.account}Sign in to publish
        {:else if chain.busy}Publishing…
        {:else}Publish to {window_ === 1 ? "Deep" : "Viral"}{/if}
      </button>
    </section>
  </div>
</div>

<style>
  .linkrow { display: flex; align-items: center; gap: 0.3rem; }
  .linkrow input { flex: 1; }

  /* Editor left, preview right — side by side on anything wide enough. */
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
  @media (max-width: 980px) {
    .split { grid-template-columns: 1fr; }
  }
  .preview { position: sticky; top: 4.5rem; max-height: calc(100vh - 6rem); overflow-y: auto; }
  @media (max-width: 980px) {
    .preview { position: static; max-height: none; }
  }

  .windows { display: flex; gap: 0.6rem; margin-bottom: 0.6rem; }
  .win {
    flex: 1; display: flex; flex-direction: column; gap: 0.15rem;
    background: transparent; border: 1px solid var(--line); color: var(--dim);
    padding: 0.7rem; text-align: left; border-radius: var(--r);
  }
  .win:hover { border-color: var(--line-hot); box-shadow: none; }
  .win.active { border-color: var(--gold); background: rgba(255, 210, 63, 0.07); color: var(--ink); }
  .wname { font-size: var(--t-base); font-weight: 800; letter-spacing: 0.1em; }
  .wmeta { font-size: var(--t-tiny); font-weight: 500; }
  .wshare { font-size: var(--t-tiny); font-weight: 700; }

  .note { margin: 0 0 1rem; font-size: var(--t-tiny); color: var(--dim); line-height: 1.6; }

  .toolbar { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-bottom: 0.4rem; }

  textarea {
    width: 100%; background: #05070a; color: var(--ink);
    border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: 0.6rem 0.65rem; font: var(--t-sm)/1.6 var(--mono); resize: vertical;
    margin-bottom: 0.5rem;
  }
  textarea:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan); }

  .tags { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.9rem; }
  .tag {
    background: rgba(46, 230, 214, 0.09); color: var(--cyan);
    border: 1px solid rgba(46, 230, 214, 0.35); padding: 0.15rem 0.5rem;
    font-size: var(--t-micro); font-weight: 700; border-radius: var(--r-sm);
  }
  .tag:hover { box-shadow: none; filter: brightness(1.2); }
  .tag .x { opacity: 0.6; }

  .modes { display: grid; gap: 0.5rem; margin-bottom: 0.7rem; }
  .modes label {
    display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.5rem;
    align-items: start; padding: 0.55rem 0.6rem; cursor: pointer;
    border: 1px solid var(--line); border-radius: var(--r-sm);
  }
  .modes label.sel { border-color: var(--gold); background: rgba(255, 210, 63, 0.06); }
  .modes label.sel.danger { border-color: var(--red); background: rgba(255, 77, 77, 0.08); }
  .modes input { grid-row: span 2; margin-top: 0.2rem; accent-color: var(--gold); }
  .mname { font-weight: 700; font-size: var(--t-sm); font-family: var(--mono); }
  .mdesc { grid-column: 2; font-size: var(--t-tiny); color: var(--dim); line-height: 1.5; }

  .confirm {
    display: flex; gap: 0.5rem; align-items: flex-start;
    font-size: var(--t-tiny); color: #ffc0c0; line-height: 1.5;
    background: rgba(255, 77, 77, 0.08); border: 1px solid rgba(255, 77, 77, 0.35);
    border-radius: var(--r-sm); padding: 0.5rem 0.6rem; margin-bottom: 0.7rem;
  }
  .confirm input { accent-color: var(--red); margin-top: 0.15rem; }

  .publish { flex: 0 1 330px; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.4rem 1rem; margin: 0 0 0.6rem; }
  dt { color: var(--dim); font-size: var(--t-sm); }
  dd { margin: 0; text-align: right; }
  .publish button { width: 100%; padding: 0.7rem; margin-top: 0.8rem; }
  .err { color: var(--red); font-size: var(--t-sm); margin: 0.7rem 0 0; }

  .done { border-color: var(--gold); }
  .done a { color: var(--cyan); margin-left: 0.4rem; }

  .rendered { line-height: 1.7; }
  .ptitle { margin: 0 0 0.8rem; font-size: 1.45rem; line-height: 1.3; }
  .rendered :global(h1) { font-size: 1.3rem; margin: 1.2rem 0 0.5rem; }
  .rendered :global(h2) { font-size: 1.12rem; margin: 1.1rem 0 0.45rem; }
  .rendered :global(h3) { font-size: 1rem; margin: 1rem 0 0.4rem; }
  .rendered :global(a) { color: var(--cyan); text-decoration: underline; }
  .rendered :global(img) { max-width: 100%; height: auto; border-radius: var(--r-sm); display: block; margin: 0.9rem 0; }
  .rendered :global(blockquote) {
    margin: 0.9rem 0; padding: 0.35rem 0 0.35rem 0.85rem;
    border-left: 3px solid var(--gold-dim); color: var(--dim);
  }
  .rendered :global(pre) {
    background: #05070a; border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: 0.7rem; overflow-x: auto; font-size: var(--t-sm);
  }
  .rendered :global(.embed) {
    position: relative; padding-bottom: 56.25%; height: 0;
    margin: 0.9rem 0; border-radius: var(--r-sm); overflow: hidden;
  }
  .rendered :global(.embed iframe) { position: absolute; inset: 0; width: 100%; height: 100%; }
</style>

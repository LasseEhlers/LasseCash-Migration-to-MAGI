<script lang="ts">
  /**
   * The About page.
   *
   * Rendered with the SAME markdown renderer every post uses, from the same
   * file `/about.md` serves raw. One source, one renderer — the alternative is
   * an About page that quietly disagrees with the copy an AI crawler read.
   */
  import { renderMarkdown } from "$lib/markdown.js";
  import AboutFigure from "$lib/AboutFigure.svelte";
  import DoorFigure from "$lib/DoorFigure.svelte";
  import Seo from "$lib/Seo.svelte";
  import { SITE_DESCRIPTION, SITE_NAME, SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  /**
   * The document is split on its `[figure: …]` lines and each piece rendered
   * separately, so the drawings can be interleaved without the markdown
   * renderer ever having to permit raw HTML or a relative image src. The
   * marker line stays in docs/ABOUT.md — `/about.md` and the GitHub README are
   * text-only readings of the same file, and a sentence describing the diagram
   * is what a text reader actually wants.
   */
  const FIGURES = [
    { marker: "emission curve", kind: "emission" as const },
    { marker: "the claim window", kind: "claim" as const },
    { marker: "the life of a mint", kind: "mint" as const },
  ];

  /**
   * The three "doors" in the short version get a drawing each, placed beside
   * the paragraph. Located by the bold verb that opens each paragraph; the
   * drawing is inserted BEFORE it so the picture leads and the words follow.
   * Only the first occurrence of each verb is a door — the rest of the
   * document uses the same words in ordinary prose.
   */
  const DOORS = [
    { opener: "**Write.**", kind: "write" as const },
    { opener: "**Lock.**", kind: "lock" as const },
    { opener: "**Provide.**", kind: "provide" as const },
  ];

  type Part = { html?: string; kind?: "emission" | "claim" | "mint"; door?: "write" | "lock" | "provide" };

  /**
   * docs/ABOUT.md is hard-wrapped at ~80 columns so it diffs well in git. The
   * post renderer turns every newline inside a paragraph into <br /> — right
   * for Hive posts, where authors write poems and addresses and peakd does the
   * same — but here it rendered the prose as an 80-column block on a 1900px
   * screen. Unwrap: a single newline between two text lines becomes a space.
   * Blank lines (paragraphs), list items, table rows and headings are
   * untouched because each starts its line with a marker the lookahead
   * excludes.
   *
   * CODE FENCES ARE NOT, AND THAT WAS A BUG. Only the ``` lines themselves
   * start with a backtick; the CONTENT starts with whatever the author wrote.
   * The supply-reconciliation block in section 3 begins its lines with
   * "exists", "−", "=" and "+", none of them excluded, so all seven lines
   * were joined into one and the page grew a horizontal scrollbar around a
   * column of figures (found 2026-09-02).
   *
   * So the fences are split out FIRST and passed through untouched. A code
   * block means "these characters, these lines" — reflowing it is never right.
   */
  function unwrap(md: string): string {
    // Odd indices are the inside of a fence, and are left exactly as written.
    return md
      .split(/(```[\s\S]*?```)/g)
      .map((part, i) => (i % 2 ? part : part.replace(/([^\n])\n(?![\n|#>*\-\d\[`])/g, "$1 ")))
      .join("");
  }

  const parts = $derived.by(() => {
    const out: Part[] = [];
    let rest = unwrap(data.markdown);
    // Doors first: they all sit in the short version at the very top.
    for (const d of DOORS) {
      const at = rest.indexOf("\n" + d.opener);
      if (at < 0) continue;
      out.push({ html: renderMarkdown(rest.slice(0, at)) });
      out.push({ door: d.kind });
      rest = rest.slice(at + 1);
    }
    for (const f of FIGURES) {
      const line = rest.split("\n").find((l) => l.startsWith("[figure:") && l.includes(f.marker));
      if (!line) continue;
      const at = rest.indexOf(line);
      out.push({ html: renderMarkdown(rest.slice(0, at)) });
      out.push({ kind: f.kind });
      rest = rest.slice(at + line.length);
    }
    out.push({ html: renderMarkdown(rest) });
    return out;
  });
</script>

<Seo
  title={data.edition === "short" ? `${SITE_NAME} in a minute` : `About ${SITE_NAME}`}
  description={data.edition === "short"
    ? "Three ways to earn LASSECASH — write, lock, provide — on a token nobody can change. The one-minute version."
    : SITE_DESCRIPTION}
  canonical={`${SITE_URL}/about/${data.edition}`}
  image={SITE_OG_IMAGE}
  schema={{
    "@context": "https://schema.org",
    "@type": "AboutPage",
    name: `About ${SITE_NAME}`,
    description: SITE_DESCRIPTION,
    url: `${SITE_URL}/about/${data.edition}`,
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
  }}
/>

<div class="grid">
  <article class="panel">
    <!-- Two editions, two real URLs. The short one is the link you send a
         person; the full one is the rule book the tests check against the
         engine. Both come from the same file, so they cannot disagree. -->
    <nav class="editions" aria-label="About editions">
      <a href="/about/short" class:active={data.edition === "short"}>The short version</a>
      <a href="/about/full" class:active={data.edition === "full"}>The full version</a>
    </nav>
    <div class="rendered">
      {#each parts as p, i (i)}
        {#if p.kind}<AboutFigure kind={p.kind} />{:else if p.door}<DoorFigure kind={p.door} />{:else}{@html p.html}{/if}
      {/each}
    </div>
    {#if data.edition === "short"}
      <p class="more"><a href="/about/full">Read the full version →</a> — every rule, precisely enough to be checked against the code.</p>
    {/if}
    <p class="raw"><a href="/about.md" rel="alternate" type="text/markdown">read as markdown</a></p>
  </article>
</div>

<style>
  .editions { display: flex; gap: 0.4rem; margin: 0 0 1.2rem; border-bottom: 1px solid var(--line); }
  .editions a {
    padding: 0.55rem 1rem; font-family: var(--mono); font-size: 0.9rem; text-decoration: none;
    color: var(--dim); border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .editions a:hover { color: var(--ink); }
  .editions a.active { color: var(--gold); border-bottom-color: var(--gold); }
  .more { margin: 1.6rem 0 0; padding: 0.9rem 1rem; background: var(--panel-2); border-left: 3px solid var(--gold); border-radius: 4px; }
  .more a { color: var(--gold); font-weight: 600; }
  .rendered { line-height: 1.75; }
  .rendered :global(h1) { font-size: 1.6rem; margin: 0 0 0.8rem; }
  .rendered :global(h2) { font-size: 1.2rem; margin: 1.4rem 0 0.5rem; }
  .rendered :global(a) { color: var(--cyan); text-decoration: underline; }
  .rendered :global(img) { max-width: 100%; height: auto; }
  .raw { margin: 1.6rem 0 0; font-size: var(--t-micro); font-family: var(--mono); }
  .raw a { color: var(--dimmer); }
  .raw a:hover { color: var(--cyan); }
</style>

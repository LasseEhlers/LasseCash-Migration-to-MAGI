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
  import Seo from "$lib/Seo.svelte";
  import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "$lib/site.js";
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

  const parts = $derived.by(() => {
    const out: Array<{ html?: string; kind?: "emission" | "claim" | "mint" }> = [];
    let rest = data.markdown;
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
  title={`About ${SITE_NAME}`}
  description={SITE_DESCRIPTION}
  canonical={`${SITE_URL}/about`}
  schema={{
    "@context": "https://schema.org",
    "@type": "AboutPage",
    name: `About ${SITE_NAME}`,
    description: SITE_DESCRIPTION,
    url: `${SITE_URL}/about`,
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
  }}
/>

<div class="grid">
  <article class="panel">
    <div class="rendered">
      {#each parts as p, i (i)}
        {#if p.kind}<AboutFigure kind={p.kind} />{:else}{@html p.html}{/if}
      {/each}
    </div>
    <p class="raw"><a href="/about.md" rel="alternate" type="text/markdown">read as markdown</a></p>
  </article>
</div>

<style>
  .rendered { line-height: 1.75; }
  .rendered :global(h1) { font-size: 1.6rem; margin: 0 0 0.8rem; }
  .rendered :global(h2) { font-size: 1.2rem; margin: 1.4rem 0 0.5rem; }
  .rendered :global(a) { color: var(--cyan); text-decoration: underline; }
  .rendered :global(img) { max-width: 100%; height: auto; }
  .raw { margin: 1.6rem 0 0; font-size: var(--t-micro); font-family: var(--mono); }
  .raw a { color: var(--dimmer); }
  .raw a:hover { color: var(--cyan); }
</style>

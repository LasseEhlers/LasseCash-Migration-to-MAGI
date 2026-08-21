<script lang="ts">
  /**
   * The About page.
   *
   * Rendered with the SAME markdown renderer every post uses, from the same
   * file `/about.md` serves raw. One source, one renderer — the alternative is
   * an About page that quietly disagrees with the copy an AI crawler read.
   */
  import { renderMarkdown } from "$lib/markdown.js";
  import Seo from "$lib/Seo.svelte";
  import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "$lib/site.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const rendered = $derived(renderMarkdown(data.markdown));
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
    <div class="rendered">{@html rendered}</div>
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

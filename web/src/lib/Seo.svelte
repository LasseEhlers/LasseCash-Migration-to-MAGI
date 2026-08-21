<script lang="ts">
  /**
   * Every meta tag a page needs, in one place.
   *
   * WHY A COMPONENT. The post page, the profile page and the feed all need the
   * same eleven tags with different values. Written out three times they drift,
   * and the way you find out is a crawler indexing the wrong URL — months
   * later, silently. One component means one shape.
   *
   * The values are all CONTENT, never money. Nothing here is derived; the
   * caller passes strings that came off the content layer.
   */
  import { SITE_NAME, jsonLd } from "$lib/site.js";

  interface Props {
    title: string;
    description: string;
    /** Absolute canonical URL. Required — a relative one is worse than none. */
    canonical: string;
    /** Absolute image URL, if the page has one. */
    image?: string | null;
    type?: "website" | "article" | "profile";
    /** Structured data, already an object. Serialised and escaped here. */
    schema?: unknown;
    /** ISO timestamps, article pages only. */
    published?: string | null;
    /** `@name` of the author, article pages only. */
    author?: string | null;
    tags?: string[] | null;
    /** Set on pages that should not be indexed (drafts, per-user views). */
    noindex?: boolean;
  }

  let {
    title, description, canonical, image = null, type = "website",
    schema = null, published = null, author = null, tags = null, noindex = false,
  }: Props = $props();

  const fullTitle = $derived(
    title.endsWith(SITE_NAME) ? title : `${title} · ${SITE_NAME}`,
  );
  // Twitter shows a large image only when there IS one; claiming
  // summary_large_image with no image renders as an empty box.
  const card = $derived(image ? "summary_large_image" : "summary");
</script>

<svelte:head>
  <title>{fullTitle}</title>
  <meta name="description" content={description} />
  <link rel="canonical" href={canonical} />
  {#if noindex}<meta name="robots" content="noindex, follow" />{/if}

  <meta property="og:site_name" content={SITE_NAME} />
  <meta property="og:type" content={type} />
  <meta property="og:title" content={fullTitle} />
  <meta property="og:description" content={description} />
  <meta property="og:url" content={canonical} />
  {#if image}<meta property="og:image" content={image} />{/if}

  <meta name="twitter:card" content={card} />
  <meta name="twitter:title" content={fullTitle} />
  <meta name="twitter:description" content={description} />
  {#if image}<meta name="twitter:image" content={image} />{/if}

  {#if published}<meta property="article:published_time" content={published} />{/if}
  {#if author}<meta property="article:author" content={author} />{/if}
  {#each tags ?? [] as tag (tag)}
    <meta property="article:tag" content={tag} />
  {/each}

  <!-- The whole tag is emitted as a string: Svelte treats a literal <script>
       in the template as component code, and the JSON is escaped by jsonLd()
       so a post title can never break out of the block. -->
  {#if schema}
    {@html `<script type="application/ld+json">${jsonLd(schema)}<` + `/script>`}
  {/if}
</svelte:head>

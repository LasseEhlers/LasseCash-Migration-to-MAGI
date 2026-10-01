/**
 * `json_metadata` for a Hive post — where LasseCash CLAIMS OWNERSHIP of the
 * content it publishes.
 *
 * THE PROBLEM. A Hive post is one record on one chain, rendered by five or six
 * different frontends at five or six different URLs. To a search engine that is
 * six copies of the same article with nothing to say which is the original, and
 * the authority that should accrue to one page gets split — or spent on someone
 * else's domain.
 *
 * THE CONVENTION. `canonical_url` in a post's `json_metadata` is what peakd and
 * ecency read to decide whose `<link rel="canonical">` to emit. Set it, and
 * every other frontend showing this post tells crawlers the real copy lives on
 * lassecash.com. It is voluntary, it is honoured in practice, and it costs a
 * field.
 *
 * `app` is the other half of the same claim: it is what puts "posted using
 * LasseCash" on the post everywhere it appears.
 *
 * Kept as a pure function, apart from the signer, so it can be tested without a
 * wallet — and so there is exactly one place that decides what a LasseCash post
 * declares about itself.
 */

/** The app string written into every post this frontend publishes. */
export const APP_ID = "lassecash/2.0";

export interface PostMetadataInput {
  /** Bare Hive account name, no `hive:` prefix and no `@`. */
  author: string;
  permlink: string;
  tags: string[];
  /** Short description; becomes the post's excerpt on other frontends. */
  summary?: string;
  /** Cover image URL, if the body has one. */
  image?: string | null;
  /**
   * The canonical origin, e.g. `https://lassecash.com`. Passed in rather than
   * imported so the indexer never hardcodes the site's address — the frontend
   * owns that (see web/src/lib/site.ts).
   */
  siteUrl: string;
}

/** Everything LasseCash declares about a post it publishes. */
export interface PostMetadata {
  app: string;
  format: "markdown";
  tags: string[];
  description: string;
  canonical_url: string;
  image?: string[];
}

export function postMetadata(input: PostMetadataInput): PostMetadata {
  const origin = input.siteUrl.replace(/\/+$/, "");
  const author = input.author.replace(/^hive:/, "").replace(/^@/, "");

  const meta: PostMetadata = {
    app: APP_ID,
    format: "markdown",
    tags: input.tags,
    description: input.summary ?? "",
    canonical_url: `${origin}/@${author}/${input.permlink}`,
  };
  // Only when there is one: an empty image array makes some frontends render a
  // broken placeholder rather than no image.
  if (input.image) meta.image = [input.image];
  return meta;
}

/**
 * A reply's permlink, in Hive's own convention: `re-<parent>-<timestamp>`.
 *
 * THIS IS THE CONTRACT'S KEY FOR THE REPLY. It is derived once, here, and used
 * for BOTH steps of publishing — the Hive `comment` operation and the
 * contract's `comment` entrypoint. If the two ever disagreed the reward would
 * attach to nothing, which is why the client computes it rather than letting
 * each backend invent its own.
 *
 * Constraints it has to satisfy at once:
 *   - Hive permlinks are lowercase, `[a-z0-9-]`, and at most 256 characters.
 *   - The contract refuses any permlink containing `|` — arguments are
 *     pipe-delimited positional strings — and refuses a permlink already used
 *     by the same author, which the timestamp is there to prevent.
 *
 * Not economics: this is content plumbing, and it lives beside the metadata
 * that goes out with the same operation.
 */
export function commentPermlink(
  parentAuthor: string,
  parentPermlink: string,
  now: number = Date.now(),
): string {
  const parent = parentAuthor.replace(/^hive:/, "").replace(/^@/, "");
  // Millisecond stamp: two replies to the same parent in the same second is a
  // double-click, not a rare event, and a collision is a rejected transaction.
  const stamp = new Date(now).toISOString().replace(/[^0-9]/g, "");
  const slug = `re-${parent}-${parentPermlink}-${stamp}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  // Trim from the FRONT of the parent part, never the stamp: uniqueness is
  // load-bearing and the parent name is only there for readability.
  return slug.length <= 255 ? slug : slug.slice(slug.length - 255).replace(/^-+/, "");
}

/**
 * The same declaration for a COMMENT.
 *
 * A comment's canonical URL is its parent article's page plus the comment's own
 * permlink as a fragment, since that is where a reader would actually land —
 * and a reply thread is exactly the sort of long-tail content that otherwise
 * gets indexed on somebody else's domain by default.
 */
export function commentMetadata(
  input: PostMetadataInput & { parentAuthor: string; parentPermlink: string },
): PostMetadata {
  const origin = input.siteUrl.replace(/\/+$/, "");
  const parent = input.parentAuthor.replace(/^hive:/, "").replace(/^@/, "");
  return {
    app: APP_ID,
    format: "markdown",
    tags: input.tags,
    description: input.summary ?? "",
    canonical_url: `${origin}/@${parent}/${input.parentPermlink}#@${
      input.author.replace(/^hive:/, "").replace(/^@/, "")
    }/${input.permlink}`,
  };
}

/**
 * `json_metadata` for an EDIT — a MERGE, never a replacement.
 *
 * ⚠️ AN EDIT CAN DESTROY ANOTHER APP'S POST. A post tagged `lassecash` from
 * any Hive frontend is registered here by its first vote, so our Edit button
 * appears on posts we did not publish — Actifit reports, Waivio reviews, NFT
 * listings. Those apps identify their own posts by fields in `json_metadata`
 * (`app` above all) and pay out on that basis. Writing our metadata over
 * theirs would quietly cost their author rewards somewhere else, for the
 * crime of fixing a typo on our site.
 *
 * So: everything the post already declares is kept. We overwrite only the
 * fields the author just edited in our form — tags, description, image — and
 * we claim `app` and `canonical_url` ONLY on a post that already carries our
 * claim, i.e. one published here.
 *
 * ⚠️ WE DO NOT CLAIM A POST WE DID NOT PUBLISH, even when it carries no claim
 * at all. `canonical_url` says "the original lives at lassecash.com" — true of
 * what we published, false of an Actifit report whose author merely fixed a
 * typo here. Filling in a missing canonical would make one Edit click quietly
 * hand us the search ranking for somebody else's article, which is the exact
 * thing the canonical convention exists to prevent. The honest way to own a
 * post's canonical is to publish it here.
 *
 * `format` is the one exception: it describes how to RENDER the body, claims
 * nothing, and a post without it renders wrong.
 */
export function editMetadata(
  base: Record<string, unknown> | null | undefined,
  input: PostMetadataInput,
): Record<string, unknown> {
  const ours = postMetadata(input);
  const meta: Record<string, unknown> = { ...(base ?? {}) };

  // The author just typed these; they are the edit.
  meta.tags = ours.tags;
  meta.description = ours.description;
  if (ours.image) meta.image = ours.image;
  else delete meta.image; // the cover was removed from the body

  // Rendering, not ownership — safe to supply when missing.
  if (!meta.format) meta.format = ours.format;

  // Ownership: refreshed only on a post that is already ours.
  if (typeof meta.app === "string" && meta.app.startsWith("lassecash/")) {
    meta.app = ours.app;
    if (!meta.canonical_url) meta.canonical_url = ours.canonical_url;
  }
  return meta;
}

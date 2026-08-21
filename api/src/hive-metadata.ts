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
 * The same declaration for a COMMENT.
 *
 * ⚠️ TODO — THERE IS NO COMMENT PUBLISH PATH YET. Nothing in the frontend calls
 * this: LasseMedia publishes articles and the contract opens payout windows for
 * articles only. When comments arrive they must carry the same claim, because a
 * comment thread is exactly the sort of long-tail content that gets indexed on
 * somebody else's domain by default. A comment's canonical URL is its parent
 * article's page plus the comment's own permlink as a fragment, since that is
 * where a reader would actually land.
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

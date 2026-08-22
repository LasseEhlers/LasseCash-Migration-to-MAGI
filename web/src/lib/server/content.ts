/**
 * Server-side reads of the CONTENT layer.
 *
 * WHAT THIS IS FOR. Every Hive frontend ships an empty shell and paints the
 * article in with JavaScript. Google renders some of that, eventually; AI
 * crawlers largely do not; and five frontends serving the same post with no
 * canonical tag look like four copies of duplicate content. So LasseCash
 * renders articles on the server, and says which URL is the original.
 *
 * WHAT THIS IS NOT FOR. It reads TITLES, BODIES and DATES. It does not read,
 * cache or render a reward figure. Money is per-user, moves every block, and is
 * computed by the engine in the browser — putting a payout in HTML that is
 * cached for a minute would make the page lie for up to a minute. The client
 * hydrates all of that exactly as it did before, so the only thing that changed
 * is that the words arrive first.
 *
 * ⚠️ THIS RUNS IN A CLOUDFLARE WORKER. Web APIs only: `fetch`, `Request`,
 * `Response`. No `node:fs`, no `node:module`, no filesystem at request time —
 * anything from disk is imported at BUILD time (see `about`, below). And no
 * engine: `postsMeta()` exists precisely so post lists need no WASM.
 *
 * The backend is the SAME indexer the browser uses (dev chain or MAGI node),
 * chosen the same way — from VITE_CONTRACT_ID — so there is one code path and
 * no server-only view of the world to drift.
 */
import { DevBackend } from "$api/dev-backend.js";
import { MagiBackend } from "$api/magi-backend.js";
import type { Backend } from "$api/backend.js";
import type { Content, PostMeta } from "$api/types.js";
import { coverImage, excerpt } from "$lib/markdown.js";
import { bareName, postPath, postUrl } from "$lib/site.js";

/**
 * The About text, inlined at BUILD time from the one source file in `docs/`.
 *
 * Vite's `?raw` turns the file into a string constant in the bundle, which is
 * the only way an edge worker can have it — there is no filesystem to read at
 * request time. Editing `docs/ABOUT.md` and rebuilding is the whole workflow;
 * nothing is duplicated.
 */
import aboutSource from "../../../../docs/ABOUT.md?raw";

/**
 * Runtime config, `process.env` first so a deployment can be repointed without
 * a rebuild where the platform exposes it. The build-time values are the same
 * ones the browser bundle sees, so both halves of a page agree about which
 * chain they are on.
 */
function env(name: string): string {
  const runtime = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return runtime || ((import.meta.env as Record<string, string | undefined>)[name] ?? "");
}

const CONTRACT_ID = env("VITE_CONTRACT_ID");
const CHAIN_URL = env("VITE_CHAIN_URL") || "http://localhost:8080";

/** True when the server is pointed at a real MAGI node. */
export const WALLET_MODE = CONTRACT_ID !== "";

let backend: Backend | undefined;
function chain(): Backend {
  if (!backend) {
    backend = WALLET_MODE
      ? new MagiBackend({ contractId: CONTRACT_ID })
      : new DevBackend({ url: CHAIN_URL });
  }
  return backend;
}

/**
 * One article, ready to render: the words and nothing else.
 *
 * `registered` says the contract knows about it; `published` says the content
 * layer has a body. Both states are real — publishing writes the article first
 * and registers it second, so a registered post with no body is a recoverable
 * moment, not an error — and the page has to render either.
 */
export interface ArticleMeta {
  /** The chain's qualified address, e.g. `hive:lasseehlers`. */
  author: string;
  /** The display form used in URLs, e.g. `lasseehlers`. */
  handle: string;
  permlink: string;
  title: string;
  /** Raw markdown. Rendered with $lib/markdown.ts — the one renderer. */
  body: string;
  summary: string;
  tags: string[];
  cover: string | null;
  /** ISO 8601, or null when the indexer has never seen this post at all. */
  created: string | null;
  window: "viral" | "deep" | null;
  /** The chain holds a record for it. False for a tagged post awaiting its first vote. */
  registered: boolean;
  published: boolean;
  canonical: string;
  path: string;
}

/**
 * Posts the indexer can see, newest-first discovery order. Never throws.
 *
 * `postsMeta` and not `posts`: the full view asks the ENGINE for each post's
 * pending payout, and the engine is a browser-side WASM binary. Server
 * rendering must not need it and must not show money anyway.
 */
export async function listPosts(limit = 50): Promise<PostMeta[]> {
  try {
    return await chain().postsMeta(limit);
  } catch (e) {
    console.warn("[lassecash] server postsMeta() failed:", (e as Error).message);
    return [];
  }
}

/** The body of one post. Null when it was registered but never published. */
export async function getContent(
  author: string,
  permlink: string,
): Promise<Content | null> {
  try {
    return await chain().content(author, permlink);
  } catch {
    return null;
  }
}

/** Build the renderable view of a post from its content and its registration. */
export function toArticle(
  author: string,
  permlink: string,
  content: Content | null,
  post: PostMeta | null,
): ArticleMeta {
  const body = content?.body ?? "";
  const title = content?.title || post?.title || permlink;
  const summary = content?.summary?.trim() || excerpt(body, 300) || post?.summary || "";
  return {
    author,
    handle: bareName(author),
    permlink,
    title,
    body,
    summary,
    tags: content?.tags ?? post?.tags ?? [],
    cover: body ? coverImage(body) : null,
    created: post?.created_time ?? null,
    window: post?.window ?? null,
    // A post the indexer found under the `lassecash` tag but that nobody has
    // voted on yet is NOT registered — it carries no contract record. Reading
    // `post !== null` would have called it registered simply because the feed
    // knows it exists, and the page would then offer Promote and a comment box
    // for a post the chain has never heard of.
    registered: post?.registered ?? false,
    published: body.length > 0,
    canonical: postUrl(author, permlink),
    path: postPath(author, permlink),
  };
}

/**
 * Everything needed to render one article page.
 *
 * The registration lookup is a scan of the discovery list because THERE IS NO
 * POST INDEX — the contract cannot enumerate its own posts (unbounded iteration
 * does not fit in the gas budget), so both backends rediscover posts from
 * history. A real indexer-side index is the fix, not a bigger limit.
 */
export async function getArticle(
  author: string,
  permlink: string,
): Promise<ArticleMeta> {
  const [content, posts] = await Promise.all([
    getContent(author, permlink),
    listPosts(200),
  ]);
  const post = posts.find((p) => p.author === author && p.permlink === permlink) ?? null;
  return toArticle(author, permlink, content, post);
}

/**
 * Articles with their bodies attached, newest first.
 *
 * Used by the RSS feed and llms-full.txt. Bodies are fetched in PARALLEL but in
 * bounded batches: against MAGI each one is a Hive API call, and firing fifty
 * at once is how you get rate-limited by the host every Hive post already
 * depends on. It is also the heaviest thing this worker does, which is why only
 * the two discovery files use it.
 */
export async function listArticles(limit = 50, batch = 8): Promise<ArticleMeta[]> {
  const posts = await listPosts(limit);
  const out: ArticleMeta[] = [];
  for (let i = 0; i < posts.length; i += batch) {
    const slice = posts.slice(i, i + batch);
    const bodies = await Promise.all(
      slice.map((p) => getContent(p.author, p.permlink)),
    );
    slice.forEach((p, j) => out.push(toArticle(p.author, p.permlink, bodies[j], p)));
  }
  return out;
}

/**
 * The site's own About text, from the single source file in `docs/`.
 *
 * ONE FILE, not a copy pasted into a Svelte page — the same reason there is one
 * markdown renderer. `/about` renders it and `/about.md` serves it raw, so an
 * AI crawler and a human read the identical words.
 *
 * ⚠️ IT IS RENDERED WITH THE POST RENDERER, which escapes everything before
 * emitting a tag — that is the security boundary, and it does not get an
 * exception for our own file. So an HTML comment in `docs/ABOUT.md` appears on
 * the page as visible text. Keep notes-to-ourselves out of it; they belong in
 * web/README.md.
 */
export function aboutMarkdown(): string {
  return aboutSource;
}

/** Cache headers for server-rendered content. */
export const CONTENT_CACHE = "public, max-age=60, stale-while-revalidate=600";
/** Cache headers for the discovery files, which change far less often. */
export const DISCOVERY_CACHE = "public, max-age=300, stale-while-revalidate=3600";

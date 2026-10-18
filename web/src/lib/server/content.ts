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

export const CONTRACT_ID = env("VITE_CONTRACT_ID");
const CHAIN_URL = env("VITE_CHAIN_URL") || "http://localhost:8080";

/** True when the server is pointed at a real MAGI node. */
export const WALLET_MODE = CONTRACT_ID !== "";

let backend: Backend | undefined;
/** The server's one backend — shared with the market endpoints. */
export function serverBackend(): Backend { return chain(); }
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
// THE LIST IS BUILT FROM THE WHOLE CONTRACT HISTORY, which takes seconds on a
// cold worker, and the feed, the sitemap, the RSS feed, llms.txt and every post
// page all ask for it. Callers within a minute share one answer; a request that
// arrives while it is being built joins that build instead of starting another;
// and if a rebuild fails the last good list is served rather than an empty page.
const LIST_TTL_MS = 60_000;
const listCache = new Map<number, { at: number; posts: PostMeta[] }>();
const listBuilding = new Map<number, Promise<PostMeta[]>>();

// THE EDGE COPY (18 Oct 2026). A worker isolate's memory is empty after every
// cold start, and a cold build of the list takes 10-40 s when the public MAGI
// nodes are slow, so the front page and every discovery file hung or came back
// empty. Cloudflare's own cache (`caches.default`, no binding or setup) is shared
// by the isolates in a data centre: the last good list is stored there and
// served at once, while a rebuild is given a short time to replace it. It is
// ONLY the public list of posts (content, no money), and the chain stays the
// source: a stale copy is replaced on the next successful build.
const EDGE_KEY = "https://lassecash.internal/post-list-v1";
const EDGE_FRESH_MS = 60_000;
const EDGE_WAIT_MS = 2_500;

type Edge = { at: number; posts: PostMeta[] } | null;
async function edgeGet(): Promise<Edge> {
  try {
    const c = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
    const r = c ? await c.match(EDGE_KEY) : undefined;
    const j = r ? ((await r.json()) as { at?: number; posts?: PostMeta[] }) : null;
    return j && Array.isArray(j.posts) && j.posts.length ? { at: Number(j.at) || 0, posts: j.posts } : null;
  } catch { return null; }
}
async function edgePut(posts: PostMeta[]): Promise<void> {
  try {
    const c = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
    if (!c || !posts.length) return;
    await c.put(EDGE_KEY, new Response(JSON.stringify({ at: Date.now(), posts }),
      { headers: { "content-type": "application/json", "cache-control": "public, max-age=21600" } }));
  } catch { /* the copy is a convenience */ }
}

export async function listPosts(limit = 50): Promise<PostMeta[]> {
  const hit = listCache.get(limit);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.posts;
  const running = listBuilding.get(limit);
  if (running) return running;
  const edge = limit === 50 ? await edgeGet() : null;
  if (edge && Date.now() - edge.at < EDGE_FRESH_MS) return edge.posts;
  const build = (async () => {
    try {
      const posts = await chain().postsMeta(limit);
      if (posts.length) { listCache.set(limit, { at: Date.now(), posts }); if (limit === 50) void edgePut(posts); }
      return posts.length ? posts : (hit?.posts ?? edge?.posts ?? posts);
    } catch (e) {
      console.warn("[lassecash] server postsMeta() failed:", (e as Error).message);
      return hit?.posts ?? edge?.posts ?? [];
    } finally {
      listBuilding.delete(limit);
    }
  })();
  listBuilding.set(limit, build);
  // A stale copy exists: give the rebuild a moment, then answer with the copy.
  const stale = hit?.posts ?? edge?.posts;
  if (stale) {
    const late = Symbol("late");
    const r = await Promise.race([build, new Promise<typeof late>((res) => setTimeout(() => res(late), EDGE_WAIT_MS))]);
    return r === late ? stale : r;
  }
  return build;
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
    created: post?.created_time ?? content?.created ?? null,
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
  const b = chain();
  // ONE direct read when the backend offers it. The scan below is the
  // fallback (dev chain), and it is SLOW on the live one: a cold post page took
  // 1-8 s, and X's card crawler gave up, so shared posts had no thumbnail.
  const [content, post] = await Promise.all([
    getContent(author, permlink),
    b.postMeta
      ? b.postMeta(author, permlink).catch(() => null)
      : listPosts(200).then((ps) => ps.find((p) => p.author === author && p.permlink === permlink) ?? null),
  ]);
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

/**
 * Posts whose summaries state plans that have since changed. AI readers quote
 * a post's summary as fact, so the index says it is outdated and where the
 * current answer is. The posts themselves stay as written — they are history.
 */
export const OUTDATED_POSTS: Record<string, string> = {
  "lasseehlers/lassecash-went-immutable":
    "OUTDATED: the 10 October key burn was postponed; the contract is not yet immutable",
  "lasseehlers/lassecash-is-live-on-magi":
    "OUTDATED in part: the claim window runs until 29 March 2027, and the key burn has no date",
};


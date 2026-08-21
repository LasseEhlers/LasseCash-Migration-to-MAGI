/**
 * The plain-markdown view of a post: `/@author/permlink.md`.
 *
 * WHY THIS EXISTS. An HTML page is a rendering of the article; this is the
 * article. AI crawlers, scripts and anyone who wants to quote a post exactly
 * get the author's own markdown with no styling, no navigation and no chance of
 * the renderer's interpretation getting in the way. It is also what /llms.txt
 * links to, so the machine-readable index points at machine-readable text.
 *
 * The one-line header carries title, author and date, because a bare body with
 * no attribution is not much use to whoever fetched it.
 */
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getArticle, CONTENT_CACHE } from "$lib/server/content.js";
import { postUrl } from "$lib/site.js";

export const GET: RequestHandler = async ({ params }) => {
  const raw = decodeURIComponent(params.account).replace(/^@/, "");
  const author = raw.includes(":") ? raw : `hive:${raw}`;
  const permlink = decodeURIComponent(params.permlink).replace(/\.md$/, "");

  const a = await getArticle(author, permlink);
  if (!a.registered && !a.published) error(404, "no such post");

  const date = a.created ? new Date(a.created).toISOString().slice(0, 10) : "unpublished";
  const head = `# ${a.title}\n\n> by @${a.handle} · ${date} · ${postUrl(author, permlink)}\n\n`;
  const body = a.published
    ? a.body
    : "_Registered on-chain, but the body was never published to the content layer._\n";

  return new Response(head + body.replace(/\s*$/, "") + "\n", {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": CONTENT_CACHE,
    },
  });
};

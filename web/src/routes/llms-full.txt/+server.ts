/**
 * /llms-full.txt — the whole site as one markdown document.
 *
 * The About text followed by the latest posts in full. A model that fetches
 * this needs no further requests to know what LasseCash is and what people are
 * writing about on it.
 *
 * Bounded at 50 posts by the same discovery limit everything else uses. When a
 * real post index exists this should page rather than truncate silently.
 */
import type { RequestHandler } from "./$types";
import { listArticles, aboutMarkdown, DISCOVERY_CACHE } from "$lib/server/content.js";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "$lib/site.js";

export const GET: RequestHandler = async () => {
  const about = aboutMarkdown();
  const articles = await listArticles(50);

  const parts = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `Source: ${SITE_URL}`,
    "",
    "---",
    "",
    about.trim(),
    "",
    "---",
    "",
    "# Posts",
    "",
  ];

  for (const a of articles) {
    parts.push(
      `## ${a.title}`,
      "",
      `- Author: @${a.handle}`,
      ...(a.created ? [`- Published: ${a.created}`] : []),
      `- Canonical: ${a.canonical}`,
      ...(a.tags.length ? [`- Tags: ${a.tags.join(", ")}`] : []),
      "",
      a.published ? a.body.trim() : "_Registered on-chain; body not published._",
      "",
      "---",
      "",
    );
  }

  return new Response(parts.join("\n"), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": DISCOVERY_CACHE,
    },
  });
};

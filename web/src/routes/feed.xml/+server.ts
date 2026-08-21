/**
 * /feed.xml — RSS 2.0, the latest 50 posts with FULL content.
 *
 * Full bodies, not excerpts, on purpose: a reader that has to come back to the
 * site for the rest of the sentence is a reader who does not subscribe. The
 * article is public either way, and the canonical `<link>` on every item points
 * home.
 *
 * The HTML in `content:encoded` comes from the SAME renderer the page uses
 * ($lib/markdown.ts), which escapes attacker-controlled bodies before emitting
 * a single tag. A second, looser renderer for feeds is exactly the kind of
 * shortcut that turns a post body into someone else's script.
 */
import type { RequestHandler } from "./$types";
import { listArticles, DISCOVERY_CACHE } from "$lib/server/content.js";
import { renderMarkdown } from "$lib/markdown.js";
import {
  SITE_DESCRIPTION, SITE_NAME, SITE_URL, absolute, xmlEscape,
} from "$lib/site.js";

export const GET: RequestHandler = async () => {
  const articles = await listArticles(50);
  const now = new Date().toUTCString();

  const items = articles
    .map((a) => {
      const pub = a.created ? new Date(a.created).toUTCString() : now;
      const html = a.published ? renderMarkdown(a.body) : "";
      return (
        `    <item>\n` +
        `      <title>${xmlEscape(a.title)}</title>\n` +
        `      <link>${xmlEscape(a.canonical)}</link>\n` +
        `      <guid isPermaLink="true">${xmlEscape(a.canonical)}</guid>\n` +
        `      <dc:creator>${xmlEscape("@" + a.handle)}</dc:creator>\n` +
        `      <pubDate>${pub}</pubDate>\n` +
        `      <description>${xmlEscape(a.summary)}</description>\n` +
        (a.cover
          ? `      <enclosure url="${xmlEscape(absolute(a.cover))}" type="image/jpeg" />\n`
          : "") +
        a.tags.map((t) => `      <category>${xmlEscape(t)}</category>\n`).join("") +
        // CDATA, with the one sequence that could close it neutralised.
        `      <content:encoded><![CDATA[${html.replace(/]]>/g, "]]&gt;")}]]></content:encoded>\n` +
        `    </item>`
      );
    })
    .join("\n");

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `  <channel>\n` +
    `    <title>${xmlEscape(SITE_NAME)}</title>\n` +
    `    <link>${xmlEscape(SITE_URL)}/feed</link>\n` +
    `    <description>${xmlEscape(SITE_DESCRIPTION)}</description>\n` +
    `    <language>en</language>\n` +
    `    <lastBuildDate>${now}</lastBuildDate>\n` +
    `    <atom:link href="${xmlEscape(SITE_URL)}/feed.xml" rel="self" type="application/rss+xml" />\n` +
    (items ? items + "\n" : "") +
    `  </channel>\n` +
    `</rss>\n`;

  return new Response(body, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": DISCOVERY_CACHE,
    },
  });
};

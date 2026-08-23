/**
 * /sitemap.xml
 *
 * Every post at its CANONICAL URL, every author's profile, and the static
 * pages. Built from the indexer's own discovery list so it can never name a
 * post the site cannot serve.
 *
 * ⚠️ THIS DOES NOT SCALE, AND IT IS SUPPOSED TO BE OBVIOUS. There is no post
 * index: the contract cannot enumerate its own posts (unbounded iteration does
 * not fit in the gas budget), so both backends rediscover posts from recent
 * history. That caps this sitemap at whatever history reaches — fine for now,
 * useless at ten thousand posts. The fix is a real indexer-side post index, not
 * a bigger limit here. TODO when the feed outgrows discovery.
 */
import type { RequestHandler } from "./$types";
import { listPosts, DISCOVERY_CACHE } from "$lib/server/content.js";
import { SITE_URL, postUrl, profileUrl, xmlEscape } from "$lib/site.js";

interface Entry { loc: string; lastmod?: string; changefreq: string; priority: string }

export const GET: RequestHandler = async () => {
  const posts = await listPosts(200);

  const entries: Entry[] = [
    { loc: `${SITE_URL}/`, changefreq: "daily", priority: "0.8" },
    { loc: `${SITE_URL}/feed`, changefreq: "hourly", priority: "1.0" },
    { loc: `${SITE_URL}/about`, changefreq: "monthly", priority: "0.7" },
    { loc: `${SITE_URL}/chain`, changefreq: "hourly", priority: "0.6" },
    { loc: `${SITE_URL}/pool`, changefreq: "hourly", priority: "0.5" },
    // High priority while the roll call runs: people will search for this
    // rather than navigate to it, and a week is not long enough to be found
    // slowly.
    { loc: `${SITE_URL}/check`, changefreq: "daily", priority: "0.9" },
  ];

  for (const p of posts) {
    entries.push({
      loc: postUrl(p.author, p.permlink),
      lastmod: p.created_time,
      changefreq: "weekly",
      priority: "0.9",
    });
  }

  // One profile per author, deduped — a prolific author must appear once.
  for (const author of new Set(posts.map((p) => p.author))) {
    entries.push({ loc: profileUrl(author), changefreq: "daily", priority: "0.6" });
  }

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries
      .map(
        (e) =>
          `  <url>\n` +
          `    <loc>${xmlEscape(e.loc)}</loc>\n` +
          (e.lastmod ? `    <lastmod>${xmlEscape(e.lastmod)}</lastmod>\n` : "") +
          `    <changefreq>${e.changefreq}</changefreq>\n` +
          `    <priority>${e.priority}</priority>\n` +
          `  </url>`,
      )
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": DISCOVERY_CACHE,
    },
  });
};

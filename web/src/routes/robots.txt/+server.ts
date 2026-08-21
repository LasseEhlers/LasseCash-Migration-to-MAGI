/**
 * /robots.txt
 *
 * Allow everything and name the sitemap. There is nothing private here — the
 * whole point of the change this file is part of is to be READ, by search
 * engines and by AI crawlers alike.
 *
 * The money pages are excluded from indexing not here but at the page level
 * (`ssr = false`), which is the honest signal: there is genuinely nothing in
 * their HTML. A Disallow would additionally stop a crawler following links out
 * of them, which is not what we want.
 */
import type { RequestHandler } from "./$types";
import { SITE_URL } from "$lib/site.js";
import { DISCOVERY_CACHE } from "$lib/server/content.js";

export const GET: RequestHandler = () =>
  new Response(
    [
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${SITE_URL}/sitemap.xml`,
      "",
      "# Machine-readable index of this site, for AI crawlers:",
      `#   ${SITE_URL}/llms.txt`,
      `#   ${SITE_URL}/llms-full.txt`,
      "# Every article is also available as plain markdown at",
      "#   /@author/permlink.md",
      "",
    ].join("\n"),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": DISCOVERY_CACHE,
      },
    },
  );

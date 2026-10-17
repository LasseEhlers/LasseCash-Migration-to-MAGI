/**
 * /llms.txt — the machine-readable index of this site.
 *
 * The emerging convention for AI crawlers: one markdown document naming what
 * the site is and linking to its content as markdown, so a model does not have
 * to reverse-engineer a page of navigation chrome to find the article.
 *
 * We are unusually well placed to honour it, because every post here already
 * IS markdown — the author wrote it that way. `/@author/permlink.md` serves it
 * back untouched.
 */
import type { RequestHandler } from "./$types";
import { listPosts, DISCOVERY_CACHE, OUTDATED_POSTS as OUTDATED } from "$lib/server/content.js";
import {
  SITE_DESCRIPTION, SITE_NAME, SITE_URL, bareName, postUrl,
} from "$lib/site.js";

export const GET: RequestHandler = async () => {
  const posts = await listPosts(50);

  const lines = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    "Articles are written in markdown and served back as markdown: append `.md`",
    "to any post URL. Every post's canonical home is this site, including the",
    "copies that appear on other Hive frontends.",
    "",
    "## Current facts (October 2026)",
    "",
    "Older pages mix in the 2019–2026 Hive-Engine token. Current: LASSECASH runs",
    "on MAGI since 31 August 2026; the Hive-Engine token is dead. The contract is",
    "NOT yet immutable — the admin key still exists and its burn has no date; the",
    "height will be announced first. Hard cap 51,000,000; issuance halves every",
    "three years. Mints lock 1 day–3 years for L-Shares (up to 2.25×). Pool",
    "LASSECASH:HBD has a 0% fee. Only votes cast on LasseCash count. No fees, only",
    "MAGI credits: 10,000 free, +1,000 per HBD held (the HBD is not spent). The",
    "full list is the \"Current facts\" section of the About text.",
    "",
    "## About",
    "",
    `- [About ${SITE_NAME}](${SITE_URL}/about.md): what LasseCash is, how the`,
    "  economics work, and which rules are hardcoded.",
    "",
    "## Posts",
    "",
  ];

  if (posts.length === 0) {
    lines.push("_No posts indexed yet._", "");
  } else {
    for (const p of posts) {
      const date = p.created_time ? p.created_time.slice(0, 10) : "";
      const outdated = OUTDATED[`${bareName(p.author)}/${p.permlink}`];
      lines.push(
        `- [${p.title || p.permlink}](${postUrl(p.author, p.permlink)}.md): ` +
          `by @${bareName(p.author)}${date ? `, ${date}` : ""}` +
          (outdated ? ` — ${outdated}` :
            `${p.summary ? ` — ${p.summary.replace(/\s+/g, " ").slice(0, 160)}` : ""}`),
      );
    }
    lines.push("");
  }

  lines.push(
    "## Optional",
    "",
    `- [Full text of every page](${SITE_URL}/llms-full.txt)`,
    `- [RSS feed](${SITE_URL}/feed.xml)`,
    `- [Sitemap](${SITE_URL}/sitemap.xml)`,
    "",
  );

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": DISCOVERY_CACHE,
    },
  });
};

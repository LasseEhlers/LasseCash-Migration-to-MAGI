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
import { listPosts, DISCOVERY_CACHE } from "$lib/server/content.js";
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
    "## About",
    "",
    `- [About ${SITE_NAME}](${SITE_URL}/about.md): what LasseCash is, how the`,
    "  economics work, and what is immutable about them.",
    "",
    "## Posts",
    "",
  ];

  if (posts.length === 0) {
    lines.push("_No posts indexed yet._", "");
  } else {
    for (const p of posts) {
      const date = p.created_time ? p.created_time.slice(0, 10) : "";
      lines.push(
        `- [${p.title || p.permlink}](${postUrl(p.author, p.permlink)}.md): ` +
          `by @${bareName(p.author)}${date ? `, ${date}` : ""}` +
          `${p.summary ? ` — ${p.summary.replace(/\s+/g, " ").slice(0, 160)}` : ""}`,
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

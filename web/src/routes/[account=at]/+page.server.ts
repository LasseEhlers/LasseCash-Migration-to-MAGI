/**
 * Server load for a profile page: `/@name`.
 *
 * Renders the author's PUBLISHED WORK on the server — titles, dates and
 * summaries — so a profile is a real page to a crawler rather than an empty
 * container. The account's own figures (L-Shares, balance, seat) are not
 * touched here: they are money, they move every block, and they hydrate in the
 * browser out of the chain exactly as before.
 *
 * ⚠️ THERE IS NO AUTHOR INDEX. The contract cannot enumerate its own posts, so
 * this filters the newest 200 the indexer can discover — a prolific author will
 * look quieter than they are once their work falls off that list. The fix is an
 * indexer-side author index, not a bigger limit.
 */
import type { PageServerLoad } from "./$types";
import { listPosts, getContent, CONTENT_CACHE } from "$lib/server/content.js";
import { bareName, postPath } from "$lib/site.js";
import { excerpt } from "$lib/markdown.js";

export const load: PageServerLoad = async ({ params, setHeaders }) => {
  const raw = decodeURIComponent(params.account).replace(/^@/, "");
  const account = raw.includes(":") ? raw : `hive:${raw}`;

  const mine = (await listPosts(200)).filter((p) => p.author === account);

  // Bodies only for the newest handful: a summary is all the list shows, and
  // against MAGI each one is a separate Hive call.
  const withBodies = await Promise.all(
    mine.slice(0, 20).map(async (p) => {
      const c = p.summary ? null : await getContent(p.author, p.permlink);
      return {
        permlink: p.permlink,
        title: c?.title || p.title || p.permlink,
        summary: p.summary || excerpt(c?.body ?? p.body_excerpt ?? "", 200),
        created: p.created_time,
        window: p.window,
        path: postPath(p.author, p.permlink),
      };
    }),
  );

  setHeaders({ "cache-control": CONTENT_CACHE });
  return {
    account,
    handle: bareName(account),
    posts: withBodies,
    /** How many the indexer found in total, before the body cap above. */
    postCount: mine.length,
  };
};

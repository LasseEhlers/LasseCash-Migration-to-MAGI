/**
 * Server load for a post page: `/@author/permlink`.
 *
 * THIS IS THE POINT OF THE WHOLE SSR CHANGE. The title, the date and the full
 * body are in the HTML before a single byte of JavaScript runs, so a crawler —
 * search engine or AI — reads the article rather than an empty shell.
 *
 * IT RETURNS NO MONEY. Rewards, votes and the voter list are per-user and move
 * every block; they hydrate in the browser out of the engine exactly as before.
 * That is also what makes the cache header below safe: nothing in this HTML
 * goes stale in sixty seconds except the article, which does not change.
 */
import type { PageServerLoad } from "./$types";
import { getArticle, CONTENT_CACHE } from "$lib/server/content.js";

export const load: PageServerLoad = async ({ params, setHeaders }) => {
  // The URL carries the DISPLAY name; the chain uses the qualified address.
  // Anything that already names its namespace (`did:pkh:…`) passes through
  // untouched rather than being mangled into a Hive account.
  const raw = decodeURIComponent(params.account).replace(/^@/, "");
  const author = raw.includes(":") ? raw : `hive:${raw}`;

  const article = await getArticle(author, decodeURIComponent(params.permlink));

  setHeaders({ "cache-control": CONTENT_CACHE });
  return { article };
};

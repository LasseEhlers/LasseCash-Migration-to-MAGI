/**
 * Server load for the feed.
 *
 * The feed is the site's front door for a crawler: it is where every article
 * URL is discovered. Rendering the CARDS on the server — title, author, date,
 * summary, cover — means those links exist in the HTML instead of appearing
 * only after JavaScript has run.
 *
 * The reward figures on each card are NOT shown from this data. They are money,
 * they move every block, and this response is cached for a minute; the page
 * paints them once the browser has read the chain. See `hydrated` in the page.
 */
import type { PageServerLoad } from "./$types";
import { listPosts, CONTENT_CACHE } from "$lib/server/content.js";

export const load: PageServerLoad = async ({ setHeaders }) => {
  const posts = await listPosts(50);
  setHeaders({ "cache-control": CONTENT_CACHE });
  return { posts };
};

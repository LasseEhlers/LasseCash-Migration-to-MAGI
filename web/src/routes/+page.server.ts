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

/**
 * WHY A TIME LIMIT, BUT ONLY FOR NAVIGATION (found 2026-10-18).
 *
 * Clicking "Feed" in the menu is a CLIENT navigation: SvelteKit fetches this
 * load as `__data.json` and does not switch page, or light up the menu item,
 * until it answers. The list takes 0.15-0.5 s usually and ~7 s about one time
 * in five (a slow MAGI node), so Feed felt dead, sometimes needed several
 * clicks, and lit up seconds before it loaded.
 *
 * The browser reads the same posts itself right after it arrives (`live` in the
 * page), so for a navigation we answer within LIMIT_MS with whatever we have:
 * the last good list kept by this worker, or an empty one. A full DOCUMENT
 * request (a crawler, a first visit) still waits for the real list, because the
 * raw HTML is what makes every article URL discoverable.
 */
const LIMIT_MS = 1500;      // client navigation: the browser fills the list itself
const DOC_LIMIT_MS = 7000;  // full document: wait longer for crawlers, but never hang
let lastGood: Awaited<ReturnType<typeof listPosts>> | null = null;

/**
 * ⚠️ A FULL DOCUMENT MUST NEVER HANG (found 2026-10-18, while Lasse and TibFox
 * both saw the front page "loading endlessly"). After deep history reads were
 * made patient (they used to give up and return an empty list quickly), a cold
 * build of the list took 40+ s and the whole page waited for it. A visitor
 * will not wait that long, and a crawler gets nothing useful from a timeout
 * either. So the document waits DOC_LIMIT_MS, then answers with the last good
 * list or an empty one (the browser reads the posts itself right after), and the
 * short answer is not cached, so the next request tries again.
 */
export const load: PageServerLoad = async ({ setHeaders, isDataRequest }) => {
  const fresh = listPosts(50).then((p) => { if (p.length) lastGood = p; return p; });
  const late = Symbol("late");
  const limit = isDataRequest ? LIMIT_MS : DOC_LIMIT_MS;
  const r = await Promise.race([fresh, new Promise<typeof late>((res) => setTimeout(() => res(late), limit))]);
  const posts = r === late ? (lastGood ?? []) : r;
  setHeaders({ "cache-control": posts.length ? CONTENT_CACHE : "no-store" });
  return { posts };
};

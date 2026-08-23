import { redirect } from "@sveltejs/kit";
import { PRELAUNCH } from "$lib/site.js";
import type { LayoutLoad } from "./$types";

/**
 * PRE-LAUNCH GATE.
 *
 * Before the migration the only deployed contract is a THROWAWAY built with
 * `-tags testwindows`, where a "day" is six minutes. Every economic figure on
 * the app pages is therefore either fake or 240x out, and — the part that
 * actually matters — sign-in works. A visitor could connect a real wallet and
 * put real HBD into a throwaway pool whose owner key still exists and which
 * will be abandoned at genesis. That is a way for a stranger to lose money by
 * trusting the site, which is not acceptable for a week of vanity traffic.
 *
 * So until launch the site is two pages: the snapshot checker, which is the
 * whole point of the roll call, and About, which is the rules people are
 * migrating under. Everything else redirects to the checker.
 *
 * The discovery files (robots, sitemap, feed.xml, llms.txt, the .md endpoints)
 * are +server routes and are NOT affected by a layout load, so nothing that a
 * crawler already indexed starts 404ing — those pages simply have no economics
 * on them either.
 *
 * Remove the gate by deleting VITE_PRELAUNCH from the deployment environment.
 * It is env-driven and not a code edit, so the switch is the same one that
 * points the site at the production contract.
 */
const OPEN = ["/check", "/about"];

export const load: LayoutLoad = ({ url }) => {
  if (!PRELAUNCH) return {};
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (OPEN.some((o) => p === o || p.startsWith(o + "/"))) return {};
  redirect(307, "/check");   // 307, not 301: this is temporary by definition
};

/**
 * /admin is now /check.
 *
 * The migration console was never secret — its own gate said so — and the
 * figure people most want to check is the founder's share, which is exactly
 * the figure that should be easiest to find rather than hardest. So the whole
 * console moved under the public Snapshot page, and this address forwards
 * there so a bookmark, a link in a post, or a habit still lands on it.
 */
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = () => {
  redirect(301, "/check");
};

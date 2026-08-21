/**
 * The OLD post URL, kept alive as a permanent redirect.
 *
 * `/post/hive:alice/my-post` was the shape before the canonical form existed.
 * Links to it are already out there, and a dead link loses whatever authority
 * it accumulated — so it 301s to `/@alice/my-post`, which tells a crawler to
 * transfer that authority and to stop asking for the old URL.
 *
 * 301, not 302: a temporary redirect keeps both URLs indexed, which is exactly
 * the duplicate-content problem this whole change exists to fix.
 */
import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { postPath } from "$lib/site.js";

export const GET: RequestHandler = ({ params }) => {
  redirect(301, postPath(decodeURIComponent(params.author), decodeURIComponent(params.permlink)));
};

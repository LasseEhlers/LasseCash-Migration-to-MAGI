/**
 * /feed is now the site's front page.
 *
 * The feed moved to `/` because that is what a visitor should meet: the
 * writing, server-rendered, indexable — not a per-account money panel that a
 * crawler sees as a shell of empty values. Mint moved to /mint, where the
 * people who need it are sent by name.
 *
 * This redirect stays FOREVER. /feed is in the launch announcement, in the
 * sitemap Google has already read, and in whatever anyone bookmarked on day
 * one; a permanent redirect keeps every one of those links alive and passes
 * their standing to the new address. 301, not 302: the move is permanent, and
 * saying so is what transfers the ranking rather than splitting it.
 */
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = () => {
  redirect(301, "/");
};

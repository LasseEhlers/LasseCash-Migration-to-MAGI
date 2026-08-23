/**
 * /about — the short version, by default.
 *
 * The document now has two editions at /about/short and /about/full. A bare
 * /about lands on the short one: the person who typed "about" wants to know
 * what this is, not to read the rule book. 308 keeps the method and is
 * cacheable, and the short edition's own canonical tag keeps search engines
 * pointed at one URL.
 */
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const prerender = true;

export const load: PageServerLoad = () => {
  redirect(308, "/about/short");
};

/**
 * `/whitepaper` — a permanent redirect to `/about`.
 *
 * LasseCash has never had a whitepaper and is not going to write one. The word
 * has come to mean a PDF of promises published before anything exists, and
 * `/about` is the opposite of that: a description of something already built,
 * which after the key burn cannot be changed by anybody, including its author.
 *
 * The redirect exists purely because that is the word people and AI assistants
 * search for. Catching the search costs nothing; adopting the word would cost
 * the distinction.
 *
 * 301, not 302 — there is one document and one canonical URL for it, and a
 * temporary redirect would leave both indexed.
 */
import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => {
  redirect(301, "/about");
};

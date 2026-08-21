/**
 * /about.md — the About text, raw.
 *
 * The same file `/about` renders, served verbatim so a crawler or a script gets
 * the words without the page around them. `/llms.txt` links here.
 *
 * NOT prerendered, unlike `/about`. A prerendered `.md` is served by the CDN
 * with whatever content type it infers from the extension — no charset — and
 * this file will eventually carry the em dashes and typographic quotes Lasse
 * writes in. One worker invocation on a rarely-fetched URL is cheaper than a
 * mojibake About page.
 */
import type { RequestHandler } from "./$types";
import { aboutMarkdown } from "$lib/server/content.js";

export const GET: RequestHandler = () =>
  new Response(aboutMarkdown(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });

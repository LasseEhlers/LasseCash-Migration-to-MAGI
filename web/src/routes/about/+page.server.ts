/**
 * /about — rendered from `docs/ABOUT.md`, the single source of that text.
 *
 * PRERENDERED. The text changes when someone edits the file, not per request,
 * so the build bakes the page and Cloudflare serves it as a static asset — no
 * worker invocation at all.
 *
 * The file is inlined at BUILD time by Vite (`?raw`), which is also the only
 * way it could reach an edge worker: there is no filesystem at request time.
 */
import type { PageServerLoad } from "./$types";
import { aboutMarkdown } from "$lib/server/content.js";

export const prerender = true;

export const load: PageServerLoad = () => ({
  markdown: aboutMarkdown(),
});

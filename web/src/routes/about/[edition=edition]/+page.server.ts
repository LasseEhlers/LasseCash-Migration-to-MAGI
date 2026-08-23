/**
 * /about/short and /about/full — two editions of ONE document.
 *
 * The markdown is docs/ABOUT.md, unchanged: the short version is its opening
 * section, the full version is the rest. Splitting here rather than keeping
 * two files means they cannot drift, and /about.md still serves the whole
 * thing to AI readers as one text.
 *
 * Both are prerendered. The short one is the link to send a person —
 * lassecash.com/about/short — easy to say out loud, nothing to remember.
 */
import type { EntryGenerator, PageServerLoad } from "./$types";
import { aboutMarkdown } from "$lib/server/content.js";

export const prerender = true;
export const entries: EntryGenerator = () => [{ edition: "short" }, { edition: "full" }];

/** The heading that ends the short version and starts the full one. */
const SPLIT = "\n---\n\n## 1. ";

export const load: PageServerLoad = ({ params }) => {
  const md = aboutMarkdown();
  const at = md.indexOf(SPLIT);
  const short = at < 0 ? md : md.slice(0, at);
  // Keep the top-level title on the full edition so it still reads as a document.
  const full = at < 0 ? md : "# LasseCash\n" + md.slice(at + "\n---\n".length);
  return { edition: params.edition, markdown: params.edition === "short" ? short : full };
};

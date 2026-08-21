/**
 * A post permlink in the canonical URL `/@author/permlink`.
 *
 * Deliberately REFUSES anything ending in `.md`, because the same path with
 * that suffix is the plain-markdown view of the article — a sibling route with
 * its own matcher. Without this the HTML page would swallow `.md` and an AI
 * crawler asking for the raw text would get a styled page instead.
 */
export function match(param: string): boolean {
  return param.length > 0 && !param.endsWith(".md");
}

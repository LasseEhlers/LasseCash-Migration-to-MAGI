/**
 * The plain-markdown view of a post: `/@author/permlink.md`.
 *
 * A machine-readable copy of what the HTML page shows, at a URL anyone can
 * guess. Its sibling matcher (`slug`) excludes this suffix, so the two routes
 * cannot both claim a path.
 */
export function match(param: string): boolean {
  return param.length > 3 && param.endsWith(".md");
}

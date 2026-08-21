/**
 * Route matcher for profile URLs: `/@lasseehlers`.
 *
 * WHY A MATCHER AT ALL. `[account]` at the top level would swallow every
 * unknown path — a typo'd `/pooll` would render an empty profile instead of a
 * 404. Requiring the leading "@" keeps the dynamic route from competing with
 * the real pages, and matches how Hive addresses people everywhere else.
 *
 * The "@" is the DISPLAY form. The page fully qualifies it back into the
 * chain's own addressing (`hive:lasseehlers`) — and because anything already
 * carrying a namespace passes through untouched, a `did:pkh:…` account has a
 * working profile URL too.
 */
export function match(param: string): boolean {
  return param.length > 1 && param.startsWith("@");
}

/**
 * The site's identity: ONE origin, and the URLs derived from it.
 *
 * WHY THIS FILE EXISTS. A canonical URL that is hardcoded per page is a
 * canonical URL that will disagree with itself the first time the site moves,
 * and half-right canonical tags are worse than none — they tell a crawler the
 * real copy lives somewhere that does not exist. So every absolute URL in the
 * app (canonical links, OpenGraph, JSON-LD ids, the sitemap, the RSS feed, the
 * `canonical_url` written into a post's Hive metadata) is built here.
 *
 * PUBLIC_SITE_URL overrides the default, at runtime on the node server and at
 * build time for the browser bundle. Nothing else may name the origin.
 */

function configuredOrigin(): string {
  // process.env first so a deployment can move the site without a rebuild;
  // guarded because `process` does not exist in the browser bundle.
  const fromProcess =
    typeof process !== "undefined" ? process.env?.PUBLIC_SITE_URL : undefined;
  const fromBuild = import.meta.env.PUBLIC_SITE_URL as string | undefined;
  return fromProcess || fromBuild || "https://lassecash.com";
}

/** The canonical origin, never with a trailing slash. */
export const SITE_URL = configuredOrigin().replace(/\/+$/, "");

/** What the site calls itself, for OpenGraph and JSON-LD `publisher`. */
export const SITE_NAME = "LasseCash";

export const SITE_DESCRIPTION =
  "LasseCash is an anarcho-capitalist social economy: publish, earn LASSECASH " +
  "from Proof-of-Brain rewards, and time-lock it into L-Shares. Immutable " +
  "contracts on MAGI, 51,000,000 hardcap, no admin keys.";

/**
 * Strip the chain's namespace for display and for URLs.
 *
 * The chain addresses accounts as `hive:lasseehlers`; people, links and Hive
 * itself use `@lasseehlers`. A `did:pkh:…` account has no short form, so it is
 * left exactly as it is rather than mangled into a Hive name.
 */
export function bareName(account: string): string {
  return account.startsWith("hive:") ? account.slice(5) : account;
}

/** The canonical URL of a post: `https://site/@author/permlink`. */
export function postUrl(author: string, permlink: string): string {
  return `${SITE_URL}/@${bareName(author)}/${permlink}`;
}

/** The site-relative canonical path of a post. */
export function postPath(author: string, permlink: string): string {
  return `/@${bareName(author)}/${permlink}`;
}

/** The canonical URL of a profile: `https://site/@name`. */
export function profileUrl(account: string): string {
  return `${SITE_URL}/@${bareName(account)}`;
}

/** An absolute URL from a site-relative path. */
export function absolute(path: string): string {
  return path.startsWith("http") ? path : `${SITE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * A meta description: one line, no markup, at most 160 characters.
 *
 * 160 is where Google truncates; a longer one is not wrong, it is just cut in
 * the middle of a word. Truncation happens at a word boundary and adds an
 * ellipsis so a cut description still reads as a sentence.
 */
export function metaDescription(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

/**
 * Serialise a JSON-LD object for embedding in a `<script>` tag.
 *
 * The escaping is NOT decoration. JSON-LD carries post titles and author names,
 * which are attacker-controlled; a literal `</script>` inside one would end the
 * block and turn the rest of the document into markup. Escaping `<`, `>` and
 * `&` as unicode escapes keeps the JSON valid and makes that impossible.
 */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/** Escape text for inclusion in an XML document (sitemap, RSS). */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

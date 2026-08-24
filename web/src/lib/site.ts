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
 * The default share-card image — 1200x630, the standard OpenGraph size.
 *
 * Absolute, not relative: Discord, Twitter and every other unfurler fetch
 * `og:image` server-side, with no page context to resolve a relative URL
 * against. `absolute()` derives it from the same SITE_URL everything else
 * uses, so it never drifts when the site moves.
 */
export const SITE_OG_IMAGE = absolute("/og-card.png");

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

/**
 * How many heights after genesis the owner key is destroyed.
 *
 * DECIDED 2026-08-23: day 40, i.e. 40 x 28,800 = 1,152,000 heights. It was day
 * 35 until the margin was checked: a mainnet code update carries a 48-hour
 * timelock, and day 35 left the first full monthly Proof-of-Brain payout only
 * one day of room before the key was gone. Day 40 gives about a week.
 *
 * Derived from the chain's own genesis height wherever it is displayed, never
 * typed as an absolute block, so the number cannot drift from the contract.
 */
export const KEY_BURN_HEIGHTS = 40 * 28_800;

/** The MAGI node this site reads consensus facts from. */
export const MAGI_GRAPHQL =
  (import.meta.env.VITE_CHAIN_URL as string | undefined) ??
  "https://api.vsc.eco/api/v1/graphql";

/**
 * The announced snapshot block, and the moment it falls.
 *
 * PROVISIONAL until the announcement post goes out — it is an operational
 * decision, not a chain fact, and it lives here so the checker, the
 * announcement and the runbook cannot disagree about it. Computed from a live
 * head reading on 2026-08-23: head 109,264,456 at 03:36 UTC, at 3s per height.
 *
 * MOVED TWICE on 2026-08-23. Off Sunday 30 August, because Lasse does not want
 * the launch falling on a Sunday. Then off Saturday 29 August, because his own
 * first-warning post — still readable in Hive's block history, edited but never
 * erased — promised "a warning period of at least 1 week", and the 29th gave
 * six days. Monday the 31st gives eight and is not a Sunday.
 *
 * The argument for the 29th turned out to be wrong and is recorded here so it
 * is not made again: launching before 1 September does NOT buy a live test of
 * the monthly Proof-of-Brain mint. Pending balances come from post payouts and
 * the shortest payout window is seven days, so nothing can have paid out by 1
 * September whatever the genesis date. The first monthly mint carrying real
 * value is 1 October either way.
 *
 * After the snapshot is taken this becomes history rather than a deadline, and
 * the checker says so on its own by comparing against the chain height.
 */
export const SNAPSHOT_BLOCK = 109_504_918;
export const SNAPSHOT_WHEN = "Monday 31 August 2026, 12:00 UTC";

/**
 * True while the site should show only the snapshot checker and About.
 *
 * Set VITE_PRELAUNCH=1 until the production contract is live. See
 * src/routes/+layout.ts for why: the deployed contract today is a TESTWINDOWS
 * throwaway, so every economic figure is 240x out and sign-in would let a
 * stranger put real HBD into a pool that gets abandoned at genesis.
 */
export const PRELAUNCH = import.meta.env.VITE_PRELAUNCH === "1";

/**
 * /flyer — the address printed as a QR code on the paper flyers.
 *
 * It exists only so the scans can be COUNTED: Cloudflare's dashboard lists
 * requests per path, and a bare redirect leaves no database, no cookie and no
 * script behind. Each hit is one person who scanned the flyer. It stores
 * nothing and sends the visitor to the front page.
 *
 * 302, not 301: a permanent redirect is cached by browsers and would stop the
 * later scans of the same visitor being counted.
 */
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () =>
  new Response(null, { status: 302, headers: { location: "/", "cache-control": "no-store" } });

/**
 * GET /api/index/txs — the contract's transaction log, newest first.
 *
 *   ?actions=post,vote   only transactions carrying one of these calls
 *
 * Answers `{ complete, count, txs }`. `complete` is false while the first
 * backfill is still walking history; clients treat that as "not yet" and
 * read the node themselves. 503 when no D1 database is bound — the same
 * fallback, so the site works identically before and after the binding.
 *
 * Public and CORS-open like the market API: it is the chain's own log.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { WALLET_MODE } from "$lib/server/content.js";
import { D1IndexStore, syncIfStale } from "$lib/server/tx-index.js";

const HEADERS = {
  "cache-control": "public, max-age=15",
  "access-control-allow-origin": "*",
};

export const GET: RequestHandler = async ({ platform, url }) => {
  const db = platform?.env?.DB;
  if (!db || !WALLET_MODE) {
    return json({ complete: false, error: "index not configured" }, { status: 503, headers: HEADERS });
  }
  try {
    const { complete } = await syncIfStale(db);
    const actions = (url.searchParams.get("actions") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    const txs = await new D1IndexStore(db).list(actions);
    return json({ complete, count: txs.length, txs }, { headers: HEADERS });
  } catch (e) {
    // Never a hard failure for the site: clients fall back to the node.
    return json({ complete: false, error: (e as Error).message }, { status: 503, headers: HEADERS });
  }
};

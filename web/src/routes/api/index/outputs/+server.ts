/**
 * GET /api/index/outputs — every contract output, newest first.
 *
 * The second half of the index (2026-11-24): what each call RETURNED, which
 * the pool ledger joins to /api/index/txs. Answers `{ complete, count,
 * outputs }`; anything but `complete: true` sends clients back to the node,
 * exactly like the transactions endpoint.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { WALLET_MODE } from "$lib/server/content.js";
import { D1OutputStore, syncIfStale } from "$lib/server/tx-index.js";

const HEADERS = {
  "cache-control": "public, max-age=15",
  "access-control-allow-origin": "*",
};

export const GET: RequestHandler = async ({ platform }) => {
  const db = platform?.env?.DB;
  if (!db || !WALLET_MODE) {
    return json({ complete: false, error: "index not configured" }, { status: 503, headers: HEADERS });
  }
  try {
    const { outputsComplete } = await syncIfStale(db);
    const outputs = await new D1OutputStore(db).list();
    return json({ complete: outputsComplete, count: outputs.length, outputs }, { headers: HEADERS });
  } catch (e) {
    return json({ complete: false, error: (e as Error).message }, { status: 503, headers: HEADERS });
  }
};

/**
 * /api/supply                — JSON: total, circulating, max, burned, emitted, unclaimed
 * /api/supply/circulating    — the bare number, for CMC's "circulating supply URL"
 * /api/supply/total          — the bare number
 * /api/supply/max            — the bare number
 *
 * Raw state, no engine; works against the dev chain as well as MAGI.
 */
import type { RequestHandler } from "./$types";
import { marketJson, plainText, supplySnapshot } from "$lib/server/market.js";
import { fromUnits, supplyJson } from "$api/index.js";

export const GET: RequestHandler = async ({ params }) => {
  const s = await supplySnapshot();
  switch (params.field) {
    case undefined:
    case "":
      return marketJson(supplyJson(s));
    case "circulating":
      return plainText(fromUnits(s.circulating));
    case "total":
      return plainText(fromUnits(s.total));
    case "max":
      return plainText(fromUnits(s.max));
    default:
      return marketJson({ error: `unknown field ${params.field}; use circulating, total or max` }, 404);
  }
};

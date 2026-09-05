/** CoinGecko `/orderbook?ticker_id=LASSECASH_HBD` — one marginal level, see api/src/market.ts. */
import type { RequestHandler } from "./$types";
import { isOurPair, marketJson, marketSnapshot, notOurPair } from "$lib/server/market.js";
import { geckoOrderbook } from "$api/index.js";

export const GET: RequestHandler = async ({ url }) => {
  const id = url.searchParams.get("ticker_id");
  if (!isOurPair(id)) return notOurPair(id!);
  const s = await marketSnapshot();
  return marketJson(geckoOrderbook(s.replay, s.nowMs));
};

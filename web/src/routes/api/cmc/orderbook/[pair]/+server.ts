/** CoinMarketCap `orderbook/:market_pair` — one marginal level, see api/src/market.ts. */
import type { RequestHandler } from "./$types";
import { isOurPair, marketJson, marketSnapshot, notOurPair } from "$lib/server/market.js";
import { cmcOrderbook } from "$api/index.js";

export const GET: RequestHandler = async ({ params }) => {
  if (!isOurPair(params.pair)) return notOurPair(params.pair);
  const s = await marketSnapshot();
  return marketJson(cmcOrderbook(s.replay, s.nowMs));
};

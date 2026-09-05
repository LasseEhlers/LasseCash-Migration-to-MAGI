/** CoinMarketCap `trades/:market_pair`: recent completed trades, newest first. */
import type { RequestHandler } from "./$types";
import { isOurPair, marketJson, marketSnapshot, notOurPair } from "$lib/server/market.js";
import { cmcTrades } from "$api/index.js";

export const GET: RequestHandler = async ({ params }) => {
  if (!isOurPair(params.pair)) return notOurPair(params.pair);
  const s = await marketSnapshot();
  return marketJson(cmcTrades(s.replay.trades));
};

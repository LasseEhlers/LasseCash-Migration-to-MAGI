/** CoinMarketCap `ticker`: last price and 24h volume per pair, keyed by pair. */
import type { RequestHandler } from "./$types";
import { marketJson, marketSnapshot } from "$lib/server/market.js";
import { cmcTicker } from "$api/index.js";

export const GET: RequestHandler = async () => {
  const s = await marketSnapshot();
  return marketJson(cmcTicker(s.ticker));
};

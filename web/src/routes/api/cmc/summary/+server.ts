/** CoinMarketCap `summary`: every market pair's overview. */
import type { RequestHandler } from "./$types";
import { marketJson, marketSnapshot } from "$lib/server/market.js";
import { cmcSummary } from "$api/index.js";

export const GET: RequestHandler = async () => {
  const s = await marketSnapshot();
  return marketJson(cmcSummary(s.ticker));
};

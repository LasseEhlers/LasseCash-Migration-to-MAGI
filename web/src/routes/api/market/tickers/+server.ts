/** CoinGecko `/tickers`: last price, 24h volumes, bid/ask, high/low. */
import type { RequestHandler } from "./$types";
import { marketJson, marketSnapshot } from "$lib/server/market.js";
import { geckoTickers } from "$api/index.js";

export const GET: RequestHandler = async () => {
  const s = await marketSnapshot();
  return marketJson(geckoTickers(s.ticker, s.replay, s.contractId, s.reconciled));
};

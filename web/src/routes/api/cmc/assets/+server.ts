/** CoinMarketCap `assets`: the assets traded here and their identifiers. */
import type { RequestHandler } from "./$types";
import { marketJson, marketSnapshot } from "$lib/server/market.js";
import { cmcAssets } from "$api/index.js";

export const GET: RequestHandler = async () => {
  const s = await marketSnapshot();
  return marketJson(cmcAssets(s.contractId));
};

/** CoinGecko `/pairs`: the markets this venue lists. One. */
import type { RequestHandler } from "./$types";
import { marketJson, marketSnapshot } from "$lib/server/market.js";
import { geckoPairs } from "$api/index.js";

export const GET: RequestHandler = async () => {
  const s = await marketSnapshot();
  return marketJson(geckoPairs(s.contractId));
};

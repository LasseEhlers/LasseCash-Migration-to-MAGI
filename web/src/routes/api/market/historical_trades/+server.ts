/**
 * CoinGecko `/historical_trades?ticker_id=LASSECASH_HBD&type=buy|sell&limit=&start_time=&end_time=`
 * Every swap since the pool opened, newest first, split into buys and sells.
 */
import type { RequestHandler } from "./$types";
import { asMs, isOurPair, marketJson, marketSnapshot, notOurPair } from "$lib/server/market.js";
import { geckoHistoricalTrades } from "$api/index.js";

export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams;
  const id = q.get("ticker_id");
  if (!isOurPair(id)) return notOurPair(id!);
  const typeRaw = q.get("type");
  const type = typeRaw === "buy" || typeRaw === "sell" ? typeRaw : undefined;
  const limitRaw = Number(q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : undefined;
  const s = await marketSnapshot();
  return marketJson(geckoHistoricalTrades(s.replay.trades, {
    type, limit, startMs: asMs(q.get("start_time")), endMs: asMs(q.get("end_time")),
  }));
};

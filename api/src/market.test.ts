/**
 * The market view is built from the contract's own return strings, so the
 * parser and the reserve bookkeeping are what these pin: an aggregator will
 * publish whatever comes out of here, and a wrong sign on one delta would
 * put a wrong price on CoinGecko.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolLedgerEntry } from "./backend.js";
import {
  buildMarketTrades, cmcAssets, cmcOrderbook, cmcSummary, cmcTicker, cmcTrades,
  geckoHistoricalTrades, geckoOrderbook, geckoPairs, geckoTickers, HBD_UCID,
  marketTicker, parseLedgerEntry, percentChange, reconciles, reservePrice, supplyFigures,
  supplyJson, utcIso,
} from "./market.js";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01T12:00:00Z
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, ""); // node style: no zone
const H = 109_512_118;

function entry(
  i: number, action: PoolLedgerEntry["action"], payload: string, ret: string, ok = true,
  atMs = T0 + i * 3_600_000,
): PoolLedgerEntry {
  return { time: iso(atMs), height: H + i * 1200, action, payload, signer: "hive:alice", txId: `tx${i}`, ok, ret };
}

// 10,000 LC + 10.3 HBD opens the pool; then a 100 LC sell, a 0.05 HBD buy,
// one refused call, and a withdrawal of half the shares' worth.
const LEDGER: PoolLedgerEntry[] = [
  entry(0, "add_liquidity", "1000000000000|1030000000", "added 1000000000000 LC and 1030000000 HBD"),
  entry(1, "swap_lc_hbd", "10000000000|0", "swapped for 10197029 HBD"),
  entry(2, "swap_hbd_lc", "5000000|0", "swapped for 4830000000 LASSECASH"),
  entry(3, "swap_lc_hbd", "999999999999|0", "", false),
  entry(4, "remove_liquidity", "1", "withdrew 500000000000 LC and 510000000 HBD"),
];

test("every pool return string parses to the right deltas", () => {
  const [add, sell, buy, refused, remove] = LEDGER.map(parseLedgerEntry);
  assert.deepEqual(add, { type: "add", lc: 1000000000000n, hbd: 1030000000n, dLc: 1000000000000n, dHbd: 1030000000n });
  assert.deepEqual(sell, { type: "sell", lc: 10000000000n, hbd: 10197029n, dLc: 10000000000n, dHbd: -10197029n });
  assert.deepEqual(buy, { type: "buy", lc: 4830000000n, hbd: 5000000n, dLc: -4830000000n, dHbd: 5000000n });
  assert.equal(refused, null, "a refused call moved nothing");
  assert.deepEqual(remove, { type: "remove", lc: 500000000000n, hbd: 510000000n, dLc: -500000000000n, dHbd: -510000000n });
});

test("an unreadable return is skipped, never guessed", () => {
  assert.equal(parseLedgerEntry(entry(9, "swap_lc_hbd", "100|0", "swapped for 5 LASSECASH")), null, "wrong asset for the direction");
  assert.equal(parseLedgerEntry(entry(9, "add_liquidity", "1|2", "added stuff")), null);
  assert.equal(parseLedgerEntry(entry(9, "swap_hbd_lc", "abc|0", "swapped for 5 LASSECASH")), null, "non-numeric input");
});

test("the replay tracks reserves from the returns and prices them as the ratio", () => {
  const r = buildMarketTrades(LEDGER);
  assert.equal(r.skipped, 1);
  assert.equal(r.trades.length, 4);
  const [open, sell, buy, remove] = r.trades;
  assert.equal(open!.price, reservePrice(1000000000000n, 1030000000n));
  assert.equal(open!.price, 103000n, "10.3 HBD / 10,000 LC = 0.00103000");
  assert.equal(sell!.lcReserve, 1010000000000n);
  assert.equal(sell!.hbdReserve, 1030000000n - 10197029n);
  assert.equal(buy!.lcReserve, 1010000000000n - 4830000000n);
  assert.equal(buy!.hbdReserve, 1030000000n - 10197029n + 5000000n);
  assert.equal(remove!.lcReserve, r.lcReserve);
  assert.equal(r.lcReserve, 1010000000000n - 4830000000n - 500000000000n);
  assert.equal(r.hbdReserve, 1030000000n - 10197029n + 5000000n - 510000000n);
  assert.ok(sell!.price < open!.price, "selling LASSECASH into the pool lowers its price");
  assert.ok(buy!.price > sell!.price, "buying it back raises the price");
  assert.equal(open!.time, "2026-09-01T12:00:00Z");
  assert.equal(open!.timestampMs, T0);
  assert.equal(open!.tradeId, "tx0");
});

test("reconciliation is exact, both assets", () => {
  const r = buildMarketTrades(LEDGER);
  assert.equal(reconciles(r, r.lcReserve, r.hbdReserve), true);
  assert.equal(reconciles(r, r.lcReserve + 1n, r.hbdReserve), false);
  assert.equal(reconciles(r, r.lcReserve, r.hbdReserve - 1n), false);
});

test("a price needs both sides; an empty or one-sided pool prices at zero", () => {
  assert.equal(reservePrice(0n, 0n), 0n);
  assert.equal(reservePrice(100n, 0n), 0n);
  assert.equal(reservePrice(0n, 100n), 0n);
  assert.equal(buildMarketTrades([]).trades.length, 0);
});

test("the ticker counts swaps only as volume, over the last 24 hours", () => {
  const r = buildMarketTrades(LEDGER);
  // "Now" is 25.5h after the opening deposit, so the window opens at +1.5h:
  // the deposit (+0h) and the sell (+1h) fall outside it, the buy (+2h) and
  // the withdrawal (+4h) inside. The window is inclusive at its start, which
  // is why "now" is not a round 25h — a sell at exactly +1h would be in.
  const now = T0 + 25.5 * 3_600_000;
  const t = marketTicker(r.trades, now);
  assert.equal(t.lastPrice, r.trades[3]!.price);
  assert.equal(t.trades24h, 1, "only the buy is a swap inside the window");
  assert.equal(t.baseVolume24h, 4830000000n);
  assert.equal(t.quoteVolume24h, 5000000n);
  assert.equal(t.price24hAgo, r.trades[1]!.price, "the sell is the last event before the window");
  const inWindow = [r.trades[2]!.price, r.trades[3]!.price];
  assert.equal(t.high24h, inWindow.reduce((a, b) => (b > a ? b : a)));
  assert.equal(t.low24h, inWindow.reduce((a, b) => (b < a ? b : a)));
  // A window with nothing in it still has a price and no volume.
  const quiet = marketTicker(r.trades, now + 10 * 24 * 3_600_000);
  assert.equal(quiet.trades24h, 0);
  assert.equal(quiet.baseVolume24h, 0n);
  assert.equal(quiet.high24h, quiet.lastPrice);
  assert.equal(quiet.low24h, quiet.lastPrice);
});

test("percent change is integer arithmetic with a 2dp string", () => {
  assert.equal(percentChange(100n, 150n), "50.00");
  assert.equal(percentChange(100n, 50n), "-50.00");
  assert.equal(percentChange(100n, 100n), "0.00");
  assert.equal(percentChange(0n, 100n), "0.00", "no reference price, no change");
  assert.equal(percentChange(3n, 4n), "33.33");
});

test("the CoinGecko shapes carry the fields their spec names", () => {
  const r = buildMarketTrades(LEDGER);
  const now = T0 + 25 * 3_600_000;
  const t = marketTicker(r.trades, now);
  assert.deepEqual(geckoPairs("vsc1x"), [{ ticker_id: "LASSECASH_HBD", base: "LASSECASH", target: "HBD", pool_id: "vsc1x" }]);
  const [tk] = geckoTickers(t, r, "vsc1x", true);
  for (const k of ["ticker_id", "base_currency", "target_currency", "last_price", "base_volume", "target_volume", "bid", "ask", "high", "low"])
    assert.ok(k in tk!, `tickers.${k}`);
  assert.match(tk!.last_price, /^\d+\.\d{8}$/, "8-decimal string, never a float");
  assert.equal(tk!.reconciled, true);
  const ob = geckoOrderbook(r, now);
  assert.equal(ob.ticker_id, "LASSECASH_HBD");
  assert.equal(ob.bids.length, 1);
  assert.equal(ob.asks.length, 1);
  assert.equal(ob.bids[0]![0], ob.asks[0]![0], "one marginal price, both sides");
  const h = geckoHistoricalTrades(r.trades);
  assert.equal(h.buy.length, 1);
  assert.equal(h.sell.length, 1);
  assert.equal(h.sell[0]!.trade_id, "tx1");
  assert.equal(h.buy[0]!.trade_timestamp, T0 + 2 * 3_600_000);
  for (const k of ["trade_id", "price", "base_volume", "target_volume", "trade_timestamp", "type"])
    assert.ok(k in h.buy[0]!, `historical_trades.${k}`);
  assert.equal(geckoHistoricalTrades(r.trades, { type: "sell" }).buy.length, 0);
  assert.equal(geckoHistoricalTrades(r.trades, { startMs: T0 + 2 * 3_600_000 }).sell.length, 0, "start_time excludes the earlier sell");
  assert.equal(geckoHistoricalTrades(r.trades, { limit: 1 }).buy.length + geckoHistoricalTrades(r.trades, { limit: 1 }).sell.length, 1);
});

test("the CoinMarketCap shapes carry the fields their spec names", () => {
  const r = buildMarketTrades(LEDGER);
  const now = T0 + 25 * 3_600_000;
  const t = marketTicker(r.trades, now);
  const [s] = cmcSummary(t);
  for (const k of ["trading_pairs", "base_currency", "quote_currency", "last_price", "lowest_ask", "highest_bid", "base_volume", "quote_volume", "price_change_percent_24h", "highest_price_24h", "lowest_price_24h"])
    assert.ok(k in s!, `summary.${k}`);
  assert.equal(s!.trading_pairs, "LASSECASH_HBD");
  const a = cmcAssets("vsc1x");
  assert.equal(a.HBD.unified_cryptoasset_id, HBD_UCID);
  assert.equal(a.LASSECASH.unified_cryptoasset_id, null, "not listed yet — never invent an id");
  assert.equal(a.LASSECASH.contractAddress, "vsc1x");
  const tk = cmcTicker(t);
  assert.ok("LASSECASH_HBD" in tk);
  assert.equal(tk.LASSECASH_HBD.quote_id, HBD_UCID);
  assert.equal(tk.LASSECASH_HBD.isFrozen, "0");
  const ob = cmcOrderbook(r, now);
  assert.equal(ob.timestamp, now);
  assert.equal(ob.bids.length, 1);
  const tr = cmcTrades(r.trades);
  assert.equal(tr.length, 2, "swaps only");
  assert.equal(tr[0]!.trade_id, "tx2", "newest first");
  for (const k of ["trade_id", "price", "base_volume", "quote_volume", "timestamp", "type"])
    assert.ok(k in tr[0]!, `trades.${k}`);
});

test("supply figures follow the supply identity: total = migrated + emitted, burned stays inside it", () => {
  const s = supplyFigures({
    sup_migrated: "3041950197458230", // 30,419,501.97 — the whole snapshot, burn included
    sup_emitted: "12345678900000",    // 123,456.789
    "bal_hive:null": "1868880972711925", // 18,688,809.73 burned, held by null
    cfg_migtotal: "1173069224746305",
    sup_claimed: "1000000000000000",
  });
  assert.equal(s.total, 3041950197458230n + 12345678900000n);
  assert.equal(s.circulating, s.total - 1868880972711925n);
  assert.equal(s.burned, 1868880972711925n);
  assert.equal(s.unclaimedMigration, 1173069224746305n - 1000000000000000n);
  assert.equal(s.max, 51_000_000n * 100_000_000n);
  const j = supplyJson(s);
  assert.equal(j.max_supply, "51000000.00000000");
  assert.match(j.circulating_supply, /^\d+\.\d{8}$/);
  // Missing keys read as zero, never throw — a fresh contract has no sup_emitted yet.
  const fresh = supplyFigures({});
  assert.equal(fresh.total, 0n);
  assert.equal(fresh.unclaimedMigration, 0n);
});

test("node timestamps without a zone are read as UTC", () => {
  assert.equal(utcIso("2026-09-05T16:13:09"), "2026-09-05T16:13:09Z");
  assert.equal(utcIso("2026-09-05T16:13:09Z"), "2026-09-05T16:13:09Z");
  assert.equal(utcIso("2026-09-05T16:13:09+00:00"), "2026-09-05T16:13:09+00:00");
});

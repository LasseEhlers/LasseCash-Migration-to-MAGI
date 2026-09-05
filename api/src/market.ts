/**
 * LasseCash Markets — the public market-data view of the LASSECASH:HBD pool,
 * in the shapes CoinGecko and CoinMarketCap ask an exchange to publish.
 *
 * HOW THE TRADES ARE BUILT, AND WHY NOT THROUGH THE ENGINE. The Chart page
 * replays every pool call THROUGH the engine (`client.poolTrades`) — the
 * chain records a swap's input, and the engine says what it paid out. That
 * is right for the browser, which has the WASM. This module runs in a
 * Cloudflare Worker, which deliberately does not (see web/src/lib/server).
 *
 * It does not need to. Every pool call's RETURN VALUE carries the exact
 * figure the contract settled: `swapped for <out> HBD`, `swapped for <out>
 * LASSECASH`, `added <lc> LC and <hbd> HBD`, `withdrew <lc> LC and <hbd>
 * HBD` (contract/state/pool.go). Reading those is not a second
 * implementation of the pool math — it is the chain's own account of what
 * it did, which is the only source of truth CLAUDE.md recognises. The
 * replay is still CHECKED: the reserves it arrives at must equal the live
 * `amm_lc` / `amm_hbd` to the base unit, and `reconciled` says whether they
 * do. The API serves either way and says which.
 *
 * ONE DIVISION LIVES HERE, ON PURPOSE. A ticker price is the reserve ratio,
 * `hbd / lc` — the definition of a constant-product pool's marginal price,
 * not a payout formula, and the same ratio the Pool page's PRICE tile
 * already shows. It is integer arithmetic on base units (floor), never a
 * float. Nothing here computes what a trade WOULD pay: that is `SwapOut`,
 * and it stays in Go. Which is also why the order book is a single marginal
 * level rather than synthetic depth — depth at size IS the swap formula.
 *
 * Amounts: base units in, 8-decimal strings out, BigInt throughout.
 */
import { UNIT, fromUnits } from "./amount.js";
import type { PoolLedgerEntry } from "./backend.js";

export const MARKET_PAIR = {
  tickerId: "LASSECASH_HBD",
  base: "LASSECASH",
  target: "HBD",
} as const;

/** CoinMarketCap's Unified Cryptoasset ID for Hive Dollar — from its CMC page, 2026-09-05. */
export const HBD_UCID = 5375;

export interface MarketTrade {
  /** The Hive transaction id — the trade's permanent, public identifier. */
  tradeId: string;
  /** ISO 8601, UTC. */
  time: string;
  timestampMs: number;
  height: number;
  /** `buy` and `sell` are of LASSECASH. `add`/`remove` move depth, not price. */
  type: "buy" | "sell" | "add" | "remove";
  /** LASSECASH moved, base units, always positive. */
  lc: bigint;
  /** HBD moved, base units, always positive. */
  hbd: bigint;
  /** Reserves AFTER this event. */
  lcReserve: bigint;
  hbdReserve: bigint;
  /** HBD per LASSECASH after this event, 1e8-scaled; 0n before both sides exist. */
  price: bigint;
  trader: string;
}

/** The marginal price of a constant-product pool: the reserve ratio, floored. */
export function reservePrice(lc: bigint, hbd: bigint): bigint {
  if (lc <= 0n || hbd <= 0n) return 0n;
  return (hbd * UNIT) / lc;
}

const RET = {
  swapHbd: /^swapped for (\d+) HBD$/,
  swapLc: /^swapped for (\d+) LASSECASH$/,
  added: /^added (\d+) LC and (\d+) HBD$/,
  withdrew: /^withdrew (\d+) LC and (\d+) HBD$/,
};

/**
 * One ledger entry → the reserve deltas it caused, read from the contract's
 * own return value. Null when the call was refused or the return does not
 * parse, in which case it moved nothing and is skipped.
 */
export function parseLedgerEntry(e: PoolLedgerEntry): {
  type: MarketTrade["type"]; lc: bigint; hbd: bigint; dLc: bigint; dHbd: bigint;
} | null {
  if (!e.ok) return null;
  const arg0 = e.payload.split("|")[0] ?? "";
  if (!/^\d+$/.test(arg0) && (e.action === "swap_lc_hbd" || e.action === "swap_hbd_lc")) return null;
  let m: RegExpMatchArray | null;
  switch (e.action) {
    case "swap_lc_hbd":
      if (!(m = e.ret.match(RET.swapHbd))) return null;
      return { type: "sell", lc: BigInt(arg0), hbd: BigInt(m[1]!), dLc: BigInt(arg0), dHbd: -BigInt(m[1]!) };
    case "swap_hbd_lc":
      if (!(m = e.ret.match(RET.swapLc))) return null;
      return { type: "buy", lc: BigInt(m[1]!), hbd: BigInt(arg0), dLc: -BigInt(m[1]!), dHbd: BigInt(arg0) };
    case "add_liquidity":
      if (!(m = e.ret.match(RET.added))) return null;
      return { type: "add", lc: BigInt(m[1]!), hbd: BigInt(m[2]!), dLc: BigInt(m[1]!), dHbd: BigInt(m[2]!) };
    case "remove_liquidity":
      if (!(m = e.ret.match(RET.withdrew))) return null;
      return { type: "remove", lc: BigInt(m[1]!), hbd: BigInt(m[2]!), dLc: -BigInt(m[1]!), dHbd: -BigInt(m[2]!) };
    default:
      return null;
  }
}

/** The node's timestamps have no zone suffix; they are UTC. */
export function utcIso(anchorTs: string): string {
  return /[zZ]|[+-]\d\d:\d\d$/.test(anchorTs) ? anchorTs : anchorTs + "Z";
}

export interface MarketReplay {
  trades: MarketTrade[];
  lcReserve: bigint;
  hbdReserve: bigint;
  /** Ledger entries that were refused or unreadable; they moved nothing. */
  skipped: number;
}

/** Replay the ledger oldest-first, tracking reserves from the chain's own returns. */
export function buildMarketTrades(ledger: PoolLedgerEntry[]): MarketReplay {
  const trades: MarketTrade[] = [];
  let lc = 0n;
  let hbd = 0n;
  let skipped = 0;
  for (const e of ledger) {
    const p = parseLedgerEntry(e);
    if (!p) { skipped++; continue; }
    lc += p.dLc;
    hbd += p.dHbd;
    const time = utcIso(e.time);
    trades.push({
      tradeId: e.txId,
      time,
      timestampMs: Date.parse(time),
      height: e.height,
      type: p.type,
      lc: p.lc,
      hbd: p.hbd,
      lcReserve: lc,
      hbdReserve: hbd,
      price: reservePrice(lc, hbd),
      trader: e.signer,
    });
  }
  return { trades, lcReserve: lc, hbdReserve: hbd, skipped };
}

/** True when the replay lands on the live reserves to the base unit. */
export function reconciles(r: MarketReplay, liveLcUnits: bigint, liveHbdUnits: bigint): boolean {
  return r.lcReserve === liveLcUnits && r.hbdReserve === liveHbdUnits;
}

export interface MarketTicker {
  lastPrice: bigint;
  /** LASSECASH traded in the last 24h (swaps only), base units. */
  baseVolume24h: bigint;
  /** HBD traded in the last 24h (swaps only), base units. */
  quoteVolume24h: bigint;
  high24h: bigint;
  low24h: bigint;
  /** The price in force 24h ago (the last trade before the window), or 0n. */
  price24hAgo: bigint;
  trades24h: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 24-hour figures from the replay. Volume counts SWAPS only — a liquidity
 * event is not a trade — but every event moves the price line, so high/low
 * consider all of them inside the window.
 */
export function marketTicker(trades: MarketTrade[], nowMs: number): MarketTicker {
  const since = nowMs - DAY_MS;
  const last = trades[trades.length - 1];
  const lastPrice = last?.price ?? 0n;
  let baseVolume24h = 0n;
  let quoteVolume24h = 0n;
  let high24h = 0n;
  let low24h = 0n;
  let price24hAgo = 0n;
  let trades24h = 0;
  for (const t of trades) {
    if (t.timestampMs < since) {
      price24hAgo = t.price;
      continue;
    }
    if (t.price > 0n) {
      if (high24h === 0n || t.price > high24h) high24h = t.price;
      if (low24h === 0n || t.price < low24h) low24h = t.price;
    }
    if (t.type === "buy" || t.type === "sell") {
      baseVolume24h += t.lc;
      quoteVolume24h += t.hbd;
      trades24h++;
    }
  }
  if (high24h === 0n) high24h = lastPrice;
  if (low24h === 0n) low24h = lastPrice;
  return { lastPrice, baseVolume24h, quoteVolume24h, high24h, low24h, price24hAgo, trades24h };
}

/** Percent change as a 2dp string, integer arithmetic; "0.00" with no reference price. */
export function percentChange(from: bigint, to: bigint): string {
  if (from <= 0n) return "0.00";
  const bp = ((to - from) * 10_000n) / from; // basis points, floored toward zero
  const sign = bp < 0n ? "-" : "";
  const abs = bp < 0n ? -bp : bp;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

const amt = (units: bigint): string => fromUnits(units);

// --- CoinGecko shapes -------------------------------------------------------
//
// The endpoint set CoinGecko asks of an exchange: /pairs, /tickers,
// /orderbook, /historical_trades. Field names as in their integration doc.

export function geckoPairs(poolId: string) {
  return [{
    ticker_id: MARKET_PAIR.tickerId,
    base: MARKET_PAIR.base,
    target: MARKET_PAIR.target,
    pool_id: poolId,
  }];
}

export function geckoTickers(t: MarketTicker, replay: MarketReplay, poolId: string, reconciled: boolean) {
  const price = amt(t.lastPrice);
  return [{
    ticker_id: MARKET_PAIR.tickerId,
    base_currency: MARKET_PAIR.base,
    target_currency: MARKET_PAIR.target,
    last_price: price,
    base_volume: amt(t.baseVolume24h),
    target_volume: amt(t.quoteVolume24h),
    // A constant-product pool quotes one marginal price to both sides and
    // charges no fee here, so bid and ask coincide.
    bid: price,
    ask: price,
    high: amt(t.high24h),
    low: amt(t.low24h),
    pool_id: poolId,
    // HBD is a USD-pegged stablecoin; the target volume IS the USD figure to
    // within the peg. Stated as HBD rather than asserted as dollars.
    liquidity_in_hbd: amt(replay.hbdReserve * 2n),
    reconciled,
  }];
}

/**
 * ONE LEVEL, NOT SYNTHETIC DEPTH. Depth at a given size is the swap formula,
 * which lives in Go and stays there. What can be stated without it: the
 * pool will trade at the marginal price for an infinitesimal size, and its
 * whole reserve is on offer along x·y=k. Sizes are the reserves.
 */
export function geckoOrderbook(replay: MarketReplay, nowMs: number) {
  const price = amt(reservePrice(replay.lcReserve, replay.hbdReserve));
  const size = amt(replay.lcReserve);
  return {
    ticker_id: MARKET_PAIR.tickerId,
    timestamp: nowMs,
    bids: [[price, size]],
    asks: [[price, size]],
    note: "constant-product AMM (x*y=k), zero fee: one marginal level; any size executes along the curve",
  };
}

export function geckoHistoricalTrades(
  trades: MarketTrade[],
  opts: { type?: "buy" | "sell"; limit?: number; startMs?: number; endMs?: number } = {},
) {
  const rows = tradeRows(trades, opts);
  const shape = (r: (typeof rows)[number]) => ({
    trade_id: r.tradeId,
    price: amt(r.price),
    base_volume: amt(r.lc),
    target_volume: amt(r.hbd),
    trade_timestamp: r.timestampMs,
    type: r.type,
  });
  return {
    buy: rows.filter((r) => r.type === "buy").map(shape),
    sell: rows.filter((r) => r.type === "sell").map(shape),
  };
}

// --- CoinMarketCap shapes ---------------------------------------------------
//
// CMC's exchange spec: summary, assets, ticker, orderbook, trades — the same
// data, their field names.

export function cmcSummary(t: MarketTicker) {
  const price = amt(t.lastPrice);
  return [{
    trading_pairs: MARKET_PAIR.tickerId,
    base_currency: MARKET_PAIR.base,
    quote_currency: MARKET_PAIR.target,
    last_price: price,
    lowest_ask: price,
    highest_bid: price,
    base_volume: amt(t.baseVolume24h),
    quote_volume: amt(t.quoteVolume24h),
    price_change_percent_24h: percentChange(t.price24hAgo, t.lastPrice),
    highest_price_24h: amt(t.high24h),
    lowest_price_24h: amt(t.low24h),
  }];
}

export function cmcAssets(contractId: string) {
  return {
    LASSECASH: {
      name: "LasseCash",
      unified_cryptoasset_id: null,
      can_withdraw: true,
      can_deposit: true,
      min_withdraw: "0.00000001",
      contractAddress: contractId,
      note: "contract-native token on MAGI; balances live in this contract's state",
    },
    HBD: {
      name: "Hive Dollar",
      unified_cryptoasset_id: HBD_UCID,
      can_withdraw: true,
      can_deposit: true,
      min_withdraw: "0.001",
    },
  };
}

export function cmcTicker(t: MarketTicker) {
  return {
    [MARKET_PAIR.tickerId]: {
      base_id: null,
      quote_id: HBD_UCID,
      last_price: amt(t.lastPrice),
      base_volume: amt(t.baseVolume24h),
      quote_volume: amt(t.quoteVolume24h),
      isFrozen: "0",
    },
  };
}

export function cmcOrderbook(replay: MarketReplay, nowMs: number) {
  const g = geckoOrderbook(replay, nowMs);
  return { timestamp: g.timestamp, bids: g.bids, asks: g.asks, note: g.note };
}

export function cmcTrades(trades: MarketTrade[], limit = 500) {
  return tradeRows(trades, { limit }).map((r) => ({
    trade_id: r.tradeId,
    price: amt(r.price),
    base_volume: amt(r.lc),
    quote_volume: amt(r.hbd),
    timestamp: r.timestampMs,
    type: r.type,
  }));
}

// --- Supply --------------------------------------------------------------------
//
// Every listing form asks for total / circulating / max supply, and CMC wants
// a URL it can poll for the circulating figure. All of it is raw state; the
// supply identity is "sum of all holdings = migrated + emitted", and burned
// value is HELD by hive:null rather than destroyed, so circulating is what
// is held by anyone who can spend it.

/**
 * The historic hardcap — 51,000,000 LASSECASH, and no key exists that could
 * change it. Listing METADATA, not an enforced bound: the chain enforces its
 * cap in Go (`CreditMigration`, pinned by tokenomics_check.py); this figure
 * only tells an aggregator what "max supply" to print, and there is no state
 * key to read it from.
 */
export const MAX_SUPPLY_UNITS = 51_000_000n * UNIT;

export interface SupplyFigures {
  /** Held by anybody at all, hive:null included: migrated + emitted. */
  total: bigint;
  /** Total less what hive:null holds — everything a key can still move. */
  circulating: bigint;
  burned: bigint;
  emitted: bigint;
  /** Committed to the snapshot but not yet claimed by its owner. */
  unclaimedMigration: bigint;
  max: bigint;
}

export function supplyFigures(raw: Record<string, string | undefined>): SupplyFigures {
  const n = (k: string) => BigInt(raw[k] || "0");
  const migrated = n("sup_migrated");
  const emitted = n("sup_emitted");
  const burned = n("bal_hive:null");
  const total = migrated + emitted;
  const unclaimed = n("cfg_migtotal") - n("sup_claimed");
  return {
    total,
    circulating: total - burned,
    burned,
    emitted,
    unclaimedMigration: unclaimed > 0n ? unclaimed : 0n,
    max: MAX_SUPPLY_UNITS,
  };
}

export const SUPPLY_KEYS = ["sup_migrated", "sup_emitted", "bal_hive:null", "cfg_migtotal", "sup_claimed"];

export function supplyJson(s: SupplyFigures) {
  return {
    symbol: MARKET_PAIR.base,
    total_supply: amt(s.total),
    circulating_supply: amt(s.circulating),
    max_supply: amt(s.max),
    burned: amt(s.burned),
    emitted_since_genesis: amt(s.emitted),
    unclaimed_migration: amt(s.unclaimedMigration),
    note: "burned value is held by hive:null (no keys exist), so it stays inside total_supply and out of circulating_supply",
  };
}

/** Swaps only, newest first, optionally filtered — the rows both specs call "trades". */
function tradeRows(
  trades: MarketTrade[],
  opts: { type?: "buy" | "sell"; limit?: number; startMs?: number; endMs?: number },
): (MarketTrade & { type: "buy" | "sell" })[] {
  const out = trades
    .filter((t): t is MarketTrade & { type: "buy" | "sell" } => t.type === "buy" || t.type === "sell")
    .filter((t) => (opts.type ? t.type === opts.type : true))
    .filter((t) => (opts.startMs !== undefined ? t.timestampMs >= opts.startMs : true))
    .filter((t) => (opts.endMs !== undefined ? t.timestampMs <= opts.endMs : true))
    .reverse();
  return opts.limit && opts.limit > 0 ? out.slice(0, opts.limit) : out;
}

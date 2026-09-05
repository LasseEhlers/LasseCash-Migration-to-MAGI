/**
 * Server-side market data for the LASSECASH:HBD pool — the snapshot every
 * /api/market/* (CoinGecko shape) and /api/cmc/* (CoinMarketCap shape)
 * endpoint serves from.
 *
 * ⚠️ RUNS IN A CLOUDFLARE WORKER: no engine. The trades come from the
 * contract's own return values, not from replaying the pool math — see
 * api/src/market.ts for why that is the more faithful source, not a
 * shortcut. The replay is still checked against the live reserves and the
 * result is reported as `reconciled` on the ticker rather than hidden.
 *
 * One snapshot per minute, shared across every endpoint and every request:
 * a listing aggregator polls all of these on a schedule, and re-walking
 * history per request would be the unbounded work the runtime punishes.
 */
import { error } from "@sveltejs/kit";
import { CONTRACT_ID, CONTENT_CACHE, serverBackend } from "./content.js";
import {
  buildMarketTrades, marketTicker, reconciles,
  type MarketReplay, type MarketTicker,
} from "$api/index.js";

export interface MarketSnapshot {
  replay: MarketReplay;
  ticker: MarketTicker;
  reconciled: boolean;
  contractId: string;
  nowMs: number;
}

const TTL_MS = 60_000;
let cached: MarketSnapshot | undefined;
let inflight: Promise<MarketSnapshot> | undefined;

async function build(): Promise<MarketSnapshot> {
  const backend = serverBackend();
  if (!backend.poolLedger) {
    throw error(503, "market data needs a MAGI node; the dev chain keeps no contract outputs");
  }
  // Raw reads for the live reserves, NOT backend.chain(): that ranks the
  // consensus group through the engine on the way out, and there is no
  // engine in the Worker — the first live run of this module proved it.
  const [ledger, live] = await Promise.all([
    backend.poolLedger(),
    backend.state(["amm_lc", "amm_hbd"]),
  ]);
  const replay = buildMarketTrades(ledger);
  const nowMs = Date.now();
  return {
    replay,
    ticker: marketTicker(replay.trades, nowMs),
    // Reserve keys hold plain base-unit integers (the frozen public ABI encoding).
    reconciled: reconciles(replay, BigInt(live["amm_lc"] || "0"), BigInt(live["amm_hbd"] || "0")),
    contractId: CONTRACT_ID,
    nowMs,
  };
}

export async function marketSnapshot(): Promise<MarketSnapshot> {
  if (cached && Date.now() - cached.nowMs < TTL_MS) return cached;
  if (!inflight) {
    inflight = build().then(
      (s) => { cached = s; inflight = undefined; return s; },
      (e) => { inflight = undefined; throw e; },
    );
  }
  return inflight;
}

/** JSON for aggregators: cached a minute, and readable cross-origin. */
export function marketJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": CONTENT_CACHE,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** The one pair this exchange lists; accepts the id in either separator or case. */
export function isOurPair(id: string | null | undefined): boolean {
  if (!id) return true; // no filter asked for
  return id.toUpperCase().replace("-", "_") === "LASSECASH_HBD";
}

export function notOurPair(id: string): Response {
  return marketJson({ error: `unknown ticker_id ${id}; this venue lists LASSECASH_HBD only` }, 404);
}

/** A unix time in seconds or milliseconds, as the caller prefers; ms out. */
export function asMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

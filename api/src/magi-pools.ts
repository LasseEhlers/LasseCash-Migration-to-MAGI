/**
 * MAGI's own cross-chain pools — HBD:HIVE and BTC:HBD.
 *
 * NOT OURS. These are separate contracts run by MAGI, and every claim this
 * file supports says so. We read them and we build calls against them; we do
 * not own them, cannot freeze them, and do not earn from them.
 *
 * EVERYTHING HERE WAS READ OFF THE CHAIN, not from documentation, because
 * MAGI publishes no client for it. Each pool's own `init` call states its
 * assets and fee in public:
 *
 *   {"asset0":"BTC","asset1":"HBD","fee_bps":8, …}
 *   {"asset0":"HBD","asset1":"HIVE","fee_bps":8, …}
 *
 * and Altera reads reserves from `r0`/`r1` with hex encoding, which
 * reproduces the figures its own Pools tab displays, to the unit. See
 * docs/MAGI-CROSSCHAIN.md.
 */
import type { Amount } from "./amount.js";

/** Base units per whole coin, per asset. HIVE and HBD are milli; BTC is sats. */
export const ASSET_SCALE: Record<string, bigint> = {
  HBD: 1_000n,
  HIVE: 1_000n,
  BTC: 100_000_000n,
};

/** How many decimals to SHOW. Never more than the asset actually carries. */
export const ASSET_DP: Record<string, number> = { HBD: 3, HIVE: 3, BTC: 8 };

export interface MagiPool {
  /** The pool's own contract — reserves are read here. */
  contractId: string;
  /** Swaps are submitted to the ROUTER, not to the pool. */
  router: string;
  asset0: string;
  asset1: string;
  /** Fee in basis points, from the pool's own init. 8 = 0.08%. */
  feeBps: number;
}

/**
 * The pools we support. A SHORT, EXPLICIT LIST, not a discovered one: every
 * entry here is a contract we have read the init of and checked the reserve
 * order on. Discovering pools automatically would mean quoting against a
 * contract nobody looked at, which is not a thing to do with other people's
 * money.
 */
export const MAGI_POOLS: MagiPool[] = [
  {
    contractId: "vsc1BVb95YKRHAEy24XgRSaW4L6d9vB88AdwjM",
    router: "vsc1Brvi4YZHLkocYNAFd7Gf1JpsPjzNnv4i45",
    asset0: "BTC", asset1: "HBD", feeBps: 8,
  },
  {
    contractId: "vsc1BoaniA5HW56GuQy6pVdoZfMcVaaDfnC8kp",
    router: "vsc1Brvi4YZHLkocYNAFd7Gf1JpsPjzNnv4i45",
    asset0: "HBD", asset1: "HIVE", feeBps: 8,
  },
];

/**
 * Mapped assets live in their own MAPPING CONTRACT, and a swap that SPENDS
 * one needs that contract's allowance for the router — read off the chain
 * like everything else here: @lasseehlers's working BTC sell rode on an
 * `increaseAllowance` some other client had left standing, and a fresh
 * account's sell died with "allowance (0) insufficient for spend"
 * (2026-09-03). Selling a mapped asset bundles an exact-amount
 * increaseAllowance in front of the swap, in the same transaction.
 */
export const MAPPING_CONTRACTS: Record<string, string> = {
  BTC: "vsc1BdrQ6EtbQ64rq2PkPd21x4MaLnVRcJj85d",
};

/** The pool that trades this pair, either way round. */
export function poolFor(a: string, b: string): MagiPool | null {
  return MAGI_POOLS.find(
    (p) => (p.asset0 === a && p.asset1 === b) || (p.asset0 === b && p.asset1 === a),
  ) ?? null;
}

/** Every asset reachable from `from` in ONE hop. No routing across two pools. */
export function counterparts(from: string): string[] {
  const out: string[] = [];
  for (const p of MAGI_POOLS) {
    if (p.asset0 === from) out.push(p.asset1);
    else if (p.asset1 === from) out.push(p.asset0);
  }
  return out;
}

export interface MagiQuote {
  /** Base units in and out, in each asset's own scale. */
  amountInUnits: bigint;
  amountOutUnits: bigint;
  /** Decimal strings for display. */
  amountOut: Amount;
  /** Fraction, e.g. 0.0412 for 4.12%. */
  priceImpact: number;
  feeBps: number;
}

/**
 * Constant product with the pool's fee taken off the INPUT, which is how
 * every Uniswap-shaped AMM does it and what the reserves imply:
 *
 *   inAfterFee = in * (10000 - feeBps) / 10000
 *   out        = inAfterFee * reserveOut / (reserveIn + inAfterFee)
 *
 * Integer throughout and floored, so the quote can never exceed what the
 * pool would actually pay. That direction matters: a quote that rounds UP
 * produces a `min_amount_out` the pool cannot meet, and the swap is refused.
 *
 * ⚠️ This is an ESTIMATE of somebody else's pool. It is our arithmetic over
 * their published reserves, not their code — which is exactly why the call
 * carries a minimum the CHAIN enforces rather than trusting this number.
 */
export function quoteMagiSwap(
  reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: number,
  scaleOut: bigint,
): MagiQuote | null {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return null;
  const inAfterFee = (amountIn * BigInt(10_000 - feeBps)) / 10_000n;
  if (inAfterFee <= 0n) return null;
  const out = (inAfterFee * reserveOut) / (reserveIn + inAfterFee);
  if (out <= 0n) return null;

  // Impact against the pool's spot price BEFORE the trade, which is the
  // number a trader means by "price impact" — not the fee, which is separate
  // and stated separately.
  const spotOut = (inAfterFee * reserveOut) / reserveIn;
  const impact = spotOut > 0n ? Number(spotOut - out) / Number(spotOut) : 0;

  return {
    amountInUnits: amountIn,
    amountOutUnits: out,
    amountOut: unitsToDecimal(out, scaleOut),
    priceImpact: impact,
    feeBps,
  };
}

/** Base units -> a decimal string at that asset's own scale. */
export function unitsToDecimal(units: bigint, scale: bigint): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const whole = u / scale;
  const frac = (u % scale).toString().padStart(String(scale).length - 1, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** A decimal string -> base units at that asset's scale, truncating. */
export function decimalToUnits(value: string, scale: bigint): bigint {
  const dp = String(scale).length - 1;
  const [w = "0", f = ""] = value.trim().split(".");
  const frac = (f + "0".repeat(dp)).slice(0, dp);
  return BigInt(w || "0") * scale + BigInt(frac || "0");
}

/**
 * The wire amount MAGI's router wants: a plain integer string of base units.
 * HIVE and HBD are milli here, BTC is satoshis — the same scales the pools
 * report reserves in, which is what makes the quote and the call agree.
 */
export function wireAmount(units: bigint): string {
  return units.toString();
}

/** The intent that authorises the pool to draw the input asset. */
export function swapIntent(asset: string, units: bigint): unknown {
  // The intent limit is a DECIMAL string in the asset's own units, and
  // MAGI writes the token name lowercase here while the payload uses
  // uppercase. Copy the case exactly; it is not cosmetic.
  const scale = ASSET_SCALE[asset] ?? 1_000n;
  return {
    type: "transfer.allow",
    args: { token: asset.toLowerCase(), limit: unitsToDecimal(units, scale) },
  };
}

/** The router payload for a swap. */
export function swapPayload(input: {
  assetIn: string; assetOut: string;
  amountInUnits: bigint; minOutUnits: bigint; recipient: string;
}): string {
  return JSON.stringify({
    type: "swap",
    version: "1.0.0",
    asset_in: input.assetIn,
    asset_out: input.assetOut,
    amount_in: wireAmount(input.amountInUnits),
    min_amount_out: wireAmount(input.minOutUnits),
    recipient: input.recipient,
  });
}

/**
 * A MAGI address, always chain-qualified.
 *
 * MAGI addresses name their chain — `hive:alice`, `did:pkh:…` — and a bare
 * Hive name is refused outright: the first live swap died with "recipient
 * address [lasseehlers] invalid". Aioha hands us bare names, so anything
 * heading into a MAGI payload passes through here.
 */
export function qualifyAddress(account: string): string {
  const a = account.trim();
  if (!a) return a;
  return a.includes(":") ? a : `hive:${a}`;
}

/**
 * The contract that holds mapped BTC, and the key its balances live under.
 *
 * FROM THE SOURCE, not from guesswork: vsc-eco/utxo-mapping declares
 * `BalancePrefix = "a" + DirPathDelimiter` with `DirPathDelimiter = "-"`, so
 * an account's satoshi balance is at `a-<qualified account>`, stored as raw
 * bytes and therefore read with hex encoding.
 *
 * Verified 2026-09-01: a-hive:lasseehlers reads 0c17 = 3,095 sats =
 * 0.00003095 BTC, which is exactly what Altera's dashboard displays. Six key
 * shapes were guessed before this and every one returned null — the answer
 * was in a public repository the whole time. Read the contract.
 */
export const BTC_MAPPING_CONTRACT = "vsc1BdrQ6EtbQ64rq2PkPd21x4MaLnVRcJj85d";
export const MAPPED_BALANCE_PREFIX = "a-";

/**
 * Bitcoin's dust threshold in satoshis, from the mapping contract's own
 * constant (`dustThreshold = 546`). An output below it cannot be spent.
 */
export const BTC_DUST_SATS = 546n;

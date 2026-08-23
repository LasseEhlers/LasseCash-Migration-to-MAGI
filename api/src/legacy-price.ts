/**
 * The dollar value of a LASSECASH holding, from where the token trades TODAY.
 *
 * WHY HIVE-ENGINE AND NOT THE MAGI POOL. During the roll call there is no MAGI
 * pool at all, and after genesis it is a ~30 HBD pool whose price moves on one
 * trade. The only venue with a history is the SWAP.HIVE:LASSECASH Diesel pool
 * on Hive-Engine, so that is the quote — converted through HIVE/USD.
 *
 * WHY IT IS LABELLED AN ESTIMATE AND SHOWN ONLY AS ONE. It multiplies two
 * third-party spot prices, neither of which the chain knows. It is never
 * written to HTML, never cached server-side, never used for anything but a
 * figure next to a balance — the golden rule: the frontend computes nothing the
 * chain settles. A holding's LASSECASH amount is exact; its dollar value is a
 * guess that can be off by a third between one week and the next (measured:
 * $0.00103 on 20 Aug, $0.00067 on 23 Aug).
 *
 * ARITHMETIC. Base units are a BigInt; prices arrive as decimal strings. The
 * price is scaled to an integer micro-dollar-per-LASSECASH figure first, so the
 * only floating-point step is the final display, and a 7-million-LASSECASH
 * holding never passes through a float as base units.
 */

/** Two prices, each with where it came from, so the page can say so. */
export type LegacyQuote = {
  /** USD per one LASSECASH, as a decimal string, 8 places. */
  usdPerLc: string;
  /** SWAP.HIVE per one LASSECASH from the Diesel pool. */
  hivePerLc: string;
  /** USD per HIVE. */
  usdPerHive: string;
  fetchedAt: number;
};

const HE_RPC = "https://api.hive-engine.com/rpc/contracts";
const CG = "https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd";

/** Parse a decimal string to an integer scaled by 10^places, truncating. */
export function scaled(dec: string, places: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(dec.trim());
  if (!m) throw new Error(`not a decimal: ${dec}`);
  const frac = (m[2] ?? "").slice(0, places).padEnd(places, "0");
  return BigInt(m[1]!) * 10n ** BigInt(places) + BigInt(frac);
}

/** Integer × integer → decimal string with `places` decimals. */
function toDecimal(v: bigint, places: number): string {
  const s = v.toString().padStart(places + 1, "0");
  return `${s.slice(0, -places)}.${s.slice(-places)}`;
}

/**
 * USD value of `baseUnits` LASSECASH at `usdPerLc`, to cents, truncated.
 *
 * Pure and testable. Everything is integer until the last division, and the
 * price keeps ALL EIGHT of its decimal places. The first version scaled the
 * price to six (micro-dollars), which for a $0.00067187 token discards two of
 * its five significant digits and under-reported @tibfox by 46 cents — caught
 * by the test, whose expected value came from independent arithmetic.
 *
 *   cents = baseUnits × usdPerLc(1e-8 $/LC) / 10^8 / 10^6
 */
export function usdValue(baseUnits: bigint, usdPerLc: string): string {
  const price = scaled(usdPerLc, 8);          // 1e-8 dollars per LASSECASH
  const cents = (baseUnits * price) / (10n ** 8n * 10n ** 6n);
  return toDecimal(cents, 2);
}

/** Fetch both prices. Throws on any failure; the page decides what to show. */
export async function fetchLegacyQuote(): Promise<LegacyQuote> {
  const [pool, cg] = await Promise.all([
    fetch(HE_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "find", params: {
        contract: "marketpools", table: "pools",
        query: { tokenPair: "SWAP.HIVE:LASSECASH" }, limit: 1 } }),
    }).then((r) => r.json()),
    fetch(CG).then((r) => r.json()),
  ]);
  const hivePerLc: string | undefined = pool?.result?.[0]?.quotePrice;
  const usdPerHive: number | undefined = cg?.hive?.usd;
  if (!hivePerLc || typeof usdPerHive !== "number" || !(usdPerHive > 0)) {
    throw new Error("price unavailable");
  }
  // usd/LC = hive/LC × usd/hive. 8-place × 8-place → 16 places → back to 8.
  const usdPerLc = toDecimal(
    (scaled(hivePerLc, 8) * scaled(usdPerHive.toFixed(8), 8)) / 10n ** 8n, 8);
  return { usdPerLc, hivePerLc, usdPerHive: usdPerHive.toFixed(8), fetchedAt: Date.now() };
}

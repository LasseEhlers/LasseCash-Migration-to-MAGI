/**
 * LASSECASH amount handling.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: an amount is NEVER a JavaScript
 * `number`.
 *
 * LASSECASH has 8 decimals, so the 51,000,000 hardcap is 5,100,000,000,000,000
 * base units. `Number.MAX_SAFE_INTEGER` is 9,007,199,254,740,991 — about
 * 90,071,992 LC — so a BALANCE does fit today, with roughly 1.77x of headroom.
 *
 * That headroom is not a reason to use floats, for two reasons:
 *
 *   1. Products leave the safe range immediately. Any amount multiplied by a
 *      1e8-scaled multiplier — which is how every rate, bonus and share is
 *      expressed — is ~1e23 and hopelessly imprecise as a double.
 *   2. `parseFloat("0.1") + parseFloat("0.2")` is 0.30000000000000004. Decimal
 *      fractions are not exactly representable in binary at all, so even small
 *      amounts drift the moment they are summed.
 *
 * A frontend that parsed these as floats would display balances that disagree
 * with the chain. So amounts cross the wire as decimal strings, are compared as
 *
 * BigInt, and are formatted as strings. There is no path where a float touches
 * one.
 *
 * NOTE ON SCOPE: nothing here derives economics. Converting and formatting an
 * amount the chain already computed is presentation. Working out a payout, a
 * multiplier or a yield is not — that belongs in the engine, and reaches the
 * frontend through a quote endpoint.
 */

/** A LASSECASH amount as a fixed 8-decimal string, e.g. "1234.56780000". */
export type Amount = string;

/** Base units in one LASSECASH. */
export const UNIT = 100_000_000n;

/** Decimal places. Matches the legacy Hive-Engine token; not negotiable. */
export const DECIMALS = 8;

/** Parse a decimal amount string into base units. Throws on malformed input. */
export function toUnits(amount: Amount): bigint {
  const s = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`not a valid amount: ${JSON.stringify(amount)}`);
  }
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [whole = "0", frac = ""] = body.split(".");
  // Pad or truncate to exactly DECIMALS. Truncation floors, matching the
  // chain — rounding up here could show a balance the chain will not pay.
  const padded = (frac + "0".repeat(DECIMALS)).slice(0, DECIMALS);
  const units = BigInt(whole) * UNIT + BigInt(padded);
  return neg ? -units : units;
}

/** Render base units as a fixed 8-decimal string. */
export function fromUnits(units: bigint): Amount {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const whole = v / UNIT;
  const frac = v % UNIT;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(DECIMALS, "0")}`;
}

/** Normalise any amount string to the canonical 8-decimal form. */
export function normalize(amount: Amount): Amount {
  return fromUnits(toUnits(amount));
}

/** Compare two amounts. Returns -1, 0 or 1. */
export function compare(a: Amount, b: Amount): -1 | 0 | 1 {
  const x = toUnits(a);
  const y = toUnits(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isZero(a: Amount): boolean { return toUnits(a) === 0n; }
export function isPositive(a: Amount): boolean { return toUnits(a) > 0n; }

/** Add amounts exactly. Presentation-layer summing only (e.g. a portfolio total). */
export function add(...amounts: Amount[]): Amount {
  return fromUnits(amounts.reduce((acc, a) => acc + toUnits(a), 0n));
}

/** Subtract b from a exactly. */
export function subtract(a: Amount, b: Amount): Amount {
  return fromUnits(toUnits(a) - toUnits(b));
}

/**
 * Format an amount for display.
 *
 * `decimals` trims trailing precision FOR DISPLAY ONLY — never feed the result
 * back into a transaction. Grouping uses the locale's thousands separator.
 */
export function format(
  amount: Amount,
  opts: { decimals?: number; group?: boolean; locale?: string } = {},
): string {
  const { decimals = 3, group = true, locale = "en-US" } = opts;
  const units = toUnits(amount);
  const neg = units < 0n;
  const v = neg ? -units : units;

  const whole = (v / UNIT).toString();
  const frac = (v % UNIT).toString().padStart(DECIMALS, "0").slice(0, decimals);

  const wholeOut = group
    ? Number(whole).toLocaleString(locale, { maximumFractionDigits: 0 })
    : whole;
  return `${neg ? "-" : ""}${wholeOut}${decimals > 0 ? "." + frac : ""}`;
}

/**
 * Convert a user's typed input into the base-unit string an entrypoint expects.
 *
 * Entrypoint arguments are base units, so this is the single conversion point
 * between what a person types and what the chain receives. Rejects anything
 * malformed rather than guessing — a silently misparsed amount is a wrong
 * transaction.
 */
export function toBaseUnitArg(input: string): string {
  const units = toUnits(input);
  if (units < 0n) throw new Error("amount cannot be negative");
  return units.toString();
}

/** A multiplier the chain computed, e.g. "2.25000000" -> "2.25x". */
export function formatMultiplier(m: Amount, decimals = 2): string {
  return `${format(m, { decimals, group: false })}x`;
}

/** A percentage the chain computed, e.g. "0.34854368" -> "0.35%". */
export function formatPercent(p: Amount, decimals = 2): string {
  return `${format(p, { decimals, group: false })}%`;
}

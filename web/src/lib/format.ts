/**
 * Display helpers.
 *
 * PRESENTATION ONLY. Nothing here derives an economic value — it renders what
 * the chain or the engine already decided. See CLAUDE.md, golden rule.
 */
import { format, fromUnits, type Amount } from "$api/index.js";

/**
 * A figure for display: grouped, 3 decimals by default.
 *
 * HOW MANY DECIMALS — the rule, because it drifted once already.
 *
 *   AMOUNTS of HBD get THREE. That is not a preference, it is all that exists:
 *   Hive holds HBD as "1.098 HBD" and MAGI moves it in milli-units. Our own
 *   contract settles it — HbdPayMilli rounds DOWN to whole milli, so a payout
 *   the engine computes as 0.107721 pays 0.107 and the rest stays in custody as
 *   dust. And because this function TRUNCATES, three decimals show exactly what
 *   was paid.
 *
 *   AMOUNTS of LASSECASH get THREE by default. The ledger has eight, and the
 *   chain always settles to the base unit — but the eighth decimal is worth
 *   about 0.00000000005 HBD today, so showing it would be noise pretending to
 *   be precision. This is a display choice and reversible; the eight-decimal
 *   figures belong where a number is a PROOF rather than a price: the snapshot,
 *   the claim page, anything that must reconcile to the base unit.
 *
 *   PRICES AND RATES keep more. "HBD per LASSECASH" is a ratio, not something
 *   anyone can hold, and it is genuinely sub-milli — 0.005144 is a real figure
 *   where 0.005144 HBD is not.
 */
export function lc(amount: Amount, decimals?: number): string {
  return format(amount, { decimals: decimals ?? autoDecimals(amount) });
}

/**
 * Decimals by MAGNITUDE, which is the rule that survives the price moving.
 *
 * A whole LASSECASH is worth about half a cent today, so three decimals on a
 * five-figure amount is a sub-half-cent tail nobody reads — while three on a
 * 4.3/day yield is the whole figure. The asset is not what decides it; the
 * size is.
 *
 *     >= 1,000   none      11,700
 *     >= 100     one       983.5
 *     >= 10      two       48.90
 *     below      three     4.300
 *
 * Pass an explicit count to override, and two kinds of figure always should:
 * PRICES, which are ratios and genuinely sub-milli, and PROOFS — the snapshot,
 * the claim page, anything that has to reconcile to the base unit.
 */
export function autoDecimals(amount: Amount): number {
  const n = Math.abs(Number(amount));
  if (!Number.isFinite(n)) return 3;
  if (n >= 1000) return 0;
  if (n >= 100) return 1;
  if (n >= 10) return 2;
  return 3;
}

/** A short form for headline figures. */
export function lcShort(amount: Amount): string {
  const whole = Number(amount.split(".")[0] ?? "0");
  if (Math.abs(whole) >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M`;
  if (Math.abs(whole) >= 1_000) return `${(whole / 1_000).toFixed(1)}k`;
  return format(amount, { decimals: 2 });
}

/**
 * Vote weight (rshares) for display.
 *
 * rshares are stored in the SAME 1e8 base units as L-Shares — a vote is the
 * voter's shares multiplied by the power it spent — so showing them at that
 * scale makes a vote directly comparable to the stake that cast it, instead of
 * a fourteen-digit integer nobody can read.
 *
 * Rescaling is presentation, exactly like rendering any other base-unit value.
 * It is NOT a LASSECASH amount and must never be labelled as one.
 */
export function rshares(raw: string): string {
  return format(fromUnits(BigInt(raw)), { decimals: 3 });
}

/** A multiplier the engine computed: "2.25000000" -> "2.25x". */
export function mult(m: Amount): string {
  return `${format(m, { decimals: 2, group: false })}x`;
}

/** A percentage the engine computed. */
export function pct(p: Amount, decimals = 2): string {
  return `${format(p, { decimals, group: false })}%`;
}

/** A fraction the engine computed (1.0 = 100%), rendered as a percentage. */
export function fractionPct(f: Amount, decimals = 1): string {
  const n = Number(f) * 100;
  return `${n.toFixed(decimals)}%`;
}

/** Heights to a human duration. Heights are 3 seconds. */
export function heightsToDuration(heights: number): string {
  if (heights <= 0) return "now";
  const days = Math.floor(heights / 28_800);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const rem = days % 365;
    return rem > 30 ? `${years}y ${Math.floor(rem / 30)}mo` : `${years}y`;
  }
  if (days >= 1) return `${days}d`;
  const hours = Math.floor((heights % 28_800) / 1_200);
  return hours >= 1 ? `${hours}h` : `${Math.floor((heights % 1_200) / 20)}m`;
}

/**
 * Duration in words — "29 days", "3 years 2 months", "5 hours". Use this
 * wherever the text is uppercased or set in monospace: the compact "29d"
 * renders as "29D", which reads as 290 (Lasse, 2026-08-21).
 */
export function durationWords(heights: number): string {
  if (heights <= 0) return "now";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const days = Math.floor(heights / 28_800);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const months = Math.floor((days % 365) / 30);
    return months >= 1 ? `${plural(years, "year")} ${plural(months, "month")}` : plural(years, "year");
  }
  if (days >= 1) return plural(days, "day");
  const hours = Math.floor((heights % 28_800) / 1_200);
  if (hours >= 1) return plural(hours, "hour");
  return plural(Math.floor((heights % 1_200) / 20), "minute");
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** Strip the "hive:" prefix for display. */
export function displayName(account: string): string {
  return account.replace(/^hive:/, "@");
}

/**
 * The life of one mint or one pool position, from the chain's own record.
 *
 * A FINISHED position is a settled fact: what went in, what came out, when.
 * Those figures never change, which is why a card per position can be shared
 * and still be true in ten years. An OPEN position's figures are the engine's
 * live reading and are labelled as such by the page.
 *
 * WHERE EACH FIGURE COMES FROM — nothing is re-derived here:
 *   principal, shares, term, start  the mint / tranche record in state
 *   what was paid out               the contract's RETURN VALUE for the claim
 *                                   ("claimed <n>", "withdrew <lc> … <hbd> HBD")
 *   when                            the transaction's anchor height and time
 *   HBD value at a moment           engine.lcToHbd at the reserves the last
 *                                   trade before that height left behind
 *
 * The only arithmetic is presentation: a difference of two settled amounts
 * (the yield) and its ratio to the principal. An annualised figure is that
 * ratio scaled to a year and is labelled "annualised, not a forecast".
 */
import type { Amount } from "./amount.js";
import { fromUnits, toUnits } from "./amount.js";
import type { PoolTrade } from "./types.js";

/** One contract call by the account, with what the contract answered. */
export interface AccountCall {
  txId: string;
  height: number;
  time: string;
  action: string;
  payload: string;
  ok: boolean;
  /** The contract's return text; "" when it refused or the output is missing. */
  ret: string;
}

/** Heights per day: 3-second Hive blocks. */
export const HEIGHTS_PER_DAY = 28_800;

/**
 * Below this many days a result is NOT scaled to a year. Four days stretched
 * to 365 is a number nobody should act on; the period result is shown alone.
 */
export const MIN_YEAR_DAYS = 7;

const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? BigInt(s) : null);

/** "claimed 2623037768764" (optionally followed by " liquid") -> units. */
export function parseClaimed(ret: string): bigint | null {
  const m = /^claimed (\d+)/.exec(ret);
  return m ? num(m[1]) : null;
}

/** "added|withdrew <lc> LASSECASH|LC and <hbd> HBD" -> both, in units. */
export function parseLiquidity(ret: string): { lc: bigint; hbd: bigint } | null {
  const m = /^(?:added|withdrew) (\d+) (?:LASSECASH|LC) and (\d+) HBD/.exec(ret);
  if (!m) return null;
  const lc = num(m[1]); const hbd = num(m[2]);
  return lc !== null && hbd !== null ? { lc, hbd } : null;
}

/**
 * The pool's reserves as the last trade at or before `height` left them, or
 * null before the pool existed. `trades` may be in any order.
 */
export function reservesAt(trades: PoolTrade[], height: number): { lc: string; hbd: string } | null {
  let best: PoolTrade | null = null;
  for (const t of trades) {
    if (t.height <= height && (!best || t.height >= best.height)) best = t;
  }
  return best ? { lc: best.lcReserve, hbd: best.hbdReserve } : null;
}

export interface MintStory {
  id: number;
  /** "migration": created at genesis from Hive-Engine stake. "capital": a mint
   *  call. "earnings": the monthly mint of post and curation rewards. */
  origin: "migration" | "capital" | "earnings";
  principal: Amount;
  shares: Amount;
  days: number;
  startHeight: number;
  startTxId: string | null;
  startTime: string | null;
  ended: boolean;
  /** Present once claimed by its owner; a sweep leaves these null. */
  claimTxId: string | null;
  claimHeight: number | null;
  claimTime: string | null;
  paidOut: Amount | null;
  /** paidOut − principal; negative for an early end. */
  gain: Amount | null;
  /** gain / principal, percent, 2 dp — presentation of two settled amounts. */
  gainPct: number | null;
  /** gainPct scaled to 365 days of holding. Not a forecast. */
  annualisedPct: number | null;
  /** The gain scaled to 365 days, in LASSECASH, floored. Same scaling, as an amount. */
  annualisedGain: Amount | null;
  heldDays: number | null;
  endedEarly: boolean;
}

/** One mint's story. `rec` is the raw state record, `calls` the owner's calls. */
export function mintStory(
  id: number, rec: string, calls: AccountCall[], genesisHeight: number,
): MintStory | null {
  const f = rec.split("|");
  if (f.length < 6) return null;
  const principal = BigInt(f[0] || "0");
  const startHeight = Number(f[2] || 0);
  const days = Number(f[3] || 0);
  const ended = f[5] === "1";

  const origin: MintStory["origin"] = startHeight === genesisHeight
    ? "migration"
    : calls.some((c) => c.ok && c.action === "mint" && c.height === startHeight) ? "capital" : "earnings";
  const start = origin === "migration"
    ? calls.find((c) => c.ok && c.action === "claim_migration") ?? null
    : calls.find((c) => c.ok && c.height === startHeight
        && (origin === "capital" ? c.action === "mint" : true)) ?? null;

  const claim = calls.find((c) => c.ok && c.action === "claim_mint"
    && c.payload.split("|")[0] === String(id) && parseClaimed(c.ret) !== null) ?? null;
  const paid = claim ? parseClaimed(claim.ret) : null;
  const gain = paid !== null ? paid - principal : null;
  const heldDays = claim ? (claim.height - startHeight) / HEIGHTS_PER_DAY : null;
  const gainPct = gain !== null && principal > 0n ? Number((gain * 1_000_000n) / principal) / 10_000 : null;
  const annualisedPct = gainPct !== null && heldDays && heldDays >= MIN_YEAR_DAYS
    ? Math.round((gainPct * 365 / heldDays) * 100) / 100 : null;

  const heldHeights = claim ? BigInt(claim.height - startHeight) : 0n;
  const annualisedGain = gain !== null && heldHeights >= BigInt(MIN_YEAR_DAYS * HEIGHTS_PER_DAY)
    ? fromUnits((gain * BigInt(365 * HEIGHTS_PER_DAY)) / heldHeights) : null;

  return {
    id, origin,
    principal: fromUnits(principal),
    shares: fromUnits(BigInt(f[1] || "0")),
    days, startHeight,
    startTxId: start?.txId ?? null,
    startTime: start?.time ?? null,
    ended,
    claimTxId: claim?.txId ?? null,
    claimHeight: claim?.height ?? null,
    claimTime: claim?.time ?? null,
    paidOut: paid !== null ? fromUnits(paid) : null,
    gain: gain !== null ? fromUnits(gain) : null,
    gainPct, annualisedPct, annualisedGain,
    heldDays: heldDays !== null ? Math.round(heldDays * 10) / 10 : null,
    endedEarly: claim !== null && claim.height < startHeight + days * HEIGHTS_PER_DAY,
  };
}

export interface TrancheStory {
  id: number;
  depositTxId: string | null;
  depositHeight: number | null;
  depositTime: string | null;
  depositLc: Amount | null;
  depositHbd: Amount | null;
  /** Every reward claim, oldest first. */
  claims: { txId: string; height: number; time: string; amount: Amount }[];
  claimedTotal: Amount;
  withdrawTxId: string | null;
  withdrawHeight: number | null;
  withdrawTime: string | null;
  withdrawLc: Amount | null;
  withdrawHbd: Amount | null;
}

/**
 * One pool position's story. Tranche ids are per-owner and sequential over
 * SUCCESSFUL `add_liquidity` calls (a refused call aborts and assigns nothing),
 * so the n-th successful deposit opened tranche n.
 */
export function trancheStory(id: number, calls: AccountCall[]): TrancheStory {
  const byAge = [...calls].sort((a, b) => a.height - b.height);
  const deposits = byAge.filter((c) => c.ok && c.action === "add_liquidity");
  const dep = deposits[id - 1] ?? null;
  const depAmt = dep ? parseLiquidity(dep.ret) : null;
  const mine = (c: AccountCall) => c.payload.split("|")[0] === String(id);
  const claims = byAge
    .filter((c) => c.ok && c.action === "claim_pool" && mine(c))
    .map((c) => ({ c, v: parseClaimed(c.ret) }))
    .filter((x) => x.v !== null)
    .map(({ c, v }) => ({ txId: c.txId, height: c.height, time: c.time, amount: fromUnits(v!) }));
  const w = byAge.find((c) => c.ok && c.action === "remove_liquidity" && mine(c)) ?? null;
  const wAmt = w ? parseLiquidity(w.ret) : null;
  return {
    id,
    depositTxId: dep?.txId ?? null,
    depositHeight: dep?.height ?? null,
    depositTime: dep?.time ?? null,
    depositLc: depAmt ? fromUnits(depAmt.lc) : null,
    depositHbd: depAmt ? fromUnits(depAmt.hbd) : null,
    claims,
    claimedTotal: fromUnits(claims.reduce((t, c) => t + toUnits(c.amount), 0n)),
    withdrawTxId: w?.txId ?? null,
    withdrawHeight: w?.height ?? null,
    withdrawTime: w?.time ?? null,
    withdrawLc: wAmt ? fromUnits(wAmt.lc) : null,
    withdrawHbd: wAmt ? fromUnits(wAmt.hbd) : null,
  };
}

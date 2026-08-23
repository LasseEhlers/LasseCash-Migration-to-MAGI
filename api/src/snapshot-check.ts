/**
 * The two rules the snapshot checker page needs, extracted so they can be
 * TESTED. Both of them shipped broken on 2026-08-23 and Lasse found them by
 * looking at the page, which is not a control.
 *
 * BUG 1 — units. The status shards store BASE UNITS ("52720116326256") while
 * `lc()` takes a decimal Amount ("527201.16326256"). Passing one to the other
 * showed @tibfox holding 52,720,116,326,256 LASSECASH — a hundred million
 * times his real balance, on the page people are told to trust.
 *
 * BUG 2 — authorship. The first version counted any `tokens_*` row as
 * something the account signed. Hive-Engine lists every entry where the
 * account is EITHER side, so tribe payouts sent TO someone read as operations
 * BY them. @tibfox's last six rows are all `from=lassecash to=tibfox`; the page
 * told him he had signed all of them, which is the precise bug that was fixed
 * in tools/snapshot/fetch.py the day before and then reintroduced here.
 */

/** One row of an account's Hive-Engine LASSECASH history. */
export type HeOp = {
  timestamp: number;
  operation: string;
  quantity: string;
  transactionId: string;
  from?: string;
  to?: string;
};

/** Operations only the token owner can start; they carry no from/to. */
const SELF_INITIATED = new Set(["tokens_unstakeStart", "tokens_undelegateStart"]);
/** The automatic, unsigned completion of the above — fires on a timer. */
const AUTOMATIC = new Set(["tokens_unstakeDone", "tokens_undelegateDone"]);

/**
 * Did `account` initiate this operation?
 *
 * Mirrors `he_authorized_by` in tools/snapshot/fetch.py and must keep
 * mirroring it. Fails CLOSED: an operation with no `from` that is not a known
 * self-initiated type counts as not signed.
 */
export function selfSigned(o: HeOp, account: string): boolean {
  if (AUTOMATIC.has(o.operation)) return false;
  if (o.from != null) return o.from === account;
  return SELF_INITIATED.has(o.operation);
}

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Which shard file a name lives in.
 *
 * Mirrors migtree.Shard in Go and shard_of() in build_status.py — one lookup
 * rule across the proof shards and the status shards.
 */
export function shardOf(name: string): string {
  let out = "";
  for (let i = 0; i < 2; i++) {
    const c = name[i] ?? "";
    out += (i === 0 ? ALNUM : ALNUM + ".-").includes(c) ? c : "_";
  }
  return out;
}

/** Normalise what a person types: `@Name`, ` name `, `NAME` all reach `name`. */
export function cleanName(s: string): string {
  return s.trim().toLowerCase().replace(/^@+/, "");
}

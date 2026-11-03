/**
 * Which rows of "Recent activity" are worth showing.
 *
 * A swap or a deposit on MAGI is two calls in one signed transaction: first
 * `increaseAllowance` (let the contract draw exactly this much), then the call
 * itself, which consumes it. When the second one CONFIRMED the first is just
 * plumbing, and listing "Allowed MAGI's swap contract to draw 1,000 LASSECASH"
 * above every "Swapped 1,000 LASSECASH" says the same thing twice.
 *
 * It is kept in two cases, because there it is information, not noise:
 *   - the transaction FAILED or is still pending — an allowance that was granted
 *     and never consumed stays open on the token, and the person should see it;
 *   - it stands alone (a bare allowance with no sibling call).
 */
import type { AccountOp } from "./backend.js";

export function hideSpentAllowances(ops: AccountOp[]): AccountOp[] {
  const consumed = new Set<string>();
  for (const o of ops) {
    if (o.action !== "increaseAllowance" && o.status === "confirmed") consumed.add(o.id);
  }
  return ops.filter((o) => !(o.action === "increaseAllowance" && o.status === "confirmed" && consumed.has(o.id)));
}

/**
 * One line per transaction for a "claim all" on pool rewards.
 *
 * Claim-all sends up to five `claim_pool` calls in one signed transaction, so
 * six tranches arrive as two transactions. Each becomes one row naming its
 * tranches, with the total the chain reported paying. The sum is of settled
 * figures from the return values, not a calculation of what is owed. If any
 * figure is missing the total is left out rather than understated.
 */
export function groupPoolClaims(ops: AccountOp[]): AccountOp[] {
  const out: AccountOp[] = [];
  const groups = new Map<string, AccountOp[]>();
  for (const o of ops) {
    if (o.action !== "claim_pool" || o.status !== "confirmed") { out.push(o); continue; }
    const g = groups.get(o.id);
    if (g) { g.push(o); continue; }
    groups.set(o.id, [o]);
    out.push(o);
  }
  return out.map((o) => {
    const g = o.action === "claim_pool" && o.status === "confirmed" ? groups.get(o.id) : undefined;
    if (!g || g.length < 2) return o;
    const paid = g.map((c) => /^claimed (\d+)$/.exec(c.ret ?? "")?.[1]);
    const { ret: _ret, ...row } = o;
    return {
      ...row,
      payload: g.map((c) => c.payload).join(","),
      ...(paid.every(Boolean) ? { ret: `claimed ${paid.reduce((a, b) => a + BigInt(b!), 0n)}` } : {}),
    };
  });
}

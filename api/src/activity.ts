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

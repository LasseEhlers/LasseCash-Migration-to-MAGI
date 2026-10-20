/**
 * Is there something for `settle_pending` to do for this account?
 *
 * The contract turns an account's pending Proof-of-Brain balance into its
 * monthly mint only when somebody CALLS `settle_pending` — there is no timer on
 * MAGI. This decides whether the site should offer (or fire) that call, using
 * only fields the chain already reported; nothing here is economics.
 *
 * It mirrors the contract's own gate (`SettlePending` in contract/state/pob.go):
 * a first-sighting anchor never mints, an epoch that has not turned is "not due
 * yet", and a balance under MinMintAmount (1 LASSECASH) rolls over. Offering
 * the button only when all three clear means pressing it opens a wallet prompt
 * that will actually do something, instead of one that returns ok and moves
 * nothing.
 *
 * Why this exists: `pending_curation` is reported as 0 on the real chain (the
 * queue cursors are not read), and the automatic settle used to key on it, so
 * on mainnet the automatic settle never sent a transaction. Found 2026-10-20:
 * the whole history held ONE `settle_pending`, Lasse's own on 9 September.
 */
import { toUnits } from "./amount.js";
import type { AccountView } from "./types.js";

/** engine.MinMintAmount — 1.00000000 LASSECASH in base units. */
const MIN_MINT_UNITS = 100_000_000n;

export function settleIsDue(
  me: Pick<AccountView, "pending" | "pending_epoch" | "pending_curation"> | null | undefined,
  epoch: number,
): boolean {
  if (!me || epoch <= 0) return false;
  // Curation entries queued: the call also drains those, so it is worth sending.
  if ((me.pending_curation ?? 0) > 0) return true;
  const anchored = me.pending_epoch ?? 0;
  if (anchored <= 0) return false;          // first sighting only anchors
  if (epoch <= anchored) return false;       // the month has not turned yet
  return toUnits(me.pending) >= MIN_MINT_UNITS;
}

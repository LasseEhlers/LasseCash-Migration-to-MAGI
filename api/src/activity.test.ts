import { test } from "node:test";
import assert from "node:assert/strict";
import { groupPoolClaims, hideSpentAllowances } from "./activity.js";
import type { AccountOp } from "./backend.js";

const op = (id: string, action: string, status: AccountOp["status"]): AccountOp =>
  ({ id, time: "2026-10-20T09:40:30", action, payload: "", status });

test("an allowance whose swap confirmed is plumbing and is hidden", () => {
  const rows = [op("a", "increaseAllowance", "confirmed"), op("a", "execute", "confirmed")];
  assert.deepEqual(hideSpentAllowances(rows).map((r) => r.action), ["execute"]);
});

test("a failed transaction keeps its allowance row, because it may stay open", () => {
  const rows = [op("f", "increaseAllowance", "failed"), op("f", "execute", "failed")];
  assert.equal(hideSpentAllowances(rows).length, 2);
});

test("an allowance confirmed while its swap failed is kept", () => {
  const rows = [op("m", "increaseAllowance", "confirmed"), op("m", "execute", "failed")];
  assert.equal(hideSpentAllowances(rows).length, 2);
});

test("a bare allowance with no sibling call is kept", () => {
  assert.equal(hideSpentAllowances([op("z", "increaseAllowance", "confirmed")]).length, 1);
});

test("allowances of OTHER transactions are not hidden by someone else's swap", () => {
  const rows = [op("x", "increaseAllowance", "confirmed"), op("y", "execute", "confirmed")];
  assert.equal(hideSpentAllowances(rows).length, 2);
});

const claim = (id: string, tranche: string, paid?: string, status: AccountOp["status"] = "confirmed"): AccountOp =>
  ({ ...op(id, "claim_pool", status), payload: tranche, ...(paid ? { ret: `claimed ${paid}` } : {}) });

test("a claim-all transaction becomes one row with its tranches and the chain's total", () => {
  // Lasse's real claim of 2026-10-31: two transactions, six tranches.
  const rows = groupPoolClaims([
    claim("b", "1", "438459157289"),
    claim("a", "9", "339144053823"), claim("a", "8", "227226516061"), claim("a", "6", "10616349657"),
    claim("a", "5", "641315223468"), claim("a", "4", "544091555826"),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.payload, "1");
  assert.equal(rows[0]!.ret, "claimed 438459157289");
  assert.equal(rows[1]!.payload, "9,8,6,5,4");
  assert.equal(rows[1]!.ret, "claimed 1762393698835");
});

test("a total with a missing figure is left out, never understated", () => {
  const rows = groupPoolClaims([claim("a", "9", "100"), claim("a", "8")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ret, undefined);
});

test("failed claims keep their own rows, and other calls are untouched", () => {
  const rows = groupPoolClaims([claim("f", "9", undefined, "failed"), claim("f", "8", undefined, "failed"), op("x", "payout", "confirmed")]);
  assert.deepEqual(rows.map((r) => r.payload || r.action), ["9", "8", "payout"]);
});

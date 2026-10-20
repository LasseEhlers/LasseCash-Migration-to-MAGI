import { test } from "node:test";
import assert from "node:assert/strict";
import { hideSpentAllowances } from "./activity.js";
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

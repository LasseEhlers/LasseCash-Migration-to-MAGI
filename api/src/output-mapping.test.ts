import { test } from "node:test";
import assert from "node:assert/strict";
import { resultFor, resultsByOp } from "./magi-backend.js";

// Shapes copied from production on 2026-10-03.
test("two contracts in one transaction: our output is keyed txid-1", () => {
  const m = resultsByOp([
    { inputs: ["ba37", "ba37-1"], results: [{ ok: true, ret: '{"success":true}' }, { ok: true, ret: "" }] }, // token
    { inputs: ["ba37-1"], results: [{ ok: true, ret: "minted 204054818944 L-Shares" }] },                  // core
  ].slice(1));
  assert.equal(resultFor(m, "ba37", 1, 1)?.ret, "minted 204054818944 L-Shares");
});

test("one contract, three calls: inputs per operation", () => {
  const m = resultsByOp([{ inputs: ["b660", "b660-1", "b660-2"], results: [
    { ok: true, ret: "accrual is current" }, { ok: true, ret: "accrual is current" }, { ok: true, ret: "claimed 28876255002" }] }]);
  assert.equal(resultFor(m, "b660", 2, 2)?.ret, "claimed 28876255002");
});

test("old shape: one bare input with a result per call", () => {
  const m = resultsByOp([{ inputs: ["old"], results: [{ ok: true, ret: "a" }, { ok: true, ret: "b" }] }]);
  assert.equal(resultFor(m, "old", 5, 1)?.ret, "b");
});

test("old shape: one output covering two transactions, sliced by call count", () => {
  const m = resultsByOp(
    [{ inputs: ["t1", "t2"], results: [{ ok: true, ret: "x" }, { ok: true, ret: "y" }, { ok: true, ret: "z" }] }],
    new Map([["t1", 1], ["t2", 2]]),
  );
  assert.equal(resultFor(m, "t2", 9, 1)?.ret, "z");
});

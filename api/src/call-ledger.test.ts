import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCallLedger } from "./magi-backend.js";

const tx = (id: string, h: number, status: string, calls: [string, string][]) => ({
  id, anchr_ts: `t${h}`, anchr_height: h, status, required_auths: ["hive:a"], required_posting_auths: [],
  ops: calls.map(([action, payload]) => ({ type: "call", data: { action, payload } })),
});
const wanted = new Set(["swap_lassecash_hbd", "add_liquidity"]);

test("the index and the node walk build the same ledger: calls joined to results, oldest first", () => {
  const txs = [ // newest first, as both sources answer
    tx("c", 3, "CONFIRMED", [["settle", ""], ["swap_lassecash_hbd", "100|1"]]),
    tx("b", 2, "FAILED", [["swap_lassecash_hbd", "5|1"]]),
    tx("a", 1, "CONFIRMED", [["add_liquidity", "10"]]),
  ];
  const outputs = [
    { inputs: ["c"], results: [{ ok: true, ret: "settled" }, { ok: true, ret: "swapped for 42 HBD" }] },
    { inputs: ["a"], results: [{ ok: true, ret: "added 10 LC and 1 HBD" }] },
  ];
  const l = buildCallLedger(txs, outputs, wanted);
  assert.deepEqual(l.map((e) => [e.txId, e.action, e.ret]), [
    ["a", "add_liquidity", "added 10 LC and 1 HBD"],
    ["c", "swap_lassecash_hbd", "swapped for 42 HBD"], // matched by call index, not action name
  ]);
});

test("a call whose output has not landed yet is reported, never guessed", () => {
  const l = buildCallLedger([tx("d", 4, "CONFIRMED", [["swap_lassecash_hbd", "1|1"]])], [], wanted);
  assert.equal(l.length, 1);
  assert.equal(l[0]!.ok, false);
  assert.equal(l[0]!.ret, "");
});

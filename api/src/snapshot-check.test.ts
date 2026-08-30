import { test } from "node:test";
import assert from "node:assert/strict";
import { fromUnits } from "./amount.js";
import { cleanName, selfSigned, shardOf, type HeOp } from "./snapshot-check.js";

// Both rules below shipped BROKEN on 2026-08-23 and were found by Lasse
// looking at the rendered page, which is not a control. These are the control.

const op = (o: Partial<HeOp>): HeOp => ({
  timestamp: 0, operation: "tokens_transfer", quantity: "1", transactionId: "t", ...o,
});

test("shard base units convert to a displayable amount", () => {
  // @tibfox's real balance. The page showed 52,720,116,326,256 — 1e8 too big,
  // because the shards store base units and lc() takes a decimal Amount.
  assert.equal(fromUnits(52_720_116_326_256n), "527201.16326256");
  assert.equal(fromUnits(0n), "0.00000000");
  assert.equal(fromUnits(1n), "0.00000001");
});

test("a payout sent TO the account is not something the account signed", () => {
  // Every one of @tibfox's last six LASSECASH operations looks exactly like
  // this: an automated tribe payout from @lassecash. The page told him he had
  // signed all of them.
  for (const kind of ["tokens_transfer", "tokens_stake"]) {
    assert.equal(
      selfSigned(op({ operation: kind, from: "lassecash", to: "tibfox" }), "tibfox"),
      false, `${kind} received should not count`,
    );
  }
});

test("an operation the account sent does count", () => {
  assert.equal(selfSigned(op({ from: "tibfox", to: "someone" }), "tibfox"), true);
  assert.equal(
    selfSigned(op({ operation: "tokens_stake", from: "tibfox", to: "tibfox" }), "tibfox"),
    true,
  );
});

test("an unstake the owner started counts; its automatic instalments never do", () => {
  assert.equal(selfSigned(op({ operation: "tokens_unstakeStart" }), "bob"), true);
  assert.equal(selfSigned(op({ operation: "tokens_undelegateStart" }), "bob"), true);
  // If these counted, ONE powerdown would look like months of being alive.
  assert.equal(selfSigned(op({ operation: "tokens_unstakeDone" }), "bob"), false);
  assert.equal(selfSigned(op({ operation: "tokens_undelegateDone" }), "bob"), false);
});

test("market orders and Diesel-pool actions are the owner's signature", () => {
  // @cashmap bought 831 LASSECASH from the pool on 2026-08-30; the row reads
  // from=contract_marketpools, to=cashmap. The scanner has counted these
  // since 2026-08-23 (HE_SELF_INITIATED_OPS); the page must agree.
  assert.equal(selfSigned(op({ operation: "marketpools_swapTokens", from: "contract_marketpools", to: "cashmap" }), "cashmap"), true);
  assert.equal(selfSigned(op({ operation: "marketpools_addLiquidity", from: "contract_marketpools" }), "bob"), true);
  assert.equal(selfSigned(op({ operation: "marketpools_removeLiquidity", from: "contract_marketpools" }), "bob"), true);
  assert.equal(selfSigned(op({ operation: "market_placeOrder" }), "bob"), true);
  assert.equal(selfSigned(op({ operation: "market_cancel" }), "bob"), true);
  assert.equal(selfSigned(op({ operation: "tokens_cancelUnstake" }), "bob"), true);
});

test("anything unrecognised fails CLOSED", () => {
  assert.equal(selfSigned(op({ operation: "tokens_somethingNew" }), "bob"), false);
});

test("names shard exactly as the Go tree and the Python builder do", () => {
  assert.equal(shardOf("lasseehlers"), "la");
  assert.equal(shardOf("a-a-r0n"), "a-");   // '-' legal in position 2 only
  assert.equal(shardOf("tibfox"), "ti");
  // Verified against tools/snapshot/build_status.py, which produced the shard
  // files actually being served: a 1-char name yields a 1-char shard (both
  // languages treat the empty character as "allowed"), and only the offending
  // position is folded to '_'.
  assert.equal(shardOf("x"), "x");
  assert.equal(shardOf("_weird"), "_w");    // '_' illegal in position 1 only
});

test("what a person types is normalised", () => {
  for (const t of ["@Tibfox", " tibfox ", "TIBFOX", "@@tibfox"])
    assert.equal(cleanName(t), "tibfox");
});

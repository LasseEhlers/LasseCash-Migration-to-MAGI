import { test } from "node:test";
import assert from "node:assert/strict";
import { isOlderPaidOut, trendingTier } from "./feed-order.js";

test("earning posts, then unregistered, then paid out", () => {
  assert.equal(trendingTier(true, false), 0);
  assert.equal(trendingTier(false, false), 1);
  assert.equal(trendingTier(true, true), 2);
});

test("before the chain has answered a registered post is not treated as paid out", () => {
  assert.equal(trendingTier(true, undefined), 0);
});

test("a paid-out post turns older exactly two weeks after its window closed", () => {
  const post = { paid_out: true, payout_height: 1_000_000 };
  assert.equal(isOlderPaidOut(post, 1_000_000 + 14 * 28_800 - 1), false);
  assert.equal(isOlderPaidOut(post, 1_000_000 + 14 * 28_800), true);
});

test("a post not yet settled never turns older, however long ago it closed", () => {
  assert.equal(isOlderPaidOut({ paid_out: false, payout_height: 1 }, 99_000_000), false);
});

test("unknown height or post hides nothing", () => {
  assert.equal(isOlderPaidOut({ paid_out: true, payout_height: 1 }, 0), false);
  assert.equal(isOlderPaidOut(undefined, 99_000_000), false);
});

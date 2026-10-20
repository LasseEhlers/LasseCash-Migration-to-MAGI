import { test } from "node:test";
import assert from "node:assert/strict";
import { settleIsDue, currentMonthEpoch } from "./settle.js";

const acct = (pending: string, pending_epoch: number, pending_curation = 0) =>
  ({ pending, pending_epoch, pending_curation });

test("a balance whose month has turned is due", () => {
  // Lasse's real record on 2026-10-20: 39,950.45606572 anchored to epoch 24321.
  assert.equal(settleIsDue(acct("39950.45606572", 24321), 24322), true);
});

test("the same balance is NOT due while the anchored month is still current", () => {
  assert.equal(settleIsDue(acct("39950.45606572", 24321), 24321), false);
});

test("a balance under one LASSECASH rolls over rather than settling", () => {
  assert.equal(settleIsDue(acct("0.99999999", 24321), 24322), false);
  assert.equal(settleIsDue(acct("1.00000000", 24321), 24322), true);
});

test("a first sighting (no anchor yet) only anchors, so it is not offered", () => {
  assert.equal(settleIsDue(acct("500.00000000", 0), 24322), false);
});

test("queued curation makes it worth sending even with nothing pending", () => {
  assert.equal(settleIsDue(acct("0.00000000", 0, 3), 24322), true);
});

test("no account or no epoch means nothing is due", () => {
  assert.equal(settleIsDue(null, 24322), false);
  assert.equal(settleIsDue(acct("100.00000000", 24321), 0), false);
});

test("the month epoch matches the contract's year*12+month (Sept 2026 = 24321)", () => {
  assert.equal(currentMonthEpoch(new Date("2026-09-09T00:42:36Z")), 24321);
  assert.equal(currentMonthEpoch(new Date("2026-10-20T12:00:00Z")), 24322);
  assert.equal(currentMonthEpoch(new Date("2026-12-31T23:59:59Z")), 24324);
  assert.equal(currentMonthEpoch(new Date("2027-01-01T00:00:00Z")), 24325);
});

test("the due check uses the calendar when the backend reports epoch 0", () => {
  // MagiBackend reports epoch 0; the caller falls back to currentMonthEpoch().
  const epoch = 0 || currentMonthEpoch(new Date("2026-10-20T12:00:00Z"));
  assert.equal(settleIsDue(acct("39950.45606572", 24321), epoch), true);
});

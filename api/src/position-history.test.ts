import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mintStory, parseClaimed, parseLiquidity, reservesAt, trancheStory, type AccountCall,
} from "./position-history.js";
import type { PoolTrade } from "./types.js";

const GENESIS = 109_512_118;
const call = (o: Partial<AccountCall>): AccountCall => ({
  txId: "t", height: 0, time: "", action: "", payload: "", ok: true, ret: "", ...o,
});

test("parsers read the contract's own return strings, old spelling too", () => {
  assert.equal(parseClaimed("claimed 2623037768764"), 2623037768764n);
  assert.equal(parseClaimed("claimed 100 liquid"), 100n);
  assert.equal(parseClaimed("accrual is current"), null);
  assert.deepEqual(parseLiquidity("added 5 LASSECASH and 7 HBD"), { lc: 5n, hbd: 7n });
  assert.deepEqual(parseLiquidity("withdrew 5 LC and 7 HBD"), { lc: 5n, hbd: 7n });
});

// @cinqowy's mint #2 exactly as it sits on production (2026-10-03).
test("a capital mint held to maturity and claimed", () => {
  const start = 109_621_935;
  const claimAt = start + 25 * 28_800 + 3_000;
  const calls = [
    call({ txId: "m", height: start, action: "mint", payload: "2600000000000|25", ret: "minted 3296649059500 L-Shares" }),
    call({ txId: "a", height: claimAt, action: "advance", ret: "accrual is current" }),
    call({ txId: "c", height: claimAt, action: "claim_mint", payload: "2", ret: "claimed 2623037768764" }),
    call({ txId: "x", height: claimAt + 5, action: "claim_mint", payload: "1", ret: "claimed 55558297920" }),
  ];
  const s = mintStory(2, "2600000000000|3296649059500|109621935|25|0|1|802000578|0", calls, GENESIS)!;
  assert.equal(s.origin, "capital");
  assert.equal(s.startTxId, "m");
  assert.equal(s.claimTxId, "c");
  assert.equal(s.paidOut, "26230.37768764");
  assert.equal(s.gain, "230.37768764");
  assert.equal(s.gainPct, 0.886);
  assert.equal(s.endedEarly, false);
  assert.ok(s.annualisedPct! > 12 && s.annualisedPct! < 13);
});

test("a migration mint starts at genesis and points at the claim", () => {
  const calls = [call({ txId: "cm", height: GENESIS + 99, action: "claim_migration" })];
  const s = mintStory(1, "55100917433|55100917433|109512118|30|0|0|0|0", calls, GENESIS)!;
  assert.equal(s.origin, "migration");
  assert.equal(s.startTxId, "cm");
  assert.equal(s.paidOut, null);
  assert.equal(s.ended, false);
});

test("a mint with no mint call at its height is a monthly earnings mint", () => {
  const s = mintStory(3, "100|100|109700000|30|0|0|0|0", [call({ height: 109_700_000, action: "vote" })], GENESIS)!;
  assert.equal(s.origin, "earnings");
});

test("an early end is flagged and shows a loss", () => {
  const start = 109_700_000;
  const calls = [
    call({ height: start, action: "mint" }),
    call({ txId: "e", height: start + 7 * 28_800, action: "claim_mint", payload: "4", ret: "claimed 61" }),
  ];
  const s = mintStory(4, "100|100|109700000|30|0|1|0|0", calls, GENESIS)!;
  assert.equal(s.endedEarly, true);
  assert.equal(s.gain, "-0.00000039");
});

test("tranche n is the n-th SUCCESSFUL deposit; claims and the withdrawal are its own", () => {
  const calls = [
    call({ txId: "d0", height: 1, action: "add_liquidity", ok: false }),
    call({ txId: "d1", height: 2, action: "add_liquidity", ret: "added 1000 LC and 20 HBD" }),
    call({ txId: "d2", height: 3, action: "add_liquidity", ret: "added 500 LASSECASH and 10 HBD" }),
    call({ txId: "c1", height: 4, action: "claim_pool", payload: "2", ret: "claimed 7" }),
    call({ txId: "c9", height: 5, action: "claim_pool", payload: "1", ret: "claimed 99" }),
    call({ txId: "c2", height: 6, action: "claim_pool", payload: "2", ret: "claimed 3" }),
    call({ txId: "w", height: 7, action: "remove_liquidity", payload: "2", ret: "withdrew 510 LASSECASH and 9 HBD" }),
  ];
  const t = trancheStory(2, calls);
  assert.equal(t.depositTxId, "d2");
  assert.equal(t.depositLc, "0.00000500");
  assert.deepEqual(t.claims.map((c) => c.txId), ["c1", "c2"]);
  assert.equal(t.claimedTotal, "0.00000010");
  assert.equal(t.withdrawTxId, "w");
  assert.equal(t.withdrawHbd, "0.00000009");
});

test("reserves at a height are the ones the last earlier trade left", () => {
  const tr = (height: number, lc: string): PoolTrade =>
    ({ height, lcReserve: lc, hbdReserve: "1" } as unknown as PoolTrade);
  const trades = [tr(10, "a"), tr(30, "c"), tr(20, "b")];
  assert.equal(reservesAt(trades, 5), null);
  assert.equal(reservesAt(trades, 25)?.lc, "b");
  assert.equal(reservesAt(trades, 99)?.lc, "c");
});

package state

import (
	"testing"

	"github.com/lassecash/engine"
	"strings"
)

// newPool returns a chain with a funded LP and an opened pool.
func newPool(t *testing.T) (*MemStore, *MemAssets, Ctx) {
	t.Helper()
	s, ctx := newChain(t)
	a := NewMemAssets()
	creditLiquid(s, "hive:lp1", lc(1_000_000))
	creditLiquid(s, "hive:lp2", lc(1_000_000))
	creditLiquid(s, "hive:trader", lc(100_000))
	return s, a, ctx
}

// auditPool checks the contract's real HBD custody matches its bookkeeping.
// If these ever diverge, the pool is either insolvent or holding phantom HBD.
func auditPool(t *testing.T, s *MemStore, a *MemAssets) {
	t.Helper()
	_, hbdRes := PoolReserves(s)
	if int64(hbdRes) != a.Held {
		t.Fatalf("HBD BOOKKEEPING MISMATCH: reserve says %s but the contract holds %d",
			fmtA(hbdRes), a.Held)
	}
}

// --- opening --------------------------------------------------------------

func TestFirstProviderOpensThePool(t *testing.T) {
	s, a, ctx := newPool(t)
	lp := at(ctx, "hive:lp1", genesis)

	id, r := AddLiquidity(s, a, lp, lc(100_000), lc(25_000))
	if !r.OK {
		t.Fatalf("open failed: %s", r.Msg)
	}
	lcRes, hbdRes := PoolReserves(s)
	if lcRes != lc(100_000) || hbdRes != lc(25_000) {
		t.Fatalf("reserves %s/%s, want 100000/25000", fmtA(lcRes), fmtA(hbdRes))
	}
	tr, found := GetTranche(s, "hive:lp1", id)
	if !found || tr.Shares <= 0 {
		t.Fatalf("tranche missing or empty: %+v", tr)
	}
	auditPool(t, s, a)
	auditSupply(t, s)
}

// A later deposit must match the pool ratio, or it shifts the price for free.
func TestLaterDepositMustMatchTheRatio(t *testing.T) {
	s, a, ctx := newPool(t)
	AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(25_000))

	// 10% of the LC side needs 10% of the HBD side: 2,500.
	if _, r := AddLiquidity(s, a, at(ctx, "hive:lp2", genesis), lc(10_000), lc(2_499)); r.OK {
		t.Fatal("underfunded deposit accepted — it would move the price")
	}
	id, r := AddLiquidity(s, a, at(ctx, "hive:lp2", genesis), lc(10_000), lc(2_500))
	if !r.OK {
		t.Fatalf("correctly funded deposit rejected: %s", r.Msg)
	}
	// Only what was needed should have been drawn, not the whole limit.
	_, hbdRes := PoolReserves(s)
	if hbdRes != lc(27_500) {
		t.Fatalf("HBD reserve %s, want 27500", fmtA(hbdRes))
	}
	if tr, _ := GetTranche(s, "hive:lp2", id); tr.Shares <= 0 {
		t.Fatal("second provider got no shares")
	}
	auditPool(t, s, a)
	auditSupply(t, s)
}

func TestAddLiquidityRejectsNonsense(t *testing.T) {
	s, a, ctx := newPool(t)
	lp := at(ctx, "hive:lp1", genesis)

	if _, r := AddLiquidity(s, a, lp, 0, lc(100)); r.OK {
		t.Fatal("zero deposit accepted")
	}
	if _, r := AddLiquidity(s, a, lp, -lc(1), lc(100)); r.OK {
		t.Fatal("negative deposit accepted")
	}
	if _, r := AddLiquidity(s, a, lp, lc(5_000_000), lc(100)); r.OK {
		t.Fatal("deposit beyond the balance accepted")
	}
	if _, r := AddLiquidity(s, a, lp, lc(100), 0); r.OK {
		t.Fatal("opening deposit with no HBD accepted — price would be undefined")
	}
}

// A failed HBD draw must leave nothing behind.
func TestFailedHbdDrawIsAtomic(t *testing.T) {
	s, a, ctx := newPool(t)
	lp := at(ctx, "hive:lp1", genesis)
	before := Balance(s, "hive:lp1")

	a.Fail = true
	if _, r := AddLiquidity(s, a, lp, lc(1_000), lc(250)); r.OK {
		t.Fatal("deposit succeeded despite the HBD transfer failing")
	}
	if Balance(s, "hive:lp1") != before {
		t.Fatal("LASSECASH was debited even though the HBD never arrived")
	}
	if sh := PoolShares(s); sh != 0 {
		t.Fatalf("pool shares minted against HBD that never arrived: %d", sh)
	}
	auditPool(t, s, a)
}

// --- swapping -------------------------------------------------------------

func TestSwapMovesBothSidesAndKeepsCustodyHonest(t *testing.T) {
	s, a, ctx := newPool(t)
	AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(25_000))

	tr := at(ctx, "hive:trader", genesis)
	lcBefore := Balance(s, "hive:trader")

	if r := SwapLCForHBD(s, a, tr, lc(1_000), 0); !r.OK {
		t.Fatalf("swap failed: %s", r.Msg)
	}
	if Balance(s, "hive:trader") != lcBefore-lc(1_000) {
		t.Fatal("trader's LASSECASH not debited correctly")
	}
	if a.Wallets["hive:trader"] <= 0 {
		t.Fatal("trader received no HBD")
	}
	auditPool(t, s, a)

	// And back the other way.
	got := a.Wallets["hive:trader"]
	if r := SwapHBDForLC(s, a, tr, engine.Amount(got), 0); !r.OK {
		t.Fatalf("reverse swap failed: %s", r.Msg)
	}
	auditPool(t, s, a)
	// The round trip must have cost the trader, not paid them.
	if Balance(s, "hive:trader") > lcBefore {
		t.Fatalf("round trip PROFITED: %s -> %s", fmtA(lcBefore), fmtA(Balance(s, "hive:trader")))
	}
}

// Slippage protection: a trade must be refusable if the price moved.
func TestSwapHonoursMinimumOutput(t *testing.T) {
	s, a, ctx := newPool(t)
	AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(25_000))
	tr := at(ctx, "hive:trader", genesis)

	before := Balance(s, "hive:trader")
	if r := SwapLCForHBD(s, a, tr, lc(1_000), lc(10_000)); r.OK {
		t.Fatal("swap executed below the caller's stated minimum")
	}
	if Balance(s, "hive:trader") != before {
		t.Fatal("a refused swap still moved funds")
	}
	auditPool(t, s, a)
}

// The AMM solvency invariant, driven by many trades in both directions.
func TestManySwapsNeverShrinkK(t *testing.T) {
	s, a, ctx := newPool(t)
	AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(500_000), lc(125_000))
	tr := at(ctx, "hive:trader", genesis)

	prevLC, prevHBD := PoolReserves(s)
	for i := 0; i < 40; i++ {
		if i%2 == 0 {
			SwapLCForHBD(s, a, tr, lc(int64(100+i*10)), 0)
		} else {
			held := a.Wallets["hive:trader"]
			if held > 0 {
				SwapHBDForLC(s, a, tr, engine.Amount(held/2), 0)
			}
		}
		lcRes, hbdRes := PoolReserves(s)
		if lcRes <= 0 || hbdRes <= 0 {
			t.Fatalf("iteration %d drained a reserve: %s/%s", i, fmtA(lcRes), fmtA(hbdRes))
		}
		// k must never fall.
		if !kAtLeast(lcRes, hbdRes, prevLC, prevHBD) {
			t.Fatalf("iteration %d: k SHRANK from %s*%s to %s*%s",
				i, fmtA(prevLC), fmtA(prevHBD), fmtA(lcRes), fmtA(hbdRes))
		}
		prevLC, prevHBD = lcRes, hbdRes
		auditPool(t, s, a)
	}
	t.Logf("40 swaps: reserves ended at %s LC / %s HBD", fmtA(prevLC), fmtA(prevHBD))
}

func kAtLeast(lc1, hbd1, lc0, hbd0 engine.Amount) bool {
	// Compare via the engine's 128-bit helper by treating it as a swap check.
	return engine.SwapPreservesK(lc0, hbd0, lc1-lc0, hbd0-hbd1)
}

// --- rewards --------------------------------------------------------------

// A long-lived tranche must out-earn an equal fresh one — that is the loyalty
// bonus doing its job.
func TestLoyaltyBonusRewardsPatience(t *testing.T) {
	s, a, ctx := newPool(t)
	oldID, r := AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(25_000))
	if !r.OK {
		t.Fatalf("open failed: %s", r.Msg)
	}
	// A second, identical position opened 90 days later.
	later := genesis + 90*engine.HeightsPerDay
	newID, r := AddLiquidity(s, a, at(ctx, "hive:lp2", later), lc(100_000), lc(25_000))
	if !r.OK {
		t.Fatalf("second deposit failed: %s", r.Msg)
	}

	// Let rewards accrue, then both claim.
	claimAt := later + engine.HeightsPerDay
	Settle(s, Ctx{Height: claimAt})

	beforeOld := Balance(s, "hive:lp1")
	beforeNew := Balance(s, "hive:lp2")
	ClaimPoolRewards(s, at(ctx, "hive:lp1", claimAt), oldID)
	ClaimPoolRewards(s, at(ctx, "hive:lp2", claimAt), newID)
	gotOld := Balance(s, "hive:lp1") - beforeOld
	gotNew := Balance(s, "hive:lp2") - beforeNew

	if gotOld <= gotNew {
		t.Fatalf("the 90-day tranche earned %s, no more than the fresh one's %s",
			fmtA(gotOld), fmtA(gotNew))
	}
	t.Logf("equal size: 90-day tranche earned %s, fresh tranche %s", fmtA(gotOld), fmtA(gotNew))
	auditSupply(t, s)
}

// Claims must never exceed the pool that funds them.
func TestPoolRewardsCannotBeOverdrawn(t *testing.T) {
	s, a, ctx := newPool(t)
	id1, _ := AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(25_000))
	id2, _ := AddLiquidity(s, a, at(ctx, "hive:lp2", genesis), lc(100_000), lc(25_000))

	claimAt := genesis + 30*engine.HeightsPerDay
	Settle(s, Ctx{Height: claimAt})
	funded := getAmount(s, keyPoolLiquidity)

	b1, b2 := Balance(s, "hive:lp1"), Balance(s, "hive:lp2")
	// Claim repeatedly — a second claim in the same instant must pay nothing.
	for i := 0; i < 3; i++ {
		ClaimPoolRewards(s, at(ctx, "hive:lp1", claimAt), id1)
		ClaimPoolRewards(s, at(ctx, "hive:lp2", claimAt), id2)
	}
	paid := (Balance(s, "hive:lp1") - b1) + (Balance(s, "hive:lp2") - b2)

	if paid > funded {
		t.Fatalf("LPs drew %s from a pool holding %s", fmtA(paid), fmtA(funded))
	}
	if getAmount(s, keyPoolLiquidity) < 0 {
		t.Fatal("liquidity pool went negative")
	}
	auditSupply(t, s)
}

// --- withdrawal -----------------------------------------------------------

func TestWithdrawReturnsBothSidesAndClosesOnce(t *testing.T) {
	s, a, ctx := newPool(t)
	id, _ := AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(25_000))

	lcBefore := Balance(s, "hive:lp1")
	if r := RemoveLiquidity(s, a, at(ctx, "hive:lp1", genesis), id); !r.OK {
		t.Fatalf("withdraw failed: %s", r.Msg)
	}
	if Balance(s, "hive:lp1") <= lcBefore {
		t.Fatal("no LASSECASH returned")
	}
	if a.Wallets["hive:lp1"] <= 0 {
		t.Fatal("no HBD returned")
	}
	// Sole provider withdrawing everything must empty the pool exactly.
	lcRes, hbdRes := PoolReserves(s)
	if lcRes != 0 || hbdRes != 0 {
		t.Fatalf("pool not emptied: %s/%s", fmtA(lcRes), fmtA(hbdRes))
	}
	auditPool(t, s, a)
	auditSupply(t, s)

	if r := RemoveLiquidity(s, a, at(ctx, "hive:lp1", genesis), id); r.OK {
		t.Fatal("DOUBLE WITHDRAWAL: closed tranche withdrew again")
	}
}

// Tranches are exited by id, so a partial exit never silently destroys the
// user's most-matured loyalty position.
func TestTranchesAreExitedIndividually(t *testing.T) {
	s, a, ctx := newPool(t)
	oldID, _ := AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(50_000), lc(12_500))
	later := genesis + 90*engine.HeightsPerDay
	newID, _ := AddLiquidity(s, a, at(ctx, "hive:lp1", later), lc(50_000), lc(12_500))

	// Exit the YOUNG one; the matured one must survive untouched.
	if r := RemoveLiquidity(s, a, at(ctx, "hive:lp1", later), newID); !r.OK {
		t.Fatalf("withdraw failed: %s", r.Msg)
	}
	oldT, found := GetTranche(s, "hive:lp1", oldID)
	if !found || oldT.Closed {
		t.Fatal("exiting the new tranche closed the matured one")
	}
	if oldT.Shares <= 0 {
		t.Fatal("matured tranche lost its shares")
	}
	auditPool(t, s, a)
	auditSupply(t, s)
}

func TestCannotWithdrawSomeoneElsesTranche(t *testing.T) {
	s, a, ctx := newPool(t)
	id, _ := AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(25_000))
	if r := RemoveLiquidity(s, a, at(ctx, "hive:mallory", genesis), id); r.OK {
		t.Fatal("stole another provider's liquidity")
	}
	auditPool(t, s, a)
}

// --- the swap fee, which does not exist ------------------------------------

// The fee is not a parameter with a zero default — there is no parameter at
// all, so no consensus vote can introduce one. This test is the guard on that
// promise: it fails the moment anyone re-registers a fee key.
func TestSwapFeeIsZeroAndNotGovernable(t *testing.T) {
	for _, k := range Registry().Keys() {
		if strings.Contains(string(k), "fee") {
			t.Fatalf("a fee parameter is registered (%q) — the swap fee must not be governable", k)
		}
	}

	// And the pool must actually charge nothing: swapping out and straight
	// back may only lose the flooring dust, never a percentage.
	s, a, ctx := newPool(t)
	if _, r := AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(25_000)); !r.OK {
		t.Fatalf("open failed: %s", r.Msg)
	}
	lcRes, hbdRes := PoolReserves(s)
	in := lcRes / 1000

	out, ok := engine.SwapOut(lcRes, hbdRes, in)
	if !ok {
		t.Fatal("swap rejected")
	}
	back, ok := engine.SwapOut(hbdRes-out, lcRes+in, out)
	if !ok {
		t.Fatal("return swap rejected")
	}
	if back > in {
		t.Fatalf("round trip profited: %d -> %d", in, back)
	}
	// Dust only: the loss must be a handful of base units, not basis points.
	// 1 bps of `in` would be in/10000; assert we are far under even that.
	if lost := int64(in - back); lost > 16 {
		t.Fatalf("round trip lost %d base units — that is a fee, not flooring", lost)
	}
	auditPool(t, s, a)
}

// A liquidity tranche earns ONLY the rewards that arrived while it was in the
// pool. Before the LP accumulator (2026-08-21) rewards were split at claim
// time by current weight, so a tranche added today could claim a slice of
// last month's emission — the same "claim last wins" bug the L-Share side had.
func TestLateLiquidityCannotClaimEarlierRewards(t *testing.T) {
	s, a, ctx := newPool(t)
	day := uint64(engine.HeightsPerDay)

	// lp1 opens the pool at genesis.
	id1, r := AddLiquidity(s, a, at(ctx, "hive:lp1", genesis), lc(100_000), lc(103))
	if !r.OK {
		t.Fatal(r.Msg)
	}
	// Ten days of emission flow in with lp1 alone.
	AccrueFully(s, genesis+10*day)
	Settle(s, Ctx{Height: genesis + 10*day})
	aloneInflow := getAmount(s, keyPoolLiquidity)
	if aloneInflow <= 0 {
		t.Fatal("no liquidity rewards accrued in ten days")
	}

	// lp2 joins with an identical deposit, then ten more days pass.
	id2, r := AddLiquidity(s, a, at(ctx, "hive:lp2", genesis+10*day), lc(100_000), lc(200))
	if !r.OK {
		t.Fatal(r.Msg)
	}
	AccrueFully(s, genesis+20*day)
	Settle(s, Ctx{Height: genesis + 20*day})
	sharedInflow := getAmount(s, keyPoolLiquidity) - aloneInflow

	// lp2 claims FIRST — the order that used to win.
	b2 := Balance(s, "hive:lp2")
	if r := ClaimPoolRewards(s, at(ctx, "hive:lp2", genesis+20*day), id2); !r.OK {
		t.Fatal(r.Msg)
	}
	got2 := Balance(s, "hive:lp2") - b2
	b1 := Balance(s, "hive:lp1")
	if r := ClaimPoolRewards(s, at(ctx, "hive:lp1", genesis+20*day), id1); !r.OK {
		t.Fatal(r.Msg)
	}
	got1 := Balance(s, "hive:lp1") - b1

	// lp2 gets roughly half of the SHARED ten days and nothing of the first
	// ten; lp1 gets all of the first ten plus its half of the shared ten.
	// (lp1's weight was registered at 1.00x and is only refreshed by a claim,
	// so the split of the shared period is exactly equal — 1.00x vs 1.00x.)
	if got2 >= sharedInflow/2+lc(1) || got2 <= sharedInflow/2-lc(1) {
		t.Fatalf("late LP got %s, want ~half of the shared inflow %s — it must not touch the first ten days (%s)",
			fmtA(got2), fmtA(sharedInflow/2), fmtA(aloneInflow))
	}
	if got1 <= aloneInflow {
		t.Fatalf("early LP got %s, less than the %s that arrived while it was alone", fmtA(got1), fmtA(aloneInflow))
	}
	// Nothing over-paid: both claims together never exceed what flowed in.
	if got1+got2 > aloneInflow+sharedInflow {
		t.Fatalf("claims %s exceed inflow %s", fmtA(got1+got2), fmtA(aloneInflow+sharedInflow))
	}
	auditPool(t, s, a)
	auditSupply(t, s)
}

// --- anti-zombie check ------------------------------------------------------

// TestDormantLiquidityIsEvictedNotConfiscated is the test the whole design
// rests on. A stranger may evict a provider who has been gone six months — and
// that provider gets back every token and every satoshi of HBD they put in.
// Nothing is taken. They simply stop being a liquidity provider.
func TestDormantLiquidityIsEvictedNotConfiscated(t *testing.T) {
	s, a, ctx := newPool(t)
	day := func(d int64) uint64 { return ctx.Height + uint64(d)*engine.HeightsPerDay }

	c1 := ctx
	c1.Sender = "hive:lp1"
	lcBefore := Balance(s, "hive:lp1")
	id1, r1 := AddLiquidity(s, a, c1, lc(100_000), lc(100_000))
	if !r1.OK {
		t.Fatalf("lp1 add: %s", r1.Msg)
	}
	c2 := ctx
	c2.Sender = "hive:lp2"
	if _, r2 := AddLiquidity(s, a, c2, lc(100_000), lc(100_000)); !r2.OK {
		t.Fatalf("lp2 add: %s", r2.Msg)
	}
	auditPool(t, s, a)

	// lp1 goes dark. A STRANGER evicts it after six months.
	stranger := ctx
	stranger.Sender = "hive:trader"
	stranger.Height = day(181)

	beforeShares := PoolShares(s)
	if res := SweepTranche(s, a, stranger, "hive:lp1", id1); !res.OK {
		t.Fatalf("evict at day 181: %s", res.Msg)
	}
	auditPool(t, s, a)

	// The position is closed and its shares have left the pool.
	if PoolShares(s) >= beforeShares {
		t.Fatalf("eviction did not reduce total shares: %d -> %d", beforeShares, PoolShares(s))
	}
	if tr, _ := GetTranche(s, "hive:lp1", id1); !tr.Closed {
		t.Fatal("evicted tranche is not closed")
	}

	// THE OWNER WAS PAID, NOT THE SWEEPER. This is the line that separates a
	// sweep from a robbery.
	if bal := Balance(s, "hive:trader"); bal != lc(100_000) {
		t.Fatalf("the sweeper was paid: balance %s, want %s", fmtA(bal), fmtA(lc(100_000)))
	}
	got := Balance(s, "hive:lp1")
	if got < lcBefore-lc(1) {
		t.Fatalf("evicted provider lost LASSECASH: %s, started with %s",
			fmtA(got), fmtA(lcBefore))
	}
	// And their HBD went back to them, not to the stranger.
	if a.Wallets["hive:trader"] != 0 {
		t.Fatalf("the sweeper received %d HBD", a.Wallets["hive:trader"])
	}
	if a.Wallets["hive:lp1"] <= 0 {
		t.Fatal("the evicted provider got no HBD back")
	}
}

// TestEvictionRefusedBeforeSixMonthsAndAfterAClaim pins the two ways this could
// hurt somebody who did nothing wrong: evicting a provider who is still inside
// their window, and ignoring a claim that proved they were there.
func TestEvictionRefusedBeforeSixMonthsAndAfterAClaim(t *testing.T) {
	s, a, ctx := newPool(t)
	day := func(d int64) uint64 { return ctx.Height + uint64(d)*engine.HeightsPerDay }

	c1 := ctx
	c1.Sender = "hive:lp1"
	id1, r := AddLiquidity(s, a, c1, lc(100_000), lc(100_000))
	if !r.OK {
		t.Fatalf("add: %s", r.Msg)
	}
	before, _ := GetTranche(s, "hive:lp1", id1)

	stranger := ctx
	stranger.Sender = "hive:trader"

	// Day 179: one day short. Refused, and nothing moves.
	stranger.Height = day(179)
	if res := SweepTranche(s, a, stranger, "hive:lp1", id1); res.OK {
		t.Fatal("evicted a tranche one day before it was dormant")
	}
	if now, _ := GetTranche(s, "hive:lp1", id1); now.Closed || now.Shares != before.Shares {
		t.Fatal("a refused eviction still changed the tranche")
	}

	// The owner claims at day 179 — proof of life, clock resets.
	c1.Height = day(179)
	ClaimPoolRewards(s, c1, id1)

	// Day 300 is 121 days after that claim, so still inside the window.
	stranger.Height = day(300)
	if res := SweepTranche(s, a, stranger, "hive:lp1", id1); res.OK {
		t.Fatal("claiming did not reset the dormancy clock")
	}
	if now, _ := GetTranche(s, "hive:lp1", id1); now.Closed {
		t.Fatal("an active provider was evicted")
	}
	auditPool(t, s, a)
}

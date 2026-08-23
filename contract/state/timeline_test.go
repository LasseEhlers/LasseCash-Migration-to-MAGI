package state

import (
	"sort"
	"strings"
	"testing"

	"github.com/lassecash/engine"
)

// Time-travel tests.
//
// A mint can live 1,215 days — 3 years locked, 30 days grace, 90 days bleeding
// to zero — and Good Accounting stretches that to 2,280. Nobody is going to sit
// and watch that happen, so the only way to test the long tail is to jump the
// clock and inspect the wreckage.
//
// THE PROPERTY THAT MAKES JUMPING LEGITIMATE is that emission and yield are
// CLOSED-FORM FUNCTIONS OF HEIGHT, settled as a difference between the last
// settled height and now (see CLAUDE.md, "Block time & height semantics"). A
// contract may run irregularly, or not at all for years, and the arithmetic
// must not care. So skipping a million heights is not an approximation of what
// the chain would do — it IS what the chain does.
//
// That claim is load-bearing, so `TestTimeTravelIsPathIndependent` verifies it
// directly rather than trusting it: the same scenario is run at wildly
// different settle granularities and the resulting state must be byte-identical.
// If that test ever fails, every other time-travel test here becomes worthless
// and the bug is in the settlement math, not the harness.

const day = uint64(engine.HeightsPerDay)

// world is a chain plus a clock you can move.
type world struct {
	s   *MemStore
	ctx Ctx
}

func newWorld(t *testing.T) *world {
	t.Helper()
	s, ctx := newChain(t)
	return &world{s: s, ctx: ctx}
}

// warp moves to an absolute height, settling on arrival.
//
// Settling is what a real transaction at that height would trigger, so this is
// the honest way to move time: nothing accrues until something touches it.
func (w *world) warp(t *testing.T, height uint64) {
	t.Helper()
	w.ctx.Height = height
	// A real client calls the permissionless `advance` entrypoint until the
	// accumulator is current; AccrueFully is that loop.
	AccrueFully(w.s, height)
}

// warpDays moves forward from genesis by whole days.
func (w *world) warpDays(t *testing.T, days uint64) { w.warp(t, genesis+days*day) }

// dump renders the entire state as a stable, comparable string.
func (w *world) dump() string {
	keys := w.s.Keys()
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		if v := w.s.Get(k); v != nil && *v != "" {
			b.WriteString(k)
			b.WriteByte('=')
			b.WriteString(*v)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// TestTimeTravelIsPathIndependent is the test that licenses all the others.
//
// Three chains live the same three years. One is settled every single day, one
// monthly, one not at all until the very last moment. If settlement were
// path-dependent — accumulating per tick, or rounding per visit — they would
// drift apart, and every long-horizon result in this file would be fiction.
//
// It also proves something the real chain needs: an account nobody touches for
// years is not cheated, and a busy account is not paid extra for being busy.
func TestTimeTravelIsPathIndependent(t *testing.T) {
	const years = 3
	end := uint64(years * 365)

	build := func(step uint64) string {
		w := newWorld(t)
		if r := creditLiquid(w.s, "alice", lc(100_000)); !r.OK {
			t.Fatalf("migrate: %s", r.Msg)
		}
		if _, r := CreateMint(w.s, at(w.ctx, "alice", genesis), lc(50_000), 1095); !r.OK {
			t.Fatalf("mint: %s", r.Msg)
		}
		if step == 0 { // one single jump to the end
			w.warpDays(t, end)
			return w.dump()
		}
		for d := step; d <= end; d += step {
			w.warpDays(t, d)
		}
		w.warpDays(t, end)
		return w.dump()
	}

	daily := build(1)
	monthly := build(30)
	oneJump := build(0)

	if daily != monthly {
		t.Errorf("settling daily and monthly disagree — settlement is path dependent\n%s",
			firstDiff(daily, monthly))
	}
	if daily != oneJump {
		t.Errorf("settling daily and jumping once disagree — the chain would pay a\n"+
			"different amount to an account that simply went quiet\n%s",
			firstDiff(daily, oneJump))
	}
}

// firstDiff reports the first differing line, which is far easier to read than
// two multi-kilobyte state dumps.
func firstDiff(a, b string) string {
	as, bs := strings.Split(a, "\n"), strings.Split(b, "\n")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var x, y string
		if i < len(as) {
			x = as[i]
		}
		if i < len(bs) {
			y = bs[i]
		}
		if x != y {
			return "  first difference:\n    A: " + x + "\n    B: " + y
		}
	}
	return "  (no line differs; lengths differ)"
}

// mintLife walks one mint across its ENTIRE 1,215-day life and checks the
// figures at every boundary that has a rule attached to it.
//
// These are the days where an off-by-one costs a real person real money, so
// they are named rather than sampled: a test that checks day 500 and day 700
// would pass while maturity itself was broken.
func TestMintLifeAtEveryBoundary(t *testing.T) {
	const days = 1095 // maximum lock, so every ceiling is in play

	type probe struct {
		day  uint64
		name string
		// recovery is the early-end recovery percentage, in whole percent.
		recovery int64
		// bleed is the fraction of value still intact, in whole percent.
		bleed int64
	}
	probes := []probe{
		{0, "the moment it is created", 50, 100},
		{1, "day one — half is forfeit", 50, 100},
		{547, "halfway — recovery is halfway too", 74, 100},
		{1094, "one day short of maturity", 99, 100},
		{days, "MATURITY — full principal, all yield", 100, 100},
		{days + 1, "grace: nothing happens yet", 100, 100},
		{days + 30, "a month into grace — still whole", 100, 100},
		{days + 89, "last day of grace", 100, 100},
		{days + 90, "GRACE ENDS — the bleed starts", 100, 100},
		{days + 90 + 45, "halfway through the bleed", 100, 50},
		{days + 90 + 89, "one day from zero", 100, 1},
		{days + 90 + 90, "LIQUIDATION — worth nothing", 100, 0},
		{days + 90 + 200, "long past zero, still zero", 100, 0},
	}

	w := newWorld(t)
	if r := creditLiquid(w.s, "alice", lc(100_000)); !r.OK {
		t.Fatalf("migrate: %s", r.Msg)
	}
	id, r := CreateMint(w.s, at(w.ctx, "alice", genesis), lc(50_000), days)
	if !r.OK {
		t.Fatalf("mint: %s", r.Msg)
	}
	m, _ := GetMint(w.s, "alice", id)

	for _, p := range probes {
		h := genesis + p.day*day
		if got := m.EarlyEndRecovery(h) * 100 / engine.Unit; got != p.recovery {
			t.Errorf("day %d (%s): recovery %d%%, want %d%%", p.day, p.name, got, p.recovery)
		}
		if got := m.BleedRemaining(h) * 100 / engine.Unit; got != p.bleed {
			t.Errorf("day %d (%s): %d%% intact, want %d%%", p.day, p.name, got, p.bleed)
		}
	}
}

// TestBleedActuallyTakesTheMoney checks the CONSEQUENCE, not just the curve.
//
// A correct percentage that nobody applies is worth nothing. This claims the
// same mint at several points and asserts the bleed really does reduce the
// payout, and that every token withheld went to the L-Share reward pool rather
// than evaporating.
//
// NOTE THE BASELINE: the peak payout is at the END OF GRACE, not at maturity.
// That is not a bug in this test — see TestYieldContinuesPastMaturity.
func TestBleedActuallyTakesTheMoney(t *testing.T) {
	const days = 30

	claimAfter := func(wait uint64) (paid, pool engine.Amount) {
		w := newWorld(t)
		if r := creditLiquid(w.s, "alice", lc(10_000)); !r.OK {
			t.Fatalf("migrate: %s", r.Msg)
		}
		id, r := CreateMint(w.s, at(w.ctx, "alice", genesis), lc(10_000), days)
		if !r.OK {
			t.Fatalf("mint: %s", r.Msg)
		}
		h := genesis + (days+wait)*day
		w.warp(t, h)
		before := Balance(w.s, "alice")
		if r := ClaimMint(w.s, at(w.ctx, "alice", h), id); !r.OK {
			t.Fatalf("claim %d days after maturity: %s", wait, r.Msg)
		}
		return Balance(w.s, "alice") - before, PoolLShare(w.s)
	}

	// GraceDays widened 30 -> 90 on 2026-08-22: grace now ends at day 90 and
	// the bleed reaches zero at day 180.
	graceEnd, poolGraceEnd := claimAfter(90)
	midBleed, poolMidBleed := claimAfter(135)
	fullyBled, poolFullyBled := claimAfter(180)
	longAfter, _ := claimAfter(400)

	if graceEnd <= 0 {
		t.Fatal("claiming at the end of grace paid nothing")
	}
	if midBleed >= graceEnd {
		t.Errorf("mid-bleed paid %s, which is not less than %s at the end of grace",
			fmtA(midBleed), fmtA(graceEnd))
	}
	if fullyBled != 0 {
		t.Errorf("claiming at full liquidation paid %s, want nothing", fmtA(fullyBled))
	}
	if longAfter != 0 {
		t.Errorf("claiming long after liquidation paid %s, want nothing", fmtA(longAfter))
	}
	// Nothing may evaporate: what the minter lost, the reward pool kept.
	if !(poolFullyBled > poolMidBleed && poolMidBleed > poolGraceEnd) {
		t.Errorf("bled value did not stay in the L-Share pool: grace=%s mid=%s zero=%s",
			fmtA(poolGraceEnd), fmtA(poolMidBleed), fmtA(poolFullyBled))
	}
}

// TestYieldStopsAtMaturity — DECIDED BY LASSE 2026-08-21.
//
// A matured mint has served its commitment. It must stop drawing from the
// L-Share pool, or the 30-day grace period becomes a risk-free bonus that
// every rational minter farms while diluting the people still locked in.
//
// Before the accrual rewrite, yield ran until the mint was CLAIMED, so waiting
// out grace always paid more than claiming at maturity — at every level of
// share concentration. Now the accumulator is frozen at the mint's maturity
// checkpoint and the shares leave the active denominator, so waiting earns
// exactly nothing extra.
//
// Grace is once again what CLAUDE.md always said it was: a safety net that
// costs nothing, not a reward for inattention.
func TestYieldStopsAtMaturity(t *testing.T) {
	const days = 30

	w := newWorld(t)
	if r := creditLiquid(w.s, "alice", lc(10_000)); !r.OK {
		t.Fatalf("migrate: %s", r.Msg)
	}
	id, r := CreateMint(w.s, at(w.ctx, "alice", genesis), lc(10_000), days)
	if !r.OK {
		t.Fatalf("mint: %s", r.Msg)
	}

	w.warpDays(t, days+1) // maturity day complete, checkpoint written
	atMaturity := PendingYield(w.s, "alice", id, w.ctx.Height)
	if atMaturity <= 0 {
		t.Fatal("a matured mint earned no yield at all")
	}

	for _, wait := range []uint64{30, 75, 120, 400} {
		w.warpDays(t, days+wait)
		if got := PendingYield(w.s, "alice", id, w.ctx.Height); got != atMaturity {
			t.Errorf("%d days after maturity the yield is %s, but it was frozen at %s.\n"+
				"A matured mint must stop earning — otherwise grace is a bonus, not a safety net.",
				wait, fmtA(got), fmtA(atMaturity))
		}
	}
}

// The bleed still applies to that frozen yield, so waiting is never free.
func TestWaitingPastGraceStillLosesMoney(t *testing.T) {
	const days = 30

	claimAfter := func(wait uint64) engine.Amount {
		w := newWorld(t)
		creditLiquid(w.s, "alice", lc(10_000))
		id, _ := CreateMint(w.s, at(w.ctx, "alice", genesis), lc(10_000), days)
		h := genesis + (days+wait)*day
		w.warp(t, h)
		before := Balance(w.s, "alice")
		if r := ClaimMint(w.s, at(w.ctx, "alice", h), id); !r.OK {
			t.Fatalf("claim: %s", r.Msg)
		}
		return Balance(w.s, "alice") - before
	}

	graceEnd, midBleed, zero := claimAfter(90), claimAfter(135), claimAfter(180)
	if !(graceEnd > midBleed && midBleed > zero) {
		t.Errorf("the bleed did not bite: graceEnd=%s midBleed=%s zero=%s",
			fmtA(graceEnd), fmtA(midBleed), fmtA(zero))
	}
	if zero != 0 {
		t.Errorf("a fully bled mint paid %s, want nothing", fmtA(zero))
	}
}

// The zombie problem, and its fix (Lasse, 2026-08-21). Claiming was the only
// path that recycled a mint's value and released its shares, so a dead
// account's fully-bled position stranded its principal outside the reward
// pool forever and kept voting with its `shr_` weight forever. SweepMint
// closes such positions permissionlessly — and ONLY such positions.
func TestSweepMintReleasesDeadPositions(t *testing.T) {
	w := newWorld(t)
	if r := creditLiquid(w.s, "hive:dead", lc(300_000)); !r.OK {
		t.Fatal(r.Msg)
	}
	creditLiquid(w.s, "hive:sweeper", lc(10))
	id, r := CreateMint(w.s, at(w.ctx, "hive:dead", genesis), lc(200_000), 30)
	if !r.OK {
		t.Fatal(r.Msg)
	}
	sweep := func(day uint64) Result {
		w.warpDays(t, day)
		return SweepMint(w.s, at(w.ctx, "hive:sweeper", w.ctx.Height), "hive:dead", id)
	}

	// While ANY value survives, the sweep must refuse: locked, mature, in
	// grace, and mid-bleed are all still the owner's property.
	for _, d := range []uint64{1, 29, 30, 31, 30 + 29, 30 + 31, 30 + 30 + 45} {
		if res := sweep(d); res.OK {
			t.Fatalf("day %d: swept a mint that still held value", d)
		}
	}
	// Voting power, however, is ALREADY gone: the walk retires `shr_` at
	// maturity regardless of claims or sweeps (Lasse: all voting power ends
	// 100% at maturity). The sweep's job is the stranded VALUE only.
	if SharesOf(w.s, "hive:dead") != 0 {
		t.Fatal("matured shares still voting; the walk must retire them at maturity")
	}

	// One day past bleed-zero (30d lock + 90d grace + 90d bleed), the owner is
	// owed exactly nothing, and now — and only now — anyone may close it.
	poolBefore := PoolLShare(w.s)
	res := sweep(30 + 90 + 90 + 1)
	if !res.OK {
		t.Fatalf("sweep at liquidation refused: %s", res.Msg)
	}
	if SharesOf(w.s, "hive:dead") != 0 {
		t.Fatal("shares reappeared or went negative at sweep")
	}
	if Balance(w.s, "hive:sweeper") != lc(10) {
		t.Fatal("the sweeper was paid; sweeping must pay the caller nothing")
	}
	if PoolLShare(w.s) <= poolBefore {
		t.Fatal("the stranded principal did not reach the reward pool")
	}
	if m, _ := GetMint(w.s, "hive:dead", id); !m.Ended {
		t.Fatal("mint not marked ended")
	}
	if res := SweepMint(w.s, at(w.ctx, "hive:sweeper", w.ctx.Height), "hive:dead", id); res.OK {
		t.Fatal("second sweep of the same mint accepted")
	}
	auditSupply(t, w.s)
}

// Good Accounting extends the timeline; the sweep must respect the extension
// to the day. Its grace is deliberately finite so that key-loss cannot strand
// principal — the sweep is the mechanism that completes that intent.
func TestSweepMintRespectsGoodAccounting(t *testing.T) {
	w := newWorld(t)
	creditLiquid(w.s, "hive:dead", lc(50_000))
	id, r := CreateMint(w.s, at(w.ctx, "hive:dead", genesis), lc(50_000), 40)
	if !r.OK {
		t.Fatal(r.Msg)
	}
	// Arm inside the grace month after maturity.
	w.warpDays(t, 41)
	if res := ArmGoodAccounting(w.s, at(w.ctx, "hive:dead", w.ctx.Height), id); !res.OK {
		t.Fatalf("arm: %s", res.Msg)
	}
	// Deep in the 1095-day grace, and mid-extended-bleed, value remains.
	for _, d := range []uint64{40 + 1000, 40 + 1095 + 45} {
		w.warpDays(t, d)
		if res := SweepMint(w.s, at(w.ctx, "hive:x", w.ctx.Height), "hive:dead", id); res.OK {
			t.Fatalf("day %d: swept inside the Good Accounting timeline", d)
		}
	}
	// Day 40 + 1095 + 90 + 1: fully liquidated even under Good Accounting.
	w.warpDays(t, 40+1095+90+1)
	if res := SweepMint(w.s, at(w.ctx, "hive:x", w.ctx.Height), "hive:dead", id); !res.OK {
		t.Fatalf("sweep after GA liquidation refused: %s", res.Msg)
	}
	auditSupply(t, w.s)
}

// The migration day in miniature: many accounts' mints maturing on the SAME
// day, more than one walk call's retirement budget covers. The walk must stop
// mid-day, resume on the next call, retire every account exactly once, and
// keep the accumulator byte-identical to a chain that crossed the day in one
// sweep — the path-independence guarantee extended to heavy days.
func TestExpiryDrainResumesAcrossWalkCalls(t *testing.T) {
	const accounts = 2*MaxRetirePerWalk + 7 // forces at least three walk calls
	w := newWorld(t)
	for i := 0; i < accounts; i++ {
		a := "hive:m" + encU64(uint64(i))
		creditLiquid(w.s, a, lc(100))
		if _, r := CreateMint(w.s, at(w.ctx, a, genesis), lc(100), 30); !r.OK {
			t.Fatal(r.Msg)
		}
	}

	// Walk far past maturity. AccrueFully loops Accrue exactly like repeated
	// permissionless `advance` calls would, so the budget genuinely bites.
	calls := 0
	target := genesis + 40*day
	for !Accrue(w.s, target) {
		calls++
		if calls > 200 {
			t.Fatal("walk never completed — drain cursor is stuck")
		}
	}
	if calls < 2 {
		t.Fatalf("only %d extra walk calls — budget did not bite; test is vacuous", calls)
	}

	for i := 0; i < accounts; i++ {
		a := "hive:m" + encU64(uint64(i))
		if got := SharesOf(w.s, a); got != 0 {
			t.Fatalf("%s still votes with %d after maturity", a, got)
		}
	}
	if TotalShares(w.s) != 0 {
		t.Fatalf("active total %d, want 0", TotalShares(w.s))
	}
	// Every chunk, count and cursor row must be gone — no residue rows.
	for _, k := range w.s.Keys() {
		if strings.HasPrefix(k, "expl") {
			if v := w.s.Get(k); v != nil && *v != "" {
				t.Fatalf("expiry-list residue: %s=%s", k, *v)
			}
		}
	}
	auditSupply(t, w.s)
}

// A user's transaction carries only UserRetireBudget across a heavy day: it
// must stop cheaply (after at most two chunks) and leave the rest to
// `advance`, whose MaxRetirePerWalk slices finish the day. Pins the devnet
// finding of 2026-08-22 — a mint that absorbed a 200-slice and then refused
// wasted more RC than a fresh account owns.
func TestUserCallsCarryOnlyASmallRetireBudget(t *testing.T) {
	const accounts = 4 * UserRetireBudget // several chunks on one day
	w := newWorld(t)
	for i := 0; i < accounts; i++ {
		a := "hive:u" + encU64(uint64(i))
		creditLiquid(w.s, a, lc(100))
		if _, r := CreateMint(w.s, at(w.ctx, a, genesis), lc(100), 30); !r.OK {
			t.Fatal(r.Msg)
		}
	}
	target := genesis + 31*day
	// One user-path walk: must NOT complete, and must have retired at most
	// UserRetireBudget accounts.
	if Accrue(w.s, target) {
		t.Fatal("a user walk must not drain a heavy day by itself")
	}
	retired := 0
	for i := 0; i < accounts; i++ {
		if SharesOf(w.s, "hive:u"+encU64(uint64(i))) == 0 {
			retired++
		}
	}
	if retired == 0 || retired > UserRetireBudget {
		t.Fatalf("user walk retired %d, want 1..%d", retired, UserRetireBudget)
	}
	// `advance` finishes it in bounded slices.
	calls := 0
	for !AccrueSteps(w.s, target, 0) {
		calls++
		if calls > 100 {
			t.Fatal("advance never completed")
		}
	}
	if TotalShares(w.s) != 0 {
		t.Fatalf("active total %d after advance, want 0", TotalShares(w.s))
	}
	if UserRetireBudget%ExpiryChunkSize != 0 || MaxRetirePerWalk%ExpiryChunkSize != 0 {
		t.Fatal("retire budgets must be multiples of ExpiryChunkSize or the walk wedges")
	}
	auditSupply(t, w.s)
}

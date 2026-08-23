package engine

import (
	"math/big"
	"testing"
)

const gen = uint64(109_200_000)

func defaultParams(height uint64) MintParams {
	return MintParams{
		VolumeStart: LC(10_000),
		VolumeEnd:   LC(100_000),
		ShareRate:   ShareRate(gen, height),
	}
}

// --- multipliers ----------------------------------------------------------

func TestDurationMultiplierEndpoints(t *testing.T) {
	if got := DurationMultiplier(1); got != MultScale {
		t.Fatalf("1 day: got %d want %d (1.0x)", got, MultScale)
	}
	if got := DurationMultiplier(MaxMintDays); got != MultScale+MaxDurationBonus {
		t.Fatalf("1095 days: got %d want %d (1.5x)", got, MultScale+MaxDurationBonus)
	}
	// Out-of-range must clamp, never extrapolate past 1.5x.
	if got := DurationMultiplier(99_999); got != MultScale+MaxDurationBonus {
		t.Fatalf("overlong: got %d, must clamp to 1.5x", got)
	}
	if got := DurationMultiplier(0); got != MultScale {
		t.Fatalf("zero days: got %d, must clamp to 1.0x", got)
	}
	// Monotonic, and never above the ceiling.
	prev := int64(0)
	for d := int64(1); d <= MaxMintDays; d++ {
		m := DurationMultiplier(d)
		if m < prev {
			t.Fatalf("day %d: multiplier decreased %d -> %d", d, prev, m)
		}
		if m > MultScale+MaxDurationBonus {
			t.Fatalf("day %d: multiplier %d exceeds 1.5x ceiling", d, m)
		}
		prev = m
	}
}

func TestVolumeMultiplierEndpoints(t *testing.T) {
	start, end := LC(10_000), LC(100_000)
	cases := []struct {
		amount Amount
		want   int64
		label  string
	}{
		{LC(1), MultScale, "tiny"},
		{start, MultScale, "at start = no bonus"},
		{end, MultScale + MaxVolumeBonus, "at end = 1.5x"},
		{LC(1_000_000), MultScale + MaxVolumeBonus, "far above end clamps"},
		{LC(55_000), MultScale + MaxVolumeBonus/2, "midpoint = 1.25x"},
	}
	for _, c := range cases {
		if got := VolumeMultiplier(c.amount, start, end); got != c.want {
			t.Fatalf("%s (%s): got %d want %d", c.label, fmtLC(c.amount), got, c.want)
		}
	}
	// Near the supply cap the naive product would overflow int64.
	if got := VolumeMultiplier(HistoricHardCap, start, end); got != MultScale+MaxVolumeBonus {
		t.Fatalf("cap-sized mint: got %d, want clamped 1.5x", got)
	}
}

// The headline promise: max size AND max duration = 2.25x, multiplicative.
func TestMaxCombinedMultiplierIs225x(t *testing.T) {
	p := defaultParams(gen)
	principal := LC(100_000)

	maxShares, ok := ComputeShares(principal, MaxMintDays, p)
	if !ok {
		t.Fatal("max mint failed")
	}
	minShares, ok := ComputeShares(principal, 1, MintParams{
		VolumeStart: LC(10_000), VolumeEnd: LC(100_000), ShareRate: p.ShareRate,
	})
	if !ok {
		t.Fatal("min-duration mint failed")
	}
	// Same principal (so same 1.5x volume bonus); only duration differs.
	// Ratio should be exactly 1.5x.
	ratio := float64(maxShares) / float64(minShares)
	if ratio < 1.4999 || ratio > 1.5001 {
		t.Fatalf("duration-only ratio %.6f, want 1.5", ratio)
	}

	// Now the full 2.25x: smallest-bonus mint vs biggest-bonus mint.
	baseline, _ := ComputeShares(LC(10_000), 1, p)
	// Scale baseline up to the same principal so we compare bonus, not size.
	scaled, _ := MulDiv(Amount(baseline), 10, 1) // 10k -> 100k
	got := float64(maxShares) / float64(scaled)
	if got < 2.2499 || got > 2.2501 {
		t.Fatalf("combined multiplier %.6f, want 2.25 (1.5 x 1.5 multiplicative)", got)
	}
}

// --- share rate -----------------------------------------------------------

func TestShareRateRatchetsUpOnly(t *testing.T) {
	prev := Amount(0)
	step := uint64(HeightsPerDay * 7)
	for h := gen; h < gen+80*HeightsPerYear; h += step {
		r := ShareRate(gen, h)
		if r < prev {
			t.Fatalf("height %d: share rate DECREASED %s -> %s", h, fmtLC(prev), fmtLC(r))
		}
		prev = r
	}
	if got := ShareRate(gen, gen); got != GenesisShareRate {
		t.Fatalf("at genesis: got %s want %s", fmtLC(got), fmtLC(GenesisShareRate))
	}
	// Before genesis must not underflow or ratchet.
	if got := ShareRate(gen, gen-1_000_000); got != GenesisShareRate {
		t.Fatalf("pre-genesis: got %s, want genesis rate", fmtLC(got))
	}
}

func TestShareRateCompounds7Percent(t *testing.T) {
	oneYear := ShareRate(gen, gen+HeightsPerYear)
	want := Amount(107_000_000) // 1.07 LC
	if oneYear != want {
		t.Fatalf("after 1 year: got %s want %s", fmtLC(oneYear), fmtLC(want))
	}
	// Compounding, not linear: year 2 must exceed 1.14.
	twoYear := ShareRate(gen, gen+2*HeightsPerYear)
	if twoYear <= Amount(114_000_000) {
		t.Fatalf("after 2 years: got %s, expected >1.14 (compounding)", fmtLC(twoYear))
	}
	t.Logf("share rate: y1=%s y2=%s y10=%s y75=%s",
		fmtLC(oneYear), fmtLC(twoYear),
		fmtLC(ShareRate(gen, gen+10*HeightsPerYear)),
		fmtLC(ShareRate(gen, gen+75*HeightsPerYear)))
}

// No cliff on the anniversary that a minter could game by waiting one day.
func TestShareRateHasNoAnniversaryCliff(t *testing.T) {
	before := ShareRate(gen, gen+HeightsPerYear-HeightsPerDay)
	at := ShareRate(gen, gen+HeightsPerYear)
	after := ShareRate(gen, gen+HeightsPerYear+HeightsPerDay)
	jump := at - before
	nextDay := after - at
	// The step across the anniversary must be comparable to an ordinary day.
	if jump > nextDay*3 {
		t.Fatalf("anniversary cliff: day-before->anniversary jumped %s "+
			"but the next day only moved %s", fmtLC(jump), fmtLC(nextDay))
	}
}

// The HBD conversion is the spot price applied to the rate — the opening-pool
// worked example from CLAUDE.md: 1,030 HBD against 1,000,000 LC prices one
// genesis share at 0.00103 HBD.
func TestShareRateInHbdUsesSpotPrice(t *testing.T) {
	lcRes, hbdRes := LC(1_000_000), Amount(1_030*Unit)
	got, ok := ShareRateInHbd(gen, gen, lcRes, hbdRes)
	if !ok || got != Amount(103_000) { // 0.00103000 in 8dp base units
		t.Fatalf("genesis share in HBD: got %s ok=%v, want 0.00103000", fmtLC(got), ok)
	}
	// One year in, the HBD figure ratchets exactly with the LC rate.
	y1, ok := ShareRateInHbd(gen, gen+HeightsPerYear, lcRes, hbdRes)
	if !ok || y1 != Amount(110_210) { // 0.00103 * 1.07
		t.Fatalf("year-1 share in HBD: got %s ok=%v, want 0.00110210", fmtLC(y1), ok)
	}
	// An unseeded pool has no price; it must refuse, not divide by zero.
	if _, ok := ShareRateInHbd(gen, gen, 0, hbdRes); ok {
		t.Fatal("empty pool must return ok=false")
	}
}

// --- early end ------------------------------------------------------------

func TestEarlyEndRecoveryRises50To100(t *testing.T) {
	m, ok := NewMint("alice", LC(50_000), MaxMintDays, gen, defaultParams(gen))
	if !ok {
		t.Fatal("mint failed")
	}
	if got := m.EarlyEndRecovery(gen); got != MinEarlyEndRecovery {
		t.Fatalf("day 0: recovery %d, want %d (50%%)", got, MinEarlyEndRecovery)
	}
	if got := m.EarlyEndRecovery(m.MaturityHeight()); got != MultScale {
		t.Fatalf("at maturity: recovery %d, want %d (100%%)", got, MultScale)
	}
	// Halfway should be ~75%.
	mid := m.StartHeight + (m.MaturityHeight()-m.StartHeight)/2
	want := MinEarlyEndRecovery + (MultScale-MinEarlyEndRecovery)/2
	if got := m.EarlyEndRecovery(mid); got < want-100 || got > want+100 {
		t.Fatalf("halfway: recovery %d, want ~%d (75%%)", got, want)
	}
	// Monotonic increasing — the whole point of the correction.
	prev := int64(0)
	for h := m.StartHeight; h <= m.MaturityHeight(); h += HeightsPerDay {
		r := m.EarlyEndRecovery(h)
		if r < prev {
			t.Fatalf("height %d: recovery DECREASED %d -> %d "+
				"(penalty must shrink as commitment grows)", h, prev, r)
		}
		prev = r
	}
}

// --- bleed ----------------------------------------------------------------

func TestBleedTimeline(t *testing.T) {
	m, _ := NewMint("bob", LC(20_000), 365, gen, defaultParams(gen))
	mat := m.MaturityHeight()

	checks := []struct {
		days int64
		want int64
		msg  string
	}{
		{0, MultScale, "at maturity: untouched"},
		{89, MultScale, "day 89: still in grace"},
		{90, MultScale, "day 90: grace boundary, still whole"},
		{135, MultScale / 2, "day 135: halfway through bleed"},
		{180, 0, "day 180: fully liquidated"},
		{260, 0, "day 260: stays at zero"},
	}
	for _, c := range checks {
		h := mat + uint64(c.days)*HeightsPerDay
		got := m.BleedRemaining(h)
		// Allow a base-unit of slack on the interpolated midpoint.
		if got < c.want-200 || got > c.want+200 {
			t.Fatalf("%s: remaining %d, want ~%d", c.msg, got, c.want)
		}
	}
}

// Good Accounting EXTENDS the grace to 3 years — it does not disable the bleed.
// A finite window matters: an infinite hold would strand the principal of
// anyone who lost their keys, permanently starving the recycling engine.
func TestGoodAccountingExtendsGraceToThreeYears(t *testing.T) {
	m, _ := NewMint("carol", LC(30_000), 365, gen, defaultParams(gen))
	m.GoodAccounting = true
	mat := m.MaturityHeight()

	// Safe for the whole 3-year window — four tax years to choose from.
	for _, days := range []int64{0, 30, 120, 365, 730, 1000, 1095} {
		h := mat + uint64(days)*HeightsPerDay
		if got := m.BleedRemaining(h); got != MultScale {
			t.Fatalf("good accounting, %d days past maturity: remaining %d, "+
				"want untouched (%d)", days, got, MultScale)
		}
	}
	// Then the ordinary 90-day bleed runs.
	mid := mat + uint64(GoodAccountingGraceDays+45)*HeightsPerDay
	if got := m.BleedRemaining(mid); got > MultScale/2+200 || got < MultScale/2-200 {
		t.Fatalf("45 days into the bleed: remaining %d, want ~50%%", got)
	}
	// And it does reach zero, so abandoned keys eventually recycle.
	end := m.LiquidationHeight()
	if got := m.BleedRemaining(end); got != 0 {
		t.Fatalf("at liquidation height: remaining %d, want 0", got)
	}
	if got := m.BleedRemaining(end + 100*HeightsPerDay); got != 0 {
		t.Fatalf("past liquidation: remaining %d, want 0", got)
	}

	days := (m.LiquidationHeight() - mat) / HeightsPerDay
	t.Logf("good accounting: safe %d days, fully liquidated %d days after maturity",
		GoodAccountingGraceDays, days)

	// A normal mint liquidates at day 180: 90 days grace, then the 90-day
	// bleed. (Grace was widened from 30 to 90 on 2026-08-22 — see GraceDays.)
	n, _ := NewMint("dan", LC(30_000), 365, gen, defaultParams(gen))
	if got := (n.LiquidationHeight() - n.MaturityHeight()) / HeightsPerDay; got != 180 {
		t.Fatalf("normal mint liquidates after %d days, want 180", got)
	}
}

// The arming window is the grace period AFTER maturity — 90 days since
// 2026-08-22: decide while the position is mature and whole, never while
// bleeding.
func TestGoodAccountingArmWindow(t *testing.T) {
	m, _ := NewMint("dave", LC(30_000), 365, gen, defaultParams(gen))
	mat := m.MaturityHeight()

	cases := []struct {
		h    uint64
		want bool
		msg  string
	}{
		{m.StartHeight, false, "at creation: too early"},
		{mat - HeightsPerDay, false, "1 day before maturity: nothing to decide yet"},
		{mat, true, "at maturity: window opens"},
		{mat + 30*HeightsPerDay, true, "a month past maturity: still allowed"},
		{mat + 89*HeightsPerDay, true, "last day of grace: allowed"},
		{mat + 90*HeightsPerDay, true, "grace boundary height: still whole per BleedRemaining, so still allowed"},
		{mat + 90*HeightsPerDay + 1, false, "one height into the bleed: TOO LATE"},
		{mat + 120*HeightsPerDay, false, "mid-bleed: cannot retroactively opt out"},
	}
	for _, c := range cases {
		if got := m.CanArmGoodAccounting(c.h); got != c.want {
			t.Fatalf("%s: got %v want %v", c.msg, got, c.want)
		}
	}

	// Already armed, or already ended, must refuse.
	armed := m
	armed.GoodAccounting = true
	if armed.CanArmGoodAccounting(mat) {
		t.Fatal("already armed: must not re-arm")
	}
	ended := m
	ended.Ended = true
	if ended.CanArmGoodAccounting(mat) {
		t.Fatal("ended mint: must not arm")
	}
}

// CanArmGoodAccounting and BleedRemaining must never disagree about whether
// a height is bleeding: "cannot arm once bleeding" only means something if
// the two functions share one boundary. Swept across the arm window and
// past it, at every height, not just the ones the earlier test happened to
// sample — this is exactly the class of one-height mismatch a sampled test
// can miss. Found by review 2026-08-24, before genesis.
func TestGoodAccountingArmBoundaryAgreesWithBleedRemaining(t *testing.T) {
	m, _ := NewMint("erin", LC(30_000), 365, gen, defaultParams(gen))
	mat := m.MaturityHeight()
	for days := int64(85); days <= 95; days++ {
		h := mat + uint64(days)*HeightsPerDay
		bleeding := m.BleedRemaining(h) < MultScale
		canArm := m.CanArmGoodAccounting(h)
		if bleeding && canArm {
			t.Fatalf("day %d: already bleeding (remaining %d) yet arming still allowed",
				days, m.BleedRemaining(h))
		}
		if !bleeding && !canArm {
			t.Fatalf("day %d: not bleeding (remaining %d) yet arming refused",
				days, m.BleedRemaining(h))
		}
	}
}

// BleedRemaining must floor, matching the project-wide "rounding always
// floors" rule: the surviving fraction is never rounded up in the holder's
// favor. Independently checked two ways: against a big.Rat computation of
// the exact mathematical floor (not just a re-typed copy of the production
// formula), and against the OLD `MultScale - floor(bled)` formula, which
// must now read STRICTLY LOWER whenever the fraction isn't exact — proving
// the fix actually moved the result, not just that it type-checks.
func TestBleedRemainingFloors(t *testing.T) {
	m, _ := NewMint("frank", LC(100_000_000), 365, gen, defaultParams(gen))
	mat := m.MaturityHeight()
	graceEnd := mat + uint64(GraceDays)*HeightsPerDay
	bleedSpan := uint64(BleedDays) * HeightsPerDay
	sawADifference := false
	for into := uint64(1); into < bleedSpan; into += 7 {
		h := graceEnd + into
		got := m.BleedRemaining(h)

		exact := new(big.Rat).SetFrac(
			big.NewInt(int64(bleedSpan-into)*MultScale), big.NewInt(int64(bleedSpan)))
		wantFloor := new(big.Int).Div(exact.Num(), exact.Denom())
		if got != wantFloor.Int64() {
			t.Fatalf("into=%d: remaining %d, want exact floor %s", into, got, wantFloor)
		}

		oldCeil := MultScale - int64(into)*MultScale/int64(bleedSpan)
		if got > oldCeil {
			t.Fatalf("into=%d: remaining %d exceeds the old ceiling formula's %d", into, got, oldCeil)
		}
		if got < oldCeil {
			sawADifference = true
		}
	}
	if !sawADifference {
		t.Fatal("never saw the fixed formula differ from the old ceiling formula — test is not exercising the fix")
	}
}

// --- settlement conservation ---------------------------------------------

// THE critical invariant: settlement neither creates nor destroys tokens.
func TestSettlementConservesValue(t *testing.T) {
	principals := []Amount{LC(1), LC(9_999), LC(10_000), LC(55_555), LC(100_000), LC(500_000)}
	durations := []int64{1, 30, 365, 1094, 1095}
	rewards := []Amount{0, 1, LC(1), LC(1_234)}

	for _, p := range principals {
		for _, d := range durations {
			m, ok := NewMint("eve", p, d, gen, defaultParams(gen))
			if !ok {
				t.Fatalf("mint failed: principal %s days %d", fmtLC(p), d)
			}
			mat := m.MaturityHeight()
			heights := []uint64{
				m.StartHeight, m.StartHeight + HeightsPerDay,
				mat - HeightsPerDay, mat,
				mat + 30*HeightsPerDay, mat + 75*HeightsPerDay,
				mat + 120*HeightsPerDay, mat + 400*HeightsPerDay,
			}
			for _, r := range rewards {
				for _, h := range heights {
					s := m.Settle(h, r)
					want := p + r
					if s.ToOwner+s.ToRewardPool != want {
						t.Fatalf("VALUE LEAK: principal %s reward %s at height %d: "+
							"owner %s + pool %s = %s, want %s",
							fmtLC(p), fmtLC(r), h, fmtLC(s.ToOwner),
							fmtLC(s.ToRewardPool), fmtLC(s.ToOwner+s.ToRewardPool),
							fmtLC(want))
					}
					if s.ToOwner < 0 || s.ToRewardPool < 0 {
						t.Fatalf("negative settlement at height %d: %+v", h, s)
					}
				}
			}
		}
	}
}

// Ending early must always forfeit ALL rewards, at every point before maturity.
func TestEarlyEndForfeitsAllRewards(t *testing.T) {
	m, _ := NewMint("frank", LC(50_000), 1095, gen, defaultParams(gen))
	reward := LC(5_000)
	for _, frac := range []uint64{0, 1, 2, 3} {
		h := m.StartHeight + (m.MaturityHeight()-m.StartHeight)*frac/4
		s := m.Settle(h, reward)
		if !s.Early {
			t.Fatalf("height %d should be an early end", h)
		}
		if s.ToOwner > m.Principal {
			t.Fatalf("early end paid %s > principal %s — rewards leaked",
				fmtLC(s.ToOwner), fmtLC(m.Principal))
		}
	}
	// At maturity the rewards must finally be paid.
	s := m.Settle(m.MaturityHeight(), reward)
	if s.Early {
		t.Fatal("at maturity: should not be flagged early")
	}
	if s.ToOwner != m.Principal+reward {
		t.Fatalf("at maturity: paid %s, want principal+reward %s",
			fmtLC(s.ToOwner), fmtLC(m.Principal+reward))
	}
}

// --- reward share ---------------------------------------------------------

func TestRewardShareNeverOverdrawsPool(t *testing.T) {
	pool := LC(10_000)
	total := Shares(1_000 * ShareUnit)

	// Many holders splitting the pool must never exceed it.
	var paid Amount
	for i := 0; i < 10; i++ {
		paid += RewardShare(pool, Shares(100*ShareUnit), total)
	}
	if paid > pool {
		t.Fatalf("10 holders of 10%% each drew %s from a %s pool",
			fmtLC(paid), fmtLC(pool))
	}
	// Degenerate inputs must be safe, not panic or over-pay.
	if got := RewardShare(pool, 0, total); got != 0 {
		t.Fatalf("zero shares: got %s want 0", fmtLC(got))
	}
	if got := RewardShare(pool, total, 0); got != 0 {
		t.Fatalf("zero total: got %s want 0", fmtLC(got))
	}
	if got := RewardShare(pool, total*2, total); got != 0 {
		t.Fatalf("shares > total should refuse, got %s", fmtLC(got))
	}
	if got := RewardShare(pool, total, total); got != pool {
		t.Fatalf("sole holder: got %s want whole pool %s", fmtLC(got), fmtLC(pool))
	}
}

// --- mint validation ------------------------------------------------------

func TestMintRejectsInvalidInput(t *testing.T) {
	p := defaultParams(gen)
	bad := []struct {
		principal Amount
		days      int64
		label     string
	}{
		{0, 365, "zero principal"},
		{-1, 365, "negative principal"},
		{LC(100), 0, "zero days"},
		{LC(100), -5, "negative days"},
		{LC(100), MaxMintDays + 1, "over 3 years"},
	}
	for _, c := range bad {
		if _, ok := NewMint("x", c.principal, c.days, gen, p); ok {
			t.Fatalf("%s: should have been rejected", c.label)
		}
	}
	if _, ok := NewMint("x", LC(100), 365, gen, MintParams{ShareRate: 0}); ok {
		t.Fatal("zero share rate: should have been rejected")
	}
}

// --- reporting ------------------------------------------------------------

func TestReportMintExamples(t *testing.T) {
	for _, c := range []struct {
		principal Amount
		days      int64
	}{
		{LC(1_000), 1}, {LC(1_000), 1095},
		{LC(10_000), 1095}, {LC(100_000), 365}, {LC(100_000), 1095},
	} {
		p := defaultParams(gen)
		s, _ := ComputeShares(c.principal, c.days, p)
		t.Logf("%10s LC for %5d days -> %18s L-Shares  (dur %.3fx vol %.3fx)",
			fmtLC(c.principal), c.days, fmtLC(Amount(s)),
			float64(DurationMultiplier(c.days))/float64(MultScale),
			float64(VolumeMultiplier(c.principal, p.VolumeStart, p.VolumeEnd))/float64(MultScale))
	}
}

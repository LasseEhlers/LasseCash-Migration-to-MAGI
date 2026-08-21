package engine

import (
	"fmt"
	"testing"
)

func fmtLC(a Amount) string {
	neg := ""
	v := int64(a)
	if v < 0 {
		neg, v = "-", -v
	}
	return fmt.Sprintf("%s%d.%08d", neg, v/Unit, v%Unit)
}

func testSchedule() EmissionSchedule {
	s := DefaultSchedule
	s.GenesisHeight = 109_200_000 // representative snapshot height
	return s
}

// --- Invariants -----------------------------------------------------------

// The cap is the whole point. If this test ever fails, the chain is broken.
func TestNeverExceedsCap(t *testing.T) {
	s := testSchedule()
	// Probe densely early, then sparsely out to ~100,000 years.
	heights := []uint64{0, 1, s.GenesisHeight - 1, s.GenesisHeight, s.GenesisHeight + 1}
	for _, mult := range []uint64{1, 2, 3, 10, 25, 26, 30, 100, 1000, 33333} {
		heights = append(heights, s.GenesisHeight+mult*s.EraHeights)
		heights = append(heights, s.GenesisHeight+mult*s.EraHeights+s.EraHeights/2)
	}
	for _, h := range heights {
		got := s.TotalEmittedAt(h)
		if got > s.Cap {
			t.Fatalf("height %d: emitted %s exceeds cap %s", h, fmtLC(got), fmtLC(s.Cap))
		}
		if got < 0 {
			t.Fatalf("height %d: negative emission %s", h, fmtLC(got))
		}
	}
}

// Emission must never run backwards; a balance that decreases is a bug that
// would let someone claim the same tokens twice.
func TestMonotonic(t *testing.T) {
	s := testSchedule()
	var prev Amount
	step := s.EraHeights / 97 // deliberately not a divisor, to hit era edges
	for h := s.GenesisHeight; h < s.GenesisHeight+30*s.EraHeights; h += step {
		got := s.TotalEmittedAt(h)
		if got < prev {
			t.Fatalf("height %d: emission decreased %s -> %s", h, fmtLC(prev), fmtLC(got))
		}
		prev = got
	}
}

// The contract may run every 10th height, or once after a week of silence.
// Settling in many small steps must equal settling in one big step, exactly.
// If this fails, an idle chain mints a different amount than a busy one.
func TestSettlementIsPathIndependent(t *testing.T) {
	s := testSchedule()
	from := s.GenesisHeight
	to := s.GenesisHeight + 3*s.EraHeights + 12_345

	oneShot := s.EmissionBetween(from, to)

	for _, step := range []uint64{1, 10, 1000, 999_983, s.EraHeights} {
		var sum Amount
		h := from
		for h < to {
			next := h + step
			if next > to {
				next = to
			}
			sum += s.EmissionBetween(h, next)
			h = next
		}
		if sum != oneShot {
			t.Fatalf("step %d: piecewise %s != one-shot %s (diff %d units)",
				step, fmtLC(sum), fmtLC(oneShot), int64(sum-oneShot))
		}
	}
}

// Every base unit of a block reward must land in exactly one pool.
func TestSplitLosesNothing(t *testing.T) {
	cases := []Amount{0, 1, 2, 3, 7, 99, 100, 101, 31_709_791, 317_097_919,
		Amount(Unit), EmissionCap, MaxAmount / 4}
	for _, in := range cases {
		got := Split(in)
		if in <= 0 {
			if got.Total() != 0 {
				t.Fatalf("Split(%d) should be empty, got %+v", in, got)
			}
			continue
		}
		if got.Total() != in {
			t.Fatalf("Split(%s): pools total %s, want %s (lost %d units)",
				fmtLC(in), fmtLC(got.Total()), fmtLC(in), int64(in-got.Total()))
		}
		if got.LShare != got.Liquidity {
			t.Fatalf("Split(%s): L-Share %s != Liquidity %s (both are 25%%)",
				fmtLC(in), fmtLC(got.LShare), fmtLC(got.Liquidity))
		}
		// PoB is 50% plus the remainder, so it is never short-changed.
		if got.ProofOfBrain < got.LShare+got.Liquidity {
			t.Fatalf("Split(%s): PoB %s < the two 25%% pools combined",
				fmtLC(in), fmtLC(got.ProofOfBrain))
		}
	}
}

// Emission before genesis is zero — the snapshot must not retroactively mint.
func TestNothingBeforeGenesis(t *testing.T) {
	s := testSchedule()
	for _, h := range []uint64{0, 1, s.GenesisHeight - 1_000_000, s.GenesisHeight} {
		if got := s.TotalEmittedAt(h); got != 0 {
			t.Fatalf("height %d (genesis %d): expected 0, got %s", h, s.GenesisHeight, fmtLC(got))
		}
	}
	if got := s.EmissionBetween(s.GenesisHeight+100, s.GenesisHeight); got != 0 {
		t.Fatalf("reversed range should yield 0, got %s", fmtLC(got))
	}
}

// --- Overflow safety ------------------------------------------------------

func TestMulDivNoOverflow(t *testing.T) {
	// A near-cap amount times a 1.5x multiplier scaled by 1e8 would overflow
	// a naive int64 product. MulDiv must handle it.
	near := HistoricHardCap
	got, ok := MulDiv(near, 150_000_000, 100_000_000)
	if !ok {
		t.Fatal("MulDiv reported overflow on a value that fits")
	}
	want := near + near/2
	if got != want {
		t.Fatalf("MulDiv 1.5x: got %s want %s", fmtLC(got), fmtLC(want))
	}

	if _, ok := MulDiv(100, 1, 0); ok {
		t.Fatal("division by zero should report failure")
	}
	// Truncation must be toward zero, never up.
	if got, _ := MulDiv(99, 1, 100); got != 0 {
		t.Fatalf("MulDiv(99,1,100) = %d, want 0 (must floor)", got)
	}
}

// --- Derived facts (reported, not asserted blindly) -----------------------

func TestReportSchedule(t *testing.T) {
	s := testSchedule()
	if !s.Valid() {
		t.Fatal("default schedule is invalid")
	}

	end, total := s.FinalHeight()
	eras := (end - s.GenesisHeight) / s.EraHeights
	years := eras * 3

	t.Logf("genesis height      : %d", s.GenesisHeight)
	t.Logf("era length          : %d heights (%d years)", s.EraHeights, s.EraHeights/HeightsPerYear)
	t.Logf("emission ends       : height %d, era %d, year %d", end, eras, years)
	t.Logf("total ever issued   : %s LC (cap %s)", fmtLC(total), fmtLC(s.Cap))
	t.Logf("stranded to flooring: %s LC", fmtLC(s.Cap-total))

	for n := uint64(0); n < 4; n++ {
		per := s.RewardPerHeight(n)
		t.Logf("era %d: budget %s | %s LC/height | %s LC/MAGI-block (30s)",
			n+1, fmtLC(s.EraBudget(n)), fmtLC(per), fmtLC(per*MagiBlockHeights))
	}

	if total > s.Cap {
		t.Fatalf("total issuance %s exceeds cap %s", fmtLC(total), fmtLC(s.Cap))
	}

	// The whole first era must be payable without overflow.
	if got := s.TotalEmittedAt(s.GenesisHeight + s.EraHeights); got != s.EraBudget(0)/Amount(s.EraHeights)*Amount(s.EraHeights) {
		t.Fatalf("era 1 total %s does not match per-height * heights", fmtLC(got))
	}
}

// Compare reduction rates so the longevity decision is made on numbers.
func TestReportReductionOptions(t *testing.T) {
	for _, opt := range []struct {
		num, den int64
		label    string
	}{
		{1, 2, "-50% (spec)"},
		{2, 3, "-33%"},
		{3, 4, "-25%"},
		{9, 10, "-10%"},
		{19, 20, "-5%"},
	} {
		s := testSchedule()
		s.ReduceNum, s.ReduceDen = opt.num, opt.den
		end, total := s.FinalHeight()
		eras := (end - s.GenesisHeight) / s.EraHeights
		per := s.RewardPerHeight(0)
		t.Logf("%-12s era-1 budget %18s | %s LC/MAGI-block | ends year %5d | total %s",
			opt.label, fmtLC(s.EraBudget(0)), fmtLC(per*MagiBlockHeights), eras*3, fmtLC(total))
		if total > s.Cap {
			t.Fatalf("%s: total %s exceeds cap", opt.label, fmtLC(total))
		}
	}
}

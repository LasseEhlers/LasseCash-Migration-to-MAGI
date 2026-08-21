package engine

// Emission: the post-migration LASSECASH issuance schedule.
//
// HEIGHT SEMANTICS (verified against api.vsc.eco, 2026-08-20)
//
// MAGI uses Hive block numbers as its height space. Sampled transactions:
//
//	height 109,189,570 -> 2026-08-20T13:02:24
//	height 109,189,590 -> 2026-08-20T13:03:24
//	  => 20 heights / 60s = 3 seconds per height unit
//
// MAGI blocks are produced on every 10th height (witnessSchedule slot spacing
// is a constant 10, verified across heights 100,000,000..109,190,000), i.e. a
// MAGI block every 30 seconds; a round is 120 slots = 1 hour.
//
// Consequence for this module: a contract does NOT get to run once per height.
// It runs roughly every 10th height, and it may miss executions entirely if no
// transaction touches it. Therefore emission is NEVER accumulated per tick.
// It is a pure closed-form function of height, and callers settle the delta
// between the last settled height and the current one. This is correct under
// irregular execution, chain reorgs, and long idle gaps alike.

// HeightsPerSecond-related constants. Heights advance every 3 seconds.
//
// HeightsPerYear and HeightsPerEra are deliberately LITERALS rather than
// multiples of HeightsPerDay: the `testwindows` build (time_testwindows.go)
// shrinks the day so lifecycle windows compress onto a testable clock, and
// the emission schedule and the 7%/yr share-rate ratchet must NOT compress
// with it — a test deployment should pay real-rate emission through fast
// windows, or its numbers mean nothing.
const (
	SecondsPerHeight = 3
	HeightsPerMinute = 60 / SecondsPerHeight // 20
	HeightsPerHour   = 60 * HeightsPerMinute // 1_200
	HeightsPerYear   = 10_512_000            // 365 mainnet days
	HeightsPerEra    = 31_536_000            // 3 years, the halving period
	MagiBlockHeights = 10                    // a MAGI block every 10 heights
)

// EmissionCap is the post-migration ceiling on NEW issuance: 20,000,000 LC.
// This is separate from, and additional to, the 51,000,000 LC historic hardcap.
const EmissionCap = Amount(20_000_000 * 100_000_000)

// HistoricHardCap is the absolute ceiling on everything ever issued.
const HistoricHardCap = Amount(51_000_000 * 100_000_000)

// EmissionSchedule defines a geometric issuance curve.
//
// Era n pays a fixed amount per height. After each era the budget is reduced
// by ReduceNum/ReduceDen. The infinite series sums to Cap, so:
//
//	era-1 budget = Cap * (ReduceDen - ReduceNum) / ReduceDen
//
// With ReduceNum/ReduceDen = 1/2 this is the classic "halving": era 1 pays
// half the cap (10M), and the total approaches but never reaches 20M.
type EmissionSchedule struct {
	// GenesisHeight is the height at which emission begins. Emission is zero
	// at and below this height.
	GenesisHeight uint64

	// EraHeights is the length of one era, in heights.
	EraHeights uint64

	// Cap is the total issuance ceiling (approached asymptotically).
	Cap Amount

	// ReduceNum/ReduceDen is the per-era budget multiplier. Must satisfy
	// 0 < ReduceNum < ReduceDen.
	ReduceNum int64
	ReduceDen int64
}

// DefaultSchedule is the schedule as written in the migration spec: 20M cap,
// 50% reduction every 3 years.
//
// DECISION PENDING — see CLAUDE.md open questions. Under this schedule
// issuance terminates in year 87 (the per-height reward floors to zero once
// the era budget drops below EraHeights base units). If a longer bootstrap is
// wanted, lower the reduction rate; the total stays exactly Cap either way.
// GenesisHeight is a placeholder until the snapshot height is chosen.
var DefaultSchedule = EmissionSchedule{
	GenesisHeight: 0,
	EraHeights:    HeightsPerEra,
	Cap:           EmissionCap,
	ReduceNum:     1,
	ReduceDen:     2,
}

// Valid reports whether the schedule is well-formed. Call this at genesis;
// an invalid schedule must never reach production.
func (s EmissionSchedule) Valid() bool {
	return s.EraHeights > 0 &&
		s.Cap > 0 &&
		s.ReduceNum > 0 &&
		s.ReduceDen > s.ReduceNum
}

// EraBudget returns the total issuance budgeted for era n (zero-indexed).
//
// budget(0) = Cap * (ReduceDen - ReduceNum) / ReduceDen
// budget(n) = budget(n-1) * ReduceNum / ReduceDen
//
// Each step truncates, so budgets only ever err downward.
func (s EmissionSchedule) EraBudget(n uint64) Amount {
	b, ok := MulDiv(s.Cap, s.ReduceDen-s.ReduceNum, s.ReduceDen)
	if !ok {
		return 0
	}
	for i := uint64(0); i < n; i++ {
		if b == 0 {
			return 0
		}
		b, ok = MulDiv(b, s.ReduceNum, s.ReduceDen)
		if !ok {
			return 0
		}
	}
	return b
}

// RewardPerHeight returns the issuance per height during era n.
//
// This floors. The remainder (up to EraHeights-1 base units per era) is
// stranded and never issued — that is intentional. Rounding must only ever
// cost the protocol precision, never breach the cap.
//
// Once this returns 0, emission has permanently ended.
func (s EmissionSchedule) RewardPerHeight(n uint64) Amount {
	if s.EraHeights == 0 {
		return 0
	}
	return s.EraBudget(n) / Amount(s.EraHeights)
}

// EraAt returns the zero-indexed era containing the given height, and whether
// emission has started at all.
func (s EmissionSchedule) EraAt(height uint64) (era uint64, started bool) {
	if height <= s.GenesisHeight || s.EraHeights == 0 {
		return 0, false
	}
	return (height - s.GenesisHeight) / s.EraHeights, true
}

// TotalEmittedAt returns the cumulative issuance from genesis through the
// given height, inclusive.
//
// This is the single source of truth for emission. Everything else — per-block
// rewards, pool splits, catch-up after an idle gap — derives from differences
// of this function. It is O(number of eras) and allocation-free, so it is
// cheap enough to call inside a contract.
func (s EmissionSchedule) TotalEmittedAt(height uint64) Amount {
	if height <= s.GenesisHeight || !s.Valid() {
		return 0
	}
	elapsed := height - s.GenesisHeight
	fullEras := elapsed / s.EraHeights
	remainder := elapsed % s.EraHeights

	var total Amount
	for n := uint64(0); n < fullEras; n++ {
		per := s.RewardPerHeight(n)
		if per == 0 {
			// Emission has ended; no later era can pay more than an earlier
			// one, so stop rather than looping to the heat death of the sun.
			return total
		}
		sum, ok := total.Add(per * Amount(s.EraHeights))
		if !ok {
			return total
		}
		total = sum
	}

	if per := s.RewardPerHeight(fullEras); per > 0 && remainder > 0 {
		sum, ok := total.Add(per * Amount(remainder))
		if ok {
			total = sum
		}
	}
	return total
}

// EmissionBetween returns the issuance owed for the half-open height range
// (fromHeight, toHeight].
//
// This is what a contract calls on each execution: pass the last settled
// height and the current one. Because it is a difference of a closed-form
// function, it is exact regardless of how irregularly the contract runs.
// Returns 0 if toHeight <= fromHeight.
func (s EmissionSchedule) EmissionBetween(fromHeight, toHeight uint64) Amount {
	if toHeight <= fromHeight {
		return 0
	}
	return s.TotalEmittedAt(toHeight) - s.TotalEmittedAt(fromHeight)
}

// FinalHeight returns the height at which emission permanently stops, and the
// total ever issued. Both are exact.
//
// Intended for analysis and tests, not for the hot path.
func (s EmissionSchedule) FinalHeight() (height uint64, total Amount) {
	if !s.Valid() {
		return s.GenesisHeight, 0
	}
	var n uint64
	for {
		if s.RewardPerHeight(n) == 0 {
			end := s.GenesisHeight + n*s.EraHeights
			return end, s.TotalEmittedAt(end)
		}
		n++
		if n > 1_000_000 { // safety valve; unreachable for sane schedules
			return 0, 0
		}
	}
}

// --- Per-block allocation -------------------------------------------------

// Allocation splits a block reward across the three pools defined in the
// migration spec. The splits are fixed protocol constants.
const (
	ShareProofOfBrain = 50 // % to LasseMedia creators + curators
	ShareLShare       = 25 // % to L-Share minters
	ShareLiquidity    = 25 // % to DEX liquidity providers
)

// Allocation is a reward split. The three fields always sum to exactly the
// input amount — the remainder from integer division is given to ProofOfBrain
// so that no base unit is ever lost or conjured.
type Allocation struct {
	ProofOfBrain Amount
	LShare       Amount
	Liquidity    Amount
}

// Total returns the sum of the three pools.
func (a Allocation) Total() Amount {
	return a.ProofOfBrain + a.LShare + a.Liquidity
}

// Split divides amount across the three pools.
//
// L-Share and Liquidity are floored at 25% each; Proof-of-Brain receives the
// rest, including any remainder. This guarantees Split(x).Total() == x exactly,
// which is asserted in the tests — a split that loses dust would slowly break
// the supply invariant.
func Split(amount Amount) Allocation {
	if amount <= 0 {
		return Allocation{}
	}
	lshare, ok1 := MulDiv(amount, ShareLShare, 100)
	liq, ok2 := MulDiv(amount, ShareLiquidity, 100)
	if !ok1 || !ok2 {
		return Allocation{}
	}
	return Allocation{
		ProofOfBrain: amount - lshare - liq,
		LShare:       lshare,
		Liquidity:    liq,
	}
}

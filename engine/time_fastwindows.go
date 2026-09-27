//go:build fastwindows

package engine

// TEST BUILD — NEVER THE PRODUCTION PROTOCOL, and not even the ordinary test
// one. A "day" is TWENTY-FOUR SECONDS (8 heights), so every day-denominated
// window runs 3,600x fast.
//
// WHY A SECOND TEST CLOCK EXISTS. The 240x TESTWINDOWS build cannot reach the
// three permissionless sweeps at all: `sweep_mint` needs a mint that has
// matured, spent 90 days of grace and bled for 90 more (18 hours at 240x),
// `sweep_tranche` needs 180 dormant days (18 hours), and `sweep_curation`
// needs a year after a payout (37 hours). Throwaway #11 proved what happens
// if you try to wait that out: the accrual backlog grows 240 simulated days
// per real day, and the catch-up walk outruns what its RC can pay long before
// the window opens. So the money-recycling paths that nobody can repair after
// the key burn stayed untested. Here the same arcs take 18, 18 and 37 MINUTES.
//
//	sweep_mint     1-day mint + 90 grace + 90 bleed = 181 days = ~72 min
//	sweep_tranche  180 dormant days                            = ~72 min
//	sweep_curation 7-day window + 365 days                     = ~2.5 hours
//
// All three can be armed at the start and swept in one pass, so the whole
// run is one sitting of about an hour and a quarter.
//
// Emission and the 7%/yr share-rate ratchet stay pinned to mainnet time (see
// emission.go), exactly as in TESTWINDOWS, so observed VALUES remain real —
// only the calendar shrinks.
//
// ⚠️ A day is shorter than a MAGI block (30 s), so several simulated days pass
// between two blocks. That is sound — emission and yield are closed-form
// functions of height and settle as a difference, never accumulated per tick
// (CLAUDE.md, "Block time & height semantics") — but it does mean the accrual
// walk crosses many days per call, so `advance` must be sliced generously.
//
// ⚠️ EIGHT HEIGHTS, AND THE NUMBER IS NOT FREE — THE SUITE PICKED IT.
//
// A day's emission is split twice, and `MulDiv` floors both times: 50/25/25
// into Proof-of-Brain, L-Share and Liquidity, then the PoB half again 25/75
// into viral and deep. Per-height emission is ODD in every era (era 1 is
// 31,709,791), so the day must carry enough heights for both splits to be
// exact: divisible by 4 for the first, and by 8 once the PoB half is halved
// again.
//
// Measured, not reasoned: at 2 heights `auditSupply` failed with a few base
// units stranded per day; at 4 it passed but TestTimeTravelIsPathIndependent
// failed — pool_deep differed by 547 units over three years between settling
// daily and settling monthly, which is one floored unit per two days. At 8 it
// is exact, as the real 28,800 and the 240x build's 120 also are (both are
// multiples of 8). A test clock that breaks the invariant guarding the frozen
// contract would make every result measured on it worthless.
//
// Build: ./build.sh wasm-fast  (adds -tags fastwindows)
const HeightsPerDay = 8

// BuildVariant marks every init of this build, so a throwaway deployment can
// never be confused with the real chain, nor with a 240x one, by anyone who
// reads its state.
const BuildVariant = " [FASTWINDOWS BUILD 3600x]"

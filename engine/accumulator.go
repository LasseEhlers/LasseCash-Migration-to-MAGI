package engine

// Reward accounting for the L-Share yield pool.
//
// THE PROBLEM THIS SOLVES. Yield used to be claimed as
// `pool * myShares / totalShares` at the moment of claiming, which records no
// notion of WHEN a mint began earning. A mint created one second ago therefore
// had exactly the same claim on a year of accumulated emission as one locked
// for that entire year. Measured: two identical 30-day mints, alice first, and
// bob collected 2.5x what she did purely by claiming later. The incentive was
// to claim LAST, not to lock LONGEST — the opposite of the design's intent.
//
// THE FIX is the standard cumulative reward-per-share accumulator, the same
// shape HEX uses (and Synthetix, and MasterChef). HEX stores per-day payout
// data and its stakeEnd LOOPS over every day a stake was active, which is why
// ending a long HEX stake is expensive. Storing the running TOTAL instead of
// the per-day amount turns that loop into a subtraction:
//
//	entitlement = shares * (acc[end] - acc[start]) / AccScale
//
// Two reads. A 1-day mint and a 1095-day mint cost exactly the same to settle,
// which matters here because gas is charged to the caller's RC.
//
// `acc` only ever rises, so the subtraction is always the reward that accrued
// while — and only while — those shares were live.

// AccScale is the fixed-point scale of the accumulator.
//
// It is NOT the token Unit. `acc` counts reward-per-share, and a share is
// itself a 1e8-scaled quantity, so a per-share figure is tiny and needs far
// more resolution than 8 decimals to avoid flooring away to nothing.
//
// 1e12 is chosen against the real bounds: total emission is 20M LC = 2e15 base
// units, so with a healthy share base (>= 1e12, i.e. 10,000 LC minted) the
// accumulator's lifetime total lands around 2e15 — comfortably inside int64.
const AccScale int64 = 1_000_000_000_000

// MinSharesForAccrual is the share base below which emission is HELD rather
// than distributed.
//
// ⚠️ THIS IS AN OVERFLOW GUARD, NOT AN ECONOMIC POLICY. `acc` rises by
// `inflow * AccScale / activeShares`, so a vanishingly small share base makes
// each step enormous — one dust mint of a single base unit, alone on the
// chain, would push `acc` past int64 within days and corrupt every later
// entitlement. Holding the inflow instead is safe and loses nothing: held
// value stays in the pool and is distributed in full as soon as a real share
// base exists (see AccumulatorStep).
//
// 1e10 is 100 LC of raw share weight — far below any realistic staking base,
// and reached almost immediately after a migration that credits 19M LC.
const MinSharesForAccrual Shares = 10_000_000_000

// AccumulatorStep advances the reward-per-share accumulator by one inflow.
//
// `held` is value that previous steps could not distribute; it is folded into
// this step so nothing is ever stranded. The returned `stillHeld` is what this
// step could not distribute either.
//
// Flooring is deliberate and always in the pool's favour: the remainder stays
// in the pool rather than being conjured for a claimant, so the sum of all
// entitlements can never exceed what the pool actually holds.
func AccumulatorStep(acc int64, inflow, held Amount, activeShares Shares) (newAcc int64, stillHeld Amount) {
	total := inflow + held
	if total <= 0 {
		return acc, 0
	}
	// Nobody to pay, or too few shares to divide by safely: hold ALL of it and
	// leave the accumulator untouched.
	//
	// Holding all-or-nothing is what keeps this honest. An earlier version held
	// only the floored REMAINDER and folded it into the next step — which
	// advanced the accumulator a second time on value it had already counted,
	// and made the claimable total exceed what had actually been poured in.
	// Caught by TestAccumulatorConservesValue. Either a step distributes the
	// whole inflow or it distributes none of it.
	if activeShares < MinSharesForAccrual {
		return acc, total
	}

	// The rise in reward-per-share, scaled. MulDiv carries a 128-bit
	// intermediate, so the multiply cannot silently wrap.
	//
	// Flooring here is deliberate and always in the pool's favour: the fraction
	// that will not divide evenly stays in the pool as dust rather than being
	// conjured for a claimant. At a realistic share base that dust is a few
	// hundred base units per step — around 0.00001 LC — and it can only ever
	// make the sum of entitlements SMALLER than the pool, never larger.
	rise, ok := MulDiv(total, AccScale, int64(activeShares))
	if !ok || rise <= 0 {
		return acc, total
	}
	// Refuse to advance if the accumulator itself would overflow. This cannot
	// happen with a realistic share base; refusing is still better than
	// wrapping, which would corrupt every outstanding entitlement at once.
	if acc > MaxAccumulator-int64(rise) {
		return acc, total
	}
	return acc + int64(rise), 0
}

// MaxAccumulator is the largest value the accumulator may reach.
const MaxAccumulator int64 = 1<<63 - 1

// Entitlement is what a holding of `shares` earned between two accumulator
// readings.
//
// accStart is stamped on the mint when it is created and accEnd is read at
// maturity, so this is exactly the emission that arrived while those shares
// were live — no more, and none of what arrived before they existed.
func Entitlement(shares Shares, accStart, accEnd int64) Amount {
	if shares <= 0 || accEnd <= accStart {
		return 0
	}
	out, ok := MulDiv(Amount(accEnd-accStart), int64(shares), AccScale)
	if !ok {
		return 0
	}
	return out
}

// Walk bounds. They live in the engine (not the contract) so the browser can
// read them through the bridge: the site plans `advance` slices ahead of a
// mint/claim from these numbers, and a value typed twice would drift.
//
// ExpiryChunkSize: per-account expiry entries per stored chunk.
// MaxRetirePerWalk: retirements one `advance` performs. DECIDED 50 on
// 2026-08-22 (measured on the devnet: ~102 RC per retirement, so a slice is
// ~6,500 RC — inside any fresh account's free 10,000, so the crowd crosses
// the migration day by itself, ~32 calls for the real set, with no single
// account needing parked HBD. At 200 a slice was ~20,900 RC: only a whale
// could send one, a single point of failure on day 30).
// UserRetireBudget: what an ORDINARY transaction retires as a side effect —
// enough for a normal day's maturities, never the migration day's.
// Both budgets must be multiples of ExpiryChunkSize or the walk wedges.
const (
	ExpiryChunkSize  = 25
	MaxRetirePerWalk = 50
	// UserRetireBudget == MaxRetirePerWalk (50) on 2026-08-22 collapsed the
	// intended two tiers into one: an ordinary transaction (a transfer, a
	// vote) that happens to cross a day boundary with a backlog paid the
	// SAME RC as a dedicated advance call — full migration-cliff cost on a
	// plain transfer. One ExpiryChunkSize (25) restores the split: enough
	// for a normal day's maturities, never the migration day's, which stays
	// on advance — the site already bundles advance calls ahead of a real
	// action via preCalls (see LasseCashClient.catchUp), so the heavy
	// lifting was never actually resting on ordinary transactions anyway.
	// Lasse's call, 2026-08-24.
	UserRetireBudget = ExpiryChunkSize
)

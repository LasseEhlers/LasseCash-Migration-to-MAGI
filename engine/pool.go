package engine

import "math/bits"

// The LASSECASH:HBD liquidity pool.
//
// WHY WE BUILD OUR OWN AMM
//
// Magi's native pools pair MAPPED assets (BTC, ETH, SOL) against HBD, and the
// contract SDK exposes no pool, swap or liquidity primitives whatsoever —
// GetBalance / HiveDraw / HiveTransfer / HiveWithdraw is the entire asset
// surface. LASSECASH is a contract-managed token, not a mapped asset, so it
// cannot enter a native pool.
//
// It does not need to. `hbd` IS a first-class SDK asset, so the contract can
// custody real HBD on one side and its own LASSECASH ledger on the other. That
// is a genuine LASSECASH:HBD pool, fully self-contained.
//
// Constant product (x*y=k), the same shape as Hive-Engine's Diesel pools, which
// is what the spec asks for.

// --- loyalty bonus --------------------------------------------------------

const (
	// LoyaltyMaxDays is how long a tranche keeps accruing its bonus.
	LoyaltyMaxDays = 90

	// LoyaltyPerDayPct is the bonus added per day, LINEAR not compounding.
	// The old About page fixes the reading: "1% per day up to 30 days, capping
	// at a 30% extra daily reward" — 30 days -> +30%, so it is linear. The spec
	// extends the cap to 90 days, giving a 1.9x maximum.
	LoyaltyPerDayPct = 1
)

// LoyaltyMultiplier returns a tranche's reward multiplier for its age in days,
// scaled by MultScale.
//
//	day 0  -> 1.00x
//	day 30 -> 1.30x
//	day 90 -> 1.90x  (capped)
func LoyaltyMultiplier(ageDays int64) int64 {
	if ageDays <= 0 {
		return MultScale
	}
	if ageDays > LoyaltyMaxDays {
		ageDays = LoyaltyMaxDays
	}
	return MultScale + ageDays*LoyaltyPerDayPct*MultScale/100
}

// AgeDays converts a height span into whole days.
func AgeDays(startHeight, height uint64) int64 {
	if height <= startHeight {
		return 0
	}
	return int64((height - startHeight) / HeightsPerDay)
}

// --- swap -----------------------------------------------------------------

// SwapOut returns how much of the output asset a swap yields.
//
//	amountOut = reserveOut * amountIn / (reserveIn + amountIn)
//
// the constant-product formula with NO fee deduction — the trader's entire
// input enters the curve. FLOORS, so the trader is never over-paid and the
// invariant k can only ever grow. That direction is deliberate: a rounding
// error that favours the trader drains the pool.
//
// Returns ok=false on empty reserves, a non-positive input, or an output that
// would empty the pool completely.
func SwapOut(reserveIn, reserveOut, amountIn Amount) (Amount, bool) {
	if reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0 {
		return 0, false
	}

	denom, okAdd := reserveIn.Add(amountIn)
	if !okAdd || denom <= 0 {
		return 0, false
	}
	out, okOut := MulDiv(reserveOut, int64(amountIn), int64(denom))
	if !okOut || out <= 0 {
		return 0, false
	}
	// A swap must never take the last unit — an emptied reserve makes the
	// constant product undefined and the pool unrecoverable.
	if out >= reserveOut {
		return 0, false
	}
	return out, true
}

// SwapPreservesK reports whether a swap left the constant product intact.
//
// Used as a test assertion rather than a runtime check: with flooring, k must
// weakly INCREASE on every swap. If it ever decreases, value is leaking out of
// the pool and the AMM is broken.
func SwapPreservesK(reserveIn, reserveOut, amountIn, amountOut Amount) bool {
	beforeHi, beforeLo := bits.Mul64(uint64(reserveIn), uint64(reserveOut))
	afterHi, afterLo := bits.Mul64(uint64(reserveIn+amountIn), uint64(reserveOut-amountOut))
	if afterHi != beforeHi {
		return afterHi > beforeHi
	}
	return afterLo >= beforeLo
}

// LcToHbd converts a LASSECASH amount into HBD at the pool's SPOT PRICE.
//
//	hbd = amount * hbdReserve / lcReserve
//
// This is an ESTIMATE by nature — the reserves move between reading and acting
// — but the arithmetic belongs here, in the one engine, exactly like
// ShareRateInHbd above it. A "≈ X HBD" figure beside a LASSECASH amount is a
// calculation, and a calculation written in TypeScript is the drift the golden
// rule exists to prevent.
//
// Floors, like every other conversion in the pool: an approximate figure shown
// to a user must never round UP into money that is not there.
//
// Returns ok=false while the pool is UNSEEDED. There is no price yet, and a
// zero would read as "worth nothing" rather than "not known" — so callers get
// nothing to show rather than something false.
func LcToHbd(amount, lcReserve, hbdReserve Amount) (Amount, bool) {
	if amount < 0 || lcReserve <= 0 || hbdReserve <= 0 {
		return 0, false
	}
	if amount == 0 {
		return 0, true
	}
	return MulDiv(amount, int64(hbdReserve), int64(lcReserve))
}

// --- liquidity ------------------------------------------------------------

// LPSharesFor returns the pool shares minted for a liquidity deposit.
//
// The FIRST provider defines the price, and receives shares equal to the
// LASSECASH they deposit. Later providers receive shares in proportion to what
// they add relative to the existing reserve:
//
//	shares = totalShares * lcIn / lcReserve
//
// Defining initial shares as the LC amount avoids needing a 128-bit integer
// square root (the usual sqrt(x*y)) for no loss of correctness — shares are
// only ever meaningful as a ratio.
func LPSharesFor(lcIn, lcReserve Amount, totalShares Shares) (Shares, bool) {
	if lcIn <= 0 {
		return 0, false
	}
	if totalShares <= 0 || lcReserve <= 0 {
		return Shares(lcIn), true // first deposit
	}
	s, okShares := MulDiv(Amount(totalShares), int64(lcIn), int64(lcReserve))
	if !okShares || s <= 0 {
		return 0, false
	}
	return Shares(s), true
}

// HbdRequiredFor returns the HBD that must accompany an LC deposit to keep the
// pool's price unchanged.
//
// Rounds UP: a deposit that rounded down would shift the price slightly in the
// depositor's favour, which is a free (if tiny) arbitrage on every add.
func HbdRequiredFor(lcIn, lcReserve, hbdReserve Amount) (Amount, bool) {
	if lcIn <= 0 {
		return 0, false
	}
	if lcReserve <= 0 || hbdReserve <= 0 {
		return 0, false // first deposit sets its own price
	}
	need, okNeed := MulDiv(hbdReserve, int64(lcIn), int64(lcReserve))
	if !okNeed {
		return 0, false
	}
	// Round up unless it divided exactly.
	check, okCheck := MulDiv(need, int64(lcReserve), int64(hbdReserve))
	if okCheck && check < lcIn {
		need++
	}
	return need, true
}

// WithdrawAmounts returns the LC and HBD released by burning pool shares.
//
// Both floor, so a withdrawal can never take more than its proportional claim
// and the remaining providers are never diluted by rounding.
func WithdrawAmounts(shares, totalShares Shares, lcReserve, hbdReserve Amount) (Amount, Amount, bool) {
	if shares <= 0 || totalShares <= 0 || shares > totalShares {
		return 0, 0, false
	}
	lc, okLC := MulDiv(lcReserve, int64(shares), int64(totalShares))
	if !okLC {
		return 0, 0, false
	}
	hbd, okHBD := MulDiv(hbdReserve, int64(shares), int64(totalShares))
	if !okHBD {
		return 0, 0, false
	}
	return lc, hbd, true
}

// --- reward weight --------------------------------------------------------

// TrancheWeight returns a tranche's claim weight on the liquidity reward pool:
// its pool shares scaled by its loyalty multiplier.
//
// This is what makes a 90-day-old tranche earn 1.9x what a fresh one of the
// same size earns.
func TrancheWeight(shares Shares, ageDays int64) Shares {
	if shares <= 0 {
		return 0
	}
	w, okW := MulDiv(Amount(shares), LoyaltyMultiplier(ageDays), MultScale)
	if !okW {
		return shares
	}
	return Shares(w)
}

// PoolRewardsOwed is what a tranche would be paid right now: the accumulator
// as it would read after folding the unsynced inflow across the registered
// weight, minus the tranche's starting reading, clamped to what the pool
// actually holds. Pure — the contract passes its state in, the browser passes
// the same figures read from the chain, and both get the same number.
func PoolRewardsOwed(weight Shares, accStart int64, pool, seen, held Amount, acc int64, totalWeight Shares) Amount {
	if weight <= 0 {
		return 0
	}
	if pool > seen {
		acc, _ = AccumulatorStep(acc, pool-seen, held, totalWeight)
	}
	owed := Entitlement(weight, accStart, acc)
	if owed > pool {
		owed = pool
	}
	return owed
}

// MAGI moves HBD in MILLI-units (3 decimals); the engine accounts in 1e8
// units like everything else. The adapter between them must never let real
// custody fall below the ledger: a draw rounds UP (the contract receives at
// least what it books; the payer is out by under 0.001 HBD at worst) and a
// payout rounds DOWN (the contract never pays more than it books). Found on
// mainnet 2026-08-22: the adapter passed 200,000,000 (2 HBD) to an SDK
// expecting 2,000, and the node refused the draw.
const HbdUnitsPerMilli = 100_000

// HbdDrawMilli is the milli-HBD to draw so that at least `units` is custodied.
func HbdDrawMilli(units Amount) int64 {
	if units <= 0 {
		return 0
	}
	return (int64(units) + HbdUnitsPerMilli - 1) / HbdUnitsPerMilli
}

// HbdPayMilli is the milli-HBD to pay out for `units`, never more.
func HbdPayMilli(units Amount) int64 {
	if units <= 0 {
		return 0
	}
	return int64(units) / HbdUnitsPerMilli
}

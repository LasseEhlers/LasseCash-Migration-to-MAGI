// Package engine holds the LasseCash economic engine.
//
// CRITICAL: this package is PURE. No I/O, no MAGI SDK, no clock, no randomness.
// It is compiled into two targets:
//
//  1. the MAGI WASM contract  (contract/)
//  2. the local dev simulator (node/)
//
// Because both targets share this exact code, the frontend can never be shown
// a number the chain would disagree with. Do not fork this logic. Do not
// reimplement any of it in TypeScript.
package engine

import "math/bits"

// Decimals is the LasseCash precision. This matches the legacy Hive-Engine
// token and is not negotiable.
const Decimals = 8

// Unit is the number of base units in 1 LASSECASH.
const Unit int64 = 100_000_000

// Amount is a quantity of LASSECASH expressed in BASE UNITS (not whole tokens).
//
// Never convert an Amount to float64 for anything except display at the very
// edge of the system. Every arithmetic operation in the accounting path must
// stay integer. A float rounding error here is a minted or destroyed token.
type Amount int64

// MaxAmount is the largest representable Amount. int64 gives ~92.2 billion
// LASSECASH of headroom at 8 decimals against a 51M hardcap — roughly 1800x
// margin, so int64 is safe for balances. Intermediate products are NOT
// automatically safe; that is what MulDiv is for.
const MaxAmount = Amount(1<<63 - 1)

// LC builds an Amount from whole tokens. Panics on overflow. Intended for
// constants and tests, not for user input.
func LC(whole int64) Amount {
	if whole > int64(MaxAmount)/Unit || whole < -int64(MaxAmount)/Unit {
		panic("engine: LC overflow")
	}
	return Amount(whole * Unit)
}

// Add returns a+b, reporting overflow rather than wrapping.
func (a Amount) Add(b Amount) (Amount, bool) {
	s := a + b
	// Overflow iff the operands share a sign and the result differs from it.
	if (a > 0 && b > 0 && s < 0) || (a < 0 && b < 0 && s >= 0) {
		return 0, false
	}
	return s, true
}

// Sub returns a-b, reporting overflow rather than wrapping.
func (a Amount) Sub(b Amount) (Amount, bool) {
	d := a - b
	if (b < 0 && d < a) || (b > 0 && d > a) {
		return 0, false
	}
	return d, true
}

// MulDiv computes a*num/den using a 128-bit intermediate, so the product
// cannot overflow even when a is near the supply cap and num is a large
// scaled multiplier (e.g. 1.5x encoded as 150_000_000).
//
// Truncation is always toward zero, deliberately. Emission and reward math
// must round DOWN so that rounding can never breach a supply cap. There is no
// rounding mode option here on purpose — offering one invites misuse.
//
// Returns ok=false on division by zero or if the quotient exceeds MaxAmount.
func MulDiv(a Amount, num, den int64) (Amount, bool) {
	if den == 0 {
		return 0, false
	}

	neg := false
	x, ok := absU64(int64(a))
	if !ok {
		return 0, false
	}
	if a < 0 {
		neg = !neg
	}
	n, ok := absU64(num)
	if !ok {
		return 0, false
	}
	if num < 0 {
		neg = !neg
	}
	d, ok := absU64(den)
	if !ok {
		return 0, false
	}
	if den < 0 {
		neg = !neg
	}

	hi, lo := bits.Mul64(x, n)
	// bits.Div64 panics if hi >= d (quotient would not fit in 64 bits), so
	// guard rather than letting a contract trap.
	if hi >= d {
		return 0, false
	}
	q, _ := bits.Div64(hi, lo, d)
	if q > uint64(MaxAmount) {
		return 0, false
	}

	r := Amount(q)
	if neg {
		r = -r
	}
	return r, true
}

// absU64 returns |v| as a uint64. ok is false for math.MinInt64, whose
// magnitude has no positive int64 counterpart.
func absU64(v int64) (uint64, bool) {
	if v == -1<<63 {
		return 0, false
	}
	if v < 0 {
		return uint64(-v), true
	}
	return uint64(v), true
}

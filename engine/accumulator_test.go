package engine

import "testing"

// The property the whole design rests on: you are paid for the emission that
// arrived while your shares were live, and for nothing else.
func TestEntitlementPaysOnlyForTimeHeld(t *testing.T) {
	var acc int64
	var held Amount
	const shares = Shares(1_000_000_000_000) // 10,000 LC of share weight

	// A year of emission arrives while ALICE alone holds shares.
	aliceStart := acc
	for d := 0; d < 365; d++ {
		acc, held = AccumulatorStep(acc, LC(100), held, shares)
	}
	// Bob arrives now. His start is stamped at TODAY's accumulator.
	bobStart := acc

	// Another year, now split between the two of them.
	for d := 0; d < 365; d++ {
		acc, held = AccumulatorStep(acc, LC(100), held, shares*2)
	}

	alice := Entitlement(shares, aliceStart, acc)
	bob := Entitlement(shares, bobStart, acc)

	// Bob was absent for the first year, so he must get NONE of it.
	if bob >= alice {
		t.Errorf("bob (arrived a year late) got %d, alice got %d — a latecomer "+
			"must never earn as much as someone who was there the whole time", bob, alice)
	}
	// Alice: all of year one, half of year two. Bob: half of year two.
	// So alice should be very close to three times bob.
	ratio := float64(alice) / float64(bob)
	if ratio < 2.98 || ratio > 3.02 {
		t.Errorf("alice/bob = %.4f, want ~3.0 (she earned 1.5 years' worth to his 0.5)", ratio)
	}
}

// Nothing may be created, and nothing may be lost.
func TestAccumulatorConservesValue(t *testing.T) {
	var acc int64
	var held Amount
	const shares = Shares(3_333_333_333_333) // deliberately awkward divisor
	var poured Amount

	start := acc
	for d := 0; d < 1000; d++ {
		in := LC(7) + Amount(d) // varying, non-round inflows
		poured += in
		acc, held = AccumulatorStep(acc, in, held, shares)
	}

	claimed := Entitlement(shares, start, acc)
	if claimed > poured {
		t.Fatalf("claimable %d exceeds the %d actually poured in — value was conjured",
			claimed, poured)
	}
	// Everything is either claimable or still held; the gap is only the
	// per-step flooring, which stays in the pool.
	lost := poured - claimed - held
	if lost < 0 {
		t.Fatalf("accounting is inconsistent: poured=%d claimed=%d held=%d", poured, claimed, held)
	}
	if lost > LC(1) {
		t.Errorf("flooring stranded %d base units over 1000 steps, which is more "+
			"than rounding can explain", lost)
	}
}

// A dust share base must not be able to blow up the accumulator.
func TestTinyShareBaseHoldsInsteadOfOverflowing(t *testing.T) {
	acc, held := AccumulatorStep(0, LC(1_000), 0, Shares(1))
	if acc != 0 {
		t.Errorf("accumulator advanced on a 1-share base; acc=%d", acc)
	}
	if held != LC(1_000) {
		t.Errorf("inflow was not held for later; held=%d want %d", held, LC(1_000))
	}

	// Once a real share base exists, the held value is distributed in full.
	const shares = Shares(1_000_000_000_000)
	acc2, held2 := AccumulatorStep(acc, 0, held, shares)
	if acc2 <= 0 {
		t.Fatal("held value was never distributed once shares existed")
	}
	got := Entitlement(shares, 0, acc2)
	if diff := LC(1_000) - got - held2; diff < 0 || diff > 1 {
		t.Errorf("held value did not arrive intact: got %d + held %d, want %d",
			got, held2, LC(1_000))
	}
}

// Zero shares must hold rather than divide by zero.
func TestNoSharesHoldsEverything(t *testing.T) {
	acc, held := AccumulatorStep(0, LC(500), 0, 0)
	if acc != 0 || held != LC(500) {
		t.Errorf("with no shares: acc=%d held=%d, want 0 and %d", acc, held, LC(500))
	}
}

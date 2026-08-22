package engine

import "testing"

// --- loyalty --------------------------------------------------------------

func TestLoyaltyIsLinearAndCaps(t *testing.T) {
	cases := []struct {
		days int64
		want int64
		msg  string
	}{
		{0, MultScale, "day 0 = 1.00x"},
		{1, MultScale + MultScale/100, "day 1 = 1.01x"},
		{30, MultScale + 30*MultScale/100, "day 30 = 1.30x (matches the old About page)"},
		{90, MultScale + 90*MultScale/100, "day 90 = 1.90x"},
		{91, MultScale + 90*MultScale/100, "day 91 caps at 1.90x"},
		{10_000, MultScale + 90*MultScale/100, "far past the cap stays 1.90x"},
		{-5, MultScale, "negative age clamps to 1.00x"},
	}
	for _, c := range cases {
		if got := LoyaltyMultiplier(c.days); got != c.want {
			t.Fatalf("%s: got %d want %d", c.msg, got, c.want)
		}
	}
	// Monotonic — a longer stay must never earn less.
	prev := int64(0)
	for d := int64(0); d <= 120; d++ {
		m := LoyaltyMultiplier(d)
		if m < prev {
			t.Fatalf("day %d: multiplier decreased %d -> %d", d, prev, m)
		}
		prev = m
	}
}

func TestAgeDaysCountsWholeDays(t *testing.T) {
	start := uint64(1_000_000)
	if got := AgeDays(start, start); got != 0 {
		t.Fatalf("same height should be 0 days, got %d", got)
	}
	if got := AgeDays(start, start-1); got != 0 {
		t.Fatalf("earlier height should be 0 days, got %d", got)
	}
	if got := AgeDays(start, start+HeightsPerDay-1); got != 0 {
		t.Fatalf("just under a day should be 0, got %d", got)
	}
	if got := AgeDays(start, start+HeightsPerDay); got != 1 {
		t.Fatalf("exactly a day should be 1, got %d", got)
	}
	if got := AgeDays(start, start+90*HeightsPerDay); got != 90 {
		t.Fatalf("90 days, got %d", got)
	}
}

// --- swap -----------------------------------------------------------------

// The invariant that keeps an AMM solvent: k must never shrink.
func TestSwapNeverShrinksK(t *testing.T) {
	reserves := []struct{ lc, hbd Amount }{
		{LC(1_000), LC(100)},
		{LC(1_000_000), LC(250_000)},
		{LC(10), LC(10)},
		{LC(5_000_000), LC(1)},
	}
	inputs := []Amount{1, 100, LC(1), LC(10), LC(1_000), LC(100_000)}

	for _, r := range reserves {
		for _, in := range inputs {
			out, ok := SwapOut(r.lc, r.hbd, in)
			if !ok {
				continue
			}
			if out >= r.hbd {
				t.Fatalf("swap drained the reserve: out %s of %s", fmtLC(out), fmtLC(r.hbd))
			}
			// With a zero fee, k is held flat by flooring ALONE. This is the
			// assertion that proves free swaps are still solvent.
			if !SwapPreservesK(r.lc, r.hbd, in, out) {
				t.Fatalf("k SHRANK: reserves %s/%s, in %s, out %s",
					fmtLC(r.lc), fmtLC(r.hbd), fmtLC(in), fmtLC(out))
			}
		}
	}
}

func TestSwapRejectsNonsense(t *testing.T) {
	bad := []struct {
		in, out, amt Amount
		why          string
	}{
		{0, LC(100), LC(1), "empty input reserve"},
		{LC(100), 0, LC(1), "empty output reserve"},
		{LC(100), LC(100), 0, "zero input"},
		{LC(100), LC(100), -LC(1), "negative input"},
	}
	for _, c := range bad {
		if _, ok := SwapOut(c.in, c.out, c.amt); ok {
			t.Fatalf("%s was accepted", c.why)
		}
	}
}

// A bigger trade must move the price against the trader — that is slippage,
// and its absence would mean the pool could be drained at a fixed rate.
func TestSwapHasSlippage(t *testing.T) {
	lc, hbd := LC(100_000), LC(100_000)

	small, _ := SwapOut(lc, hbd, LC(100))
	big, _ := SwapOut(lc, hbd, LC(10_000))

	// Rate = out per unit in. The big trade must get a worse rate.
	smallRate, _ := MulDiv(small, int64(LC(1)), int64(LC(100)))
	bigRate, _ := MulDiv(big, int64(LC(1)), int64(LC(10_000)))
	if bigRate >= smallRate {
		t.Fatalf("no slippage: small trade rate %s, large trade rate %s",
			fmtLC(smallRate), fmtLC(bigRate))
	}
	t.Logf("100 LC -> %s HBD; 10,000 LC -> %s HBD (slippage working)",
		fmtLC(small), fmtLC(big))
}

// THE fee test: there is no fee. The trader's entire input must enter the
// curve, so SwapOut has to equal the bare constant-product formula to the
// base unit. If anyone ever reintroduces a fee deduction, this fails.
func TestSwapTakesNoFee(t *testing.T) {
	reserves := []struct{ lc, hbd Amount }{
		{LC(500_000), LC(120_000)},
		{LC(1_000), LC(100)},
		{LC(5_000_000), LC(3)},
	}
	for _, r := range reserves {
		for _, in := range []Amount{1, LC(1), LC(1_000), LC(50_000)} {
			got, ok := SwapOut(r.lc, r.hbd, in)
			if !ok {
				continue
			}
			// reserveOut * amountIn / (reserveIn + amountIn), no fee term.
			want, okWant := MulDiv(r.hbd, int64(in), int64(r.lc+in))
			if !okWant {
				t.Fatalf("reference calculation overflowed")
			}
			if got != want {
				t.Fatalf("a fee was taken: reserves %s/%s in %s -> got %s want %s",
					fmtLC(r.lc), fmtLC(r.hbd), fmtLC(in), fmtLC(got), fmtLC(want))
			}
		}
	}
}

// Round-tripping must lose money to the pool, never make it. Otherwise a
// zero-risk arbitrage drains liquidity providers.
// With NO fee, flooring is the only thing standing between the pool and a
// free round-trip drain. So test it at many sizes, not one.
func TestRoundTripCannotProfit(t *testing.T) {
	for _, in := range []Amount{1, 100, LC(1), LC(5_000), LC(200_000)} {
		lc, hbd := LC(1_000_000), LC(400_000)

		out, ok := SwapOut(lc, hbd, in)
		if !ok {
			continue
		}
		// Reserves after leg one, then swap straight back.
		back, ok := SwapOut(hbd-out, lc+in, out)
		if !ok {
			continue
		}
		if back > in {
			t.Fatalf("round trip PROFITED at size %s: %s -> %s",
				fmtLC(in), fmtLC(in), fmtLC(back))
		}
	}
}

// --- liquidity ------------------------------------------------------------

func TestFirstProviderSetsThePrice(t *testing.T) {
	shares, ok := LPSharesFor(LC(1_000), 0, 0)
	if !ok || shares != Shares(LC(1_000)) {
		t.Fatalf("first deposit got %s shares, want 1000", fmtLC(Amount(shares)))
	}
	if _, ok := LPSharesFor(0, 0, 0); ok {
		t.Fatal("zero deposit accepted")
	}
	if _, ok := LPSharesFor(-LC(1), 0, 0); ok {
		t.Fatal("negative deposit accepted")
	}
}

func TestLaterProvidersGetProportionalShares(t *testing.T) {
	lcReserve := LC(1_000)
	total := Shares(LC(1_000))

	// Doubling the pool must double the shares outstanding.
	got, ok := LPSharesFor(LC(1_000), lcReserve, total)
	if !ok || got != Shares(LC(1_000)) {
		t.Fatalf("matching deposit got %s, want 1000", fmtLC(Amount(got)))
	}
	// A tenth of the pool earns a tenth of the shares.
	got, _ = LPSharesFor(LC(100), lcReserve, total)
	if got != Shares(LC(100)) {
		t.Fatalf("10%% deposit got %s, want 100", fmtLC(Amount(got)))
	}
}

// Deposits must not shift the price — that would be free arbitrage on every add.
func TestDepositRequiresMatchingHbd(t *testing.T) {
	lcReserve, hbdReserve := LC(1_000), LC(250)

	need, ok := HbdRequiredFor(LC(100), lcReserve, hbdReserve)
	if !ok {
		t.Fatal("rejected a valid deposit")
	}
	// 10% of the LC side needs 10% of the HBD side.
	if need != LC(25) {
		t.Fatalf("needs %s HBD, want 25", fmtLC(need))
	}
	// Rounding must never favour the depositor.
	for _, lcIn := range []Amount{1, 3, 7, 99, 12345} {
		n, ok := HbdRequiredFor(lcIn, lcReserve, hbdReserve)
		if !ok {
			continue
		}
		exact, _ := MulDiv(hbdReserve, int64(lcIn), int64(lcReserve))
		if n < exact {
			t.Fatalf("lcIn %d: required %s is below the exact share %s",
				lcIn, fmtLC(n), fmtLC(exact))
		}
	}
}

// Withdrawing everything must return everything; withdrawing part must never
// return more than the proportional claim.
func TestWithdrawIsProportionalAndNeverOverdraws(t *testing.T) {
	lcReserve, hbdReserve := LC(1_000), LC(400)
	total := Shares(LC(1_000))

	lc, hbd, ok := WithdrawAmounts(total, total, lcReserve, hbdReserve)
	if !ok || lc != lcReserve || hbd != hbdReserve {
		t.Fatalf("full withdrawal returned %s/%s, want %s/%s",
			fmtLC(lc), fmtLC(hbd), fmtLC(lcReserve), fmtLC(hbdReserve))
	}

	lc, hbd, _ = WithdrawAmounts(total/4, total, lcReserve, hbdReserve)
	if lc != LC(250) || hbd != LC(100) {
		t.Fatalf("quarter withdrawal returned %s/%s, want 250/100", fmtLC(lc), fmtLC(hbd))
	}

	// Two halves must not exceed the whole, even with rounding.
	half := total / 2
	l1, h1, _ := WithdrawAmounts(half, total, lcReserve, hbdReserve)
	l2, h2, _ := WithdrawAmounts(total-half, total, lcReserve, hbdReserve)
	if l1+l2 > lcReserve || h1+h2 > hbdReserve {
		t.Fatalf("two halves overdrew: %s+%s LC of %s", fmtLC(l1), fmtLC(l2), fmtLC(lcReserve))
	}

	if _, _, ok := WithdrawAmounts(total+1, total, lcReserve, hbdReserve); ok {
		t.Fatal("withdrawing more shares than exist was accepted")
	}
	if _, _, ok := WithdrawAmounts(0, total, lcReserve, hbdReserve); ok {
		t.Fatal("zero-share withdrawal accepted")
	}
}

// --- reward weight --------------------------------------------------------

func TestTrancheWeightAppliesLoyalty(t *testing.T) {
	shares := Shares(LC(1_000))

	fresh := TrancheWeight(shares, 0)
	if fresh != shares {
		t.Fatalf("fresh tranche weight %s, want %s", fmtLC(Amount(fresh)), fmtLC(Amount(shares)))
	}
	mature := TrancheWeight(shares, 90)
	want := Shares(LC(1_900))
	if mature != want {
		t.Fatalf("90-day tranche weight %s, want %s", fmtLC(Amount(mature)), fmtLC(Amount(want)))
	}
	// A mature tranche earns 1.9x a fresh one of equal size.
	t.Logf("1,000 shares: fresh weight %s, 90-day weight %s",
		fmtLC(Amount(fresh)), fmtLC(Amount(mature)))

	if got := TrancheWeight(0, 90); got != 0 {
		t.Fatalf("zero shares should weigh nothing, got %d", got)
	}
}

// --- spot-price conversion ------------------------------------------------

// TestLcToHbdUsesSpotPriceAndFloors pins the "≈ X HBD" figure shown beside
// LASSECASH amounts across the UI. The conversion lives here rather than in
// the frontend for the same reason ShareRateInHbd does: it is money math, and
// a second copy in TypeScript would drift.
func TestLcToHbdUsesSpotPriceAndFloors(t *testing.T) {
	// The measured opening ratio: 1,000,000 LC alongside 1,030 HBD.
	lcReserve, hbdReserve := LC(1_000_000), LC(1_030)

	got, ok := LcToHbd(LC(1_000), lcReserve, hbdReserve)
	if !ok {
		t.Fatal("a seeded pool must produce a price")
	}
	if want := Amount(103_000_000); got != want { // 1.03 HBD
		t.Fatalf("1,000 LC -> %s HBD, want %s", fmtLC(got), fmtLC(want))
	}

	// Zero converts to zero rather than failing: an account with nothing has a
	// knowable HBD value, and it is nothing.
	if v, ok := LcToHbd(0, lcReserve, hbdReserve); !ok || v != 0 {
		t.Fatalf("zero converted to %s (ok=%v), want 0/true", fmtLC(v), ok)
	}

	// FLOORS. One base unit at this price is worth a fraction of a base unit of
	// HBD; showing 0.00000001 would be money that is not there.
	if v, ok := LcToHbd(1, lcReserve, hbdReserve); !ok || v != 0 {
		t.Fatalf("one base unit converted to %s (ok=%v), want 0/true", fmtLC(v), ok)
	}

	// UNSEEDED POOL: no price exists, so there is nothing to show. Callers must
	// get a refusal, never a zero that reads as "worthless".
	if _, ok := LcToHbd(LC(1_000), 0, hbdReserve); ok {
		t.Fatal("an empty LC reserve produced a price")
	}
	if _, ok := LcToHbd(LC(1_000), lcReserve, 0); ok {
		t.Fatal("an empty HBD reserve produced a price")
	}
	if _, ok := LcToHbd(-1, lcReserve, hbdReserve); ok {
		t.Fatal("a negative amount produced a price")
	}
}

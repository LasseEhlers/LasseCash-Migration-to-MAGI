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

func TestHbdMilliConversionNeverUnderCustodies(t *testing.T) {
	cases := []struct {
		units     Amount
		draw, pay int64
	}{
		{0, 0, 0},
		{1, 1, 0}, // a dust draw still custodies a whole milli
		{99_999, 1, 0},
		{100_000, 1, 1},           // exactly 0.001 HBD
		{200_000_000, 2000, 2000}, // 2 HBD — the mainnet case
		{200_000_001, 2001, 2000},
	}
	for _, c := range cases {
		if got := HbdDrawMilli(c.units); got != c.draw {
			t.Errorf("draw %d: got %d want %d", c.units, got, c.draw)
		}
		if got := HbdPayMilli(c.units); got != c.pay {
			t.Errorf("pay %d: got %d want %d", c.units, got, c.pay)
		}
		if HbdDrawMilli(c.units)*HbdUnitsPerMilli < int64(c.units) || HbdPayMilli(c.units)*HbdUnitsPerMilli > int64(c.units) {
			t.Errorf("%d: custody could fall below the ledger", c.units)
		}
	}
}

// TestTrancheDormancyAtEveryBoundary names the days where an off-by-one would
// evict a liquidity provider who was still inside their window, rather than
// sampling the middle and hoping.
func TestTrancheDormancyAtEveryBoundary(t *testing.T) {
	const touch = uint64(109_000_000)
	day := func(d int64) uint64 { return touch + uint64(d)*HeightsPerDay }

	cases := []struct {
		days int64
		want bool
		why  string
	}{
		{0, false, "the moment of the claim"},
		{89, false, "just before the warning starts"},
		{90, false, "warning period — still safe"},
		{179, false, "one day before eviction becomes possible"},
		{180, true, "exactly six months — evictable"},
		{181, true, "past six months"},
		{10_000, true, "long gone"},
	}
	for _, c := range cases {
		if got := TrancheIsDormant(touch, day(c.days)); got != c.want {
			t.Errorf("day %d (%s): dormant = %v, want %v", c.days, c.why, got, c.want)
		}
	}

	// A height at or before the last touch must never read as dormant — a
	// clock that runs backwards must not evict anyone.
	if TrancheIsDormant(touch, touch-1) {
		t.Error("a height before the last touch read as dormant")
	}
}

// TestTrancheHealthWarnsLongBeforeEviction pins what the interface is told. An
// LP who cannot see the clock cannot answer it, and the eviction costs them
// their loyalty age — so the warning must arrive a full 90 days early.
func TestTrancheHealthWarnsLongBeforeEviction(t *testing.T) {
	const touch = uint64(109_000_000)
	at := func(d int64) TrancheHealth {
		return TrancheHealthAt(touch, touch+uint64(d)*HeightsPerDay)
	}
	if h := at(0); h.Phase != 0 || h.DaysUntilEvict != 180 || h.DormantDays != 0 {
		t.Errorf("fresh: phase %d, %d days left, %d dormant; want 0, 180, 0",
			h.Phase, h.DaysUntilEvict, h.DormantDays)
	}
	if h := at(89); h.Phase != 0 {
		t.Errorf("day 89: phase %d, want 0 (still healthy)", h.Phase)
	}
	if h := at(90); h.Phase != 1 {
		t.Errorf("day 90: phase %d, want 1 (90-day warning begins)", h.Phase)
	}
	if h := at(179); h.Phase != 1 || h.DaysUntilEvict != 1 {
		t.Errorf("day 179: phase %d, %d days left; want 1, 1", h.Phase, h.DaysUntilEvict)
	}
	if h := at(180); h.Phase != 2 || h.DaysUntilEvict != 0 {
		t.Errorf("day 180: phase %d, %d days left; want 2, 0", h.Phase, h.DaysUntilEvict)
	}
	if h := at(365); h.DormantDays != 365 {
		t.Errorf("day 365: dormant %d days, want 365", h.DormantDays)
	}
}

// TestAliveSupplyIsAMeasurementNotAMechanism pins the figure nobody else in
// crypto can produce — and pins that it only ever reports, never moves value.
func TestAliveSupplyIsAMeasurementNotAMechanism(t *testing.T) {
	// A realistic Hive height. A toy value underflows the helper below:
	// 400 days is 11.5M heights, so subtracting it from 10M wraps around
	// uint64 and reads as the far future.
	const now = uint64(109_000_000)
	dayAgo := func(d int64) uint64 { return now - uint64(d)*HeightsPerDay }

	cases := []struct {
		lastSeen uint64
		window   int64
		want     bool
		why      string
	}{
		{dayAgo(0), 90, true, "acted this block"},
		{dayAgo(89), 90, true, "one day inside the window"},
		{dayAgo(90), 90, true, "exactly on the boundary counts as alive"},
		{dayAgo(91), 90, false, "one day outside"},
		{dayAgo(91), 365, true, "outside 90 days, inside a year"},
		{dayAgo(400), 365, false, "outside a year"},
		{dayAgo(400), 730, true, "outside a year, inside two"},
		{0, 730, false, "never seen acting is never alive"},
		{now + 1, 90, true, "a clock that ran backwards must not read as dead"},
	}
	for _, c := range cases {
		if got := IsAlive(c.lastSeen, now, c.window); got != c.want {
			t.Errorf("%s: IsAlive = %v, want %v", c.why, got, c.want)
		}
	}

	// The percentage floors and can never exceed 100%, so the headline figure
	// cannot overstate how much of the supply is provably held.
	if got := AlivePct(0, 1000); got != 0 {
		t.Errorf("nothing alive: %d, want 0", got)
	}
	if got := AlivePct(1000, 1000); got != MultScale {
		t.Errorf("all alive: %d, want %d", got, MultScale)
	}
	if got := AlivePct(2000, 1000); got != MultScale {
		t.Errorf("more alive than exists must clamp: %d, want %d", got, MultScale)
	}
	if got := AlivePct(1, 3); got != MultScale/3 {
		t.Errorf("one third: %d, want %d", got, MultScale/3)
	}
	if got := AlivePct(5, 0); got != 0 {
		t.Errorf("empty supply: %d, want 0", got)
	}
}

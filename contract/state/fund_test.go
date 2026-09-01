package state

import "testing"

// Funding exists because emission ENDS and recycling feeds only the L-Share
// pool. Without it, Proof-of-Brain and liquidity have no funding source once
// emission runs out, and nothing outside the contract could ever add one —
// permanently, after the owner key burns.
//
// These pin the properties that make it safe to add to an immutable contract:
// it conserves supply, it credits each pool the way emission does, and it
// grants nobody anything they could not already do.

func TestFundPoolMovesValueWithoutCreatingIt(t *testing.T) {
	s, ctx := newChain(t)
	if r := creditLiquid(s, "hive:sponsor", lc(1_000)); !r.OK {
		t.Fatalf("setup: %s", r.Msg)
	}
	auditSupply(t, s)

	before := Balance(s, "hive:sponsor")
	c := ctx
	c.Sender = "hive:sponsor"

	if r := FundPool(s, c, "pob", lc(400)); !r.OK {
		t.Fatalf("fund pob: %s", r.Msg)
	}
	// THE INVARIANT THAT MATTERS: value moved, none was created. Pools are
	// already counted by the audit, so a balance emptying into one must leave
	// the total exactly where it was.
	auditSupply(t, s)

	if got := Balance(s, "hive:sponsor"); got != before-lc(400) {
		t.Fatalf("balance %d, want %d", got, before-lc(400))
	}
	// PoB splits viral/deep on the same rule emission uses, and the two halves
	// must sum to the whole — both flooring independently would lose a unit.
	viral := getAmount(s, keyPoolViral)
	deep := getAmount(s, keyPoolDeep)
	if viral+deep != lc(400) {
		t.Fatalf("viral %d + deep %d != %d", viral, deep, lc(400))
	}
	if viral == 0 || deep == 0 {
		t.Fatal("PoB funding must reach both windows")
	}
}

func TestFundPoolReachesEveryPool(t *testing.T) {
	s, ctx := newChain(t)
	if r := creditLiquid(s, "hive:sponsor", lc(4_000)); !r.OK {
		t.Fatalf("setup: %s", r.Msg)
	}
	c := ctx
	c.Sender = "hive:sponsor"

	liqBefore := getAmount(s, keyPoolLiquidity)
	if r := FundPool(s, c, "liquidity", lc(500)); !r.OK {
		t.Fatalf("fund liquidity: %s", r.Msg)
	}
	if getAmount(s, keyPoolLiquidity) != liqBefore+lc(500) {
		t.Fatal("liquidity pool did not receive the funding")
	}
	auditSupply(t, s)

	// The L-Share pool MUST go through the accumulator. Value added without
	// raising it would sit in the pool unclaimable by anyone, forever.
	accBefore := getU64(s, keyAccPerShare)
	lsBefore := getAmount(s, keyPoolLShare)
	if r := FundPool(s, c, "lshare", lc(500)); !r.OK {
		t.Fatalf("fund lshare: %s", r.Msg)
	}
	if getAmount(s, keyPoolLShare) != lsBefore+lc(500) {
		t.Fatal("L-Share pool did not receive the funding")
	}
	if getU64(s, keyAccPerShare) == accBefore && getAmount(s, keyAccHeld) == 0 {
		t.Fatal("L-Share funding bypassed the accumulator — it would be unclaimable")
	}
	auditSupply(t, s)

	// "all" follows the block split, and the remainder lands in the L-Share
	// pool so flooring cannot lose a base unit.
	total := getAmount(s, keyPoolViral) + getAmount(s, keyPoolDeep) +
		getAmount(s, keyPoolLiquidity) + getAmount(s, keyPoolLShare)
	if r := FundPool(s, c, "all", lc(1_000)); !r.OK {
		t.Fatalf("fund all: %s", r.Msg)
	}
	after := getAmount(s, keyPoolViral) + getAmount(s, keyPoolDeep) +
		getAmount(s, keyPoolLiquidity) + getAmount(s, keyPoolLShare)
	if after-total != lc(1_000) {
		t.Fatalf("split lost value: pools grew %d, funded %d", after-total, lc(1_000))
	}
	auditSupply(t, s)
}

// Every pool must be addressable on its own. After the key burn no target can
// ever be added, so a sponsor who wants to fund long-form writing specifically
// must be able to say `deep` today or never.
func TestFundPoolTargetsEachPoolIndividually(t *testing.T) {
	s, ctx := newChain(t)
	if r := creditLiquid(s, "hive:sponsor", lc(4_000)); !r.OK {
		t.Fatalf("setup: %s", r.Msg)
	}
	c := ctx
	c.Sender = "hive:sponsor"

	for _, tc := range []struct {
		target string
		key    string
	}{
		{"viral", keyPoolViral},
		{"deep", keyPoolDeep},
		{"liquidity", keyPoolLiquidity},
	} {
		before := getAmount(s, tc.key)
		if r := FundPool(s, c, tc.target, lc(100)); !r.OK {
			t.Fatalf("fund %s: %s", tc.target, r.Msg)
		}
		if got := getAmount(s, tc.key) - before; got != lc(100) {
			t.Fatalf("%s received %d, want %d", tc.target, got, lc(100))
		}
		auditSupply(t, s)
	}
}

func TestFundPoolRefusesWhatItShould(t *testing.T) {
	s, ctx := newChain(t)
	if r := creditLiquid(s, "hive:sponsor", lc(10)); !r.OK {
		t.Fatalf("setup: %s", r.Msg)
	}
	c := ctx
	c.Sender = "hive:sponsor"

	if r := FundPool(s, c, "pob", lc(11)); r.OK {
		t.Fatal("funding more than the balance was accepted")
	}
	if r := FundPool(s, c, "pob", 0); r.OK {
		t.Fatal("zero funding accepted")
	}
	if r := FundPool(s, c, "treasury", lc(1)); r.OK {
		t.Fatal("unknown pool name accepted — a typo must never silently burn")
	}
	// The null account holds every burned token and has no keys. Fail closed.
	n := ctx
	n.Sender = BurnAccount
	if r := FundPool(s, n, "pob", lc(1)); r.OK {
		t.Fatal("null was allowed to act")
	}
	auditSupply(t, s)
}

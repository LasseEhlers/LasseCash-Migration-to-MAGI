package engine

import (
	"fmt"
	"testing"
)

// --- pool splits ----------------------------------------------------------

func TestPoBSplitsLoseNothing(t *testing.T) {
	for _, in := range []Amount{0, 1, 2, 3, 7, 99, 100, 101, LC(1), LC(3_333_333), EmissionCap} {
		v, d := SplitPoB(in)
		if in <= 0 {
			if v != 0 || d != 0 {
				t.Fatalf("SplitPoB(%d) = %d,%d want 0,0", in, v, d)
			}
			continue
		}
		if v+d != in {
			t.Fatalf("SplitPoB(%s): viral %s + deep %s = %s, want %s",
				fmtLC(in), fmtLC(v), fmtLC(d), fmtLC(v+d), fmtLC(in))
		}
		if d < v {
			t.Fatalf("SplitPoB(%s): deep %s should exceed viral %s (75/25)",
				fmtLC(in), fmtLC(d), fmtLC(v))
		}
	}
}

// The full chain from a block reward down to the two content pools.
func TestBlockRewardReachesPoBPools(t *testing.T) {
	s := testSchedule()
	s.GenesisHeight = gen
	perHeight := s.RewardPerHeight(0)
	alloc := Split(perHeight)
	viral, deep := SplitPoB(alloc.ProofOfBrain)

	if alloc.Total() != perHeight {
		t.Fatalf("block split lost value: %s vs %s", fmtLC(alloc.Total()), fmtLC(perHeight))
	}
	if viral+deep != alloc.ProofOfBrain {
		t.Fatalf("PoB split lost value")
	}
	t.Logf("era-1 per height %s -> PoB %s -> viral %s / deep %s",
		fmtLC(perHeight), fmtLC(alloc.ProofOfBrain), fmtLC(viral), fmtLC(deep))
}

// --- vote power -----------------------------------------------------------

func TestVotePowerRegenPerWindow(t *testing.T) {
	for _, w := range []Window{Viral, Deep} {
		vp := VotePower{Power: 0, LastHeight: gen}
		full := w.RegenHeights()

		if got := vp.Current(w, gen); got != 0 {
			t.Fatalf("%v: empty meter should read 0, got %d", w, got)
		}
		if got := vp.Current(w, gen+full/2); got < MultScale/2-100 || got > MultScale/2+100 {
			t.Fatalf("%v: half a regen period should be ~50%%, got %d", w, got)
		}
		if got := vp.Current(w, gen+full); got != MultScale {
			t.Fatalf("%v: full regen period should be 100%%, got %d", w, got)
		}
		// Must cap at 100%, never accumulate beyond.
		if got := vp.Current(w, gen+full*100); got != MultScale {
			t.Fatalf("%v: power exceeded 100%%: %d", w, got)
		}
	}
	// Viral recharges faster than deep — that is the whole distinction.
	if Viral.RegenHeights() >= Deep.RegenHeights() {
		t.Fatal("viral must regenerate faster than deep")
	}
}

func TestFullVoteCostsTenPercent(t *testing.T) {
	if got := VoteCost(100); got != MultScale*FullVoteCostPct/100 {
		t.Fatalf("full vote costs %d, want %d%% of total", got, FullVoteCostPct)
	}
	if got := VoteCost(50); got != MultScale*FullVoteCostPct/200 {
		t.Fatalf("half vote should cost half of a full vote, got %d", got)
	}
	if got := VoteCost(0); got != 0 {
		t.Fatalf("zero-weight vote should cost nothing, got %d", got)
	}
	// Over-100 must clamp, not extrapolate.
	if VoteCost(1000) != VoteCost(100) {
		t.Fatal("weight above 100% must clamp")
	}
}

func TestTenFullVotesEmptyTheMeter(t *testing.T) {
	vp := NewVotePower(gen)
	for i := 0; i < 10; i++ {
		next, ok := vp.Spend(Viral, gen, 100)
		if !ok {
			t.Fatalf("vote %d refused with power remaining %d", i+1, vp.Current(Viral, gen))
		}
		vp = next
	}
	if got := vp.Current(Viral, gen); got != 0 {
		t.Fatalf("after 10 full votes power should be 0, got %d", got)
	}
	// The 11th must be refused, not silently weakened.
	if _, ok := vp.Spend(Viral, gen, 100); ok {
		t.Fatal("11th full vote should be refused")
	}
}

// Refusing rather than clamping matters: a silently weaker vote would
// misreport the user's influence back to them.
func TestOverdraftIsRefusedNotClamped(t *testing.T) {
	vp := VotePower{Power: MultScale / 100, LastHeight: gen} // 1% left
	before := vp.Current(Viral, gen)
	after, ok := vp.Spend(Viral, gen, 100)
	if ok {
		t.Fatal("a full vote on 1% power should be refused")
	}
	if after.Current(Viral, gen) != before {
		t.Fatal("a refused vote must not consume power")
	}
}

func TestWindowsRegenerateIndependently(t *testing.T) {
	viral := NewVotePower(gen)
	deep := NewVotePower(gen)
	// Exhaust viral entirely.
	for i := 0; i < 10; i++ {
		viral, _ = viral.Spend(Viral, gen, 100)
	}
	if viral.Current(Viral, gen) != 0 {
		t.Fatal("viral should be empty")
	}
	if deep.Current(Deep, gen) != MultScale {
		t.Fatal("spending viral power must not touch deep power")
	}
}

// --- reward distribution --------------------------------------------------

func TestPoolClaimIsProportionalAndBounded(t *testing.T) {
	p := &Pool{}
	p.Add(LC(1_000))
	p.AddRshares(1_000)

	// A post holding 30% of rshares takes 30% of the pool.
	got := p.Claim(300)
	if got != LC(300) {
		t.Fatalf("30%% claim paid %s, want %s", fmtLC(got), fmtLC(LC(300)))
	}
	if p.Balance != LC(700) || p.Rshares != 700 {
		t.Fatalf("pool not reduced correctly: %s / %d", fmtLC(p.Balance), p.Rshares)
	}
	// Claiming everything drains it exactly.
	if got := p.Claim(700); got != LC(700) {
		t.Fatalf("final claim paid %s, want %s", fmtLC(got), fmtLC(LC(700)))
	}
	if p.Balance != 0 {
		t.Fatalf("pool should be empty, holds %s", fmtLC(p.Balance))
	}
	// Further claims must yield nothing rather than going negative.
	if got := p.Claim(100); got != 0 {
		t.Fatalf("claim on empty pool paid %s", fmtLC(got))
	}
}

func TestPoolCannotBeOverdrawn(t *testing.T) {
	p := &Pool{}
	p.Add(LC(100))
	p.AddRshares(100)
	// Claim more rshares than exist — must clamp, not over-pay.
	got := p.Claim(1_000_000)
	if got > LC(100) {
		t.Fatalf("overdrew pool: paid %s from %s", fmtLC(got), fmtLC(LC(100)))
	}
	if p.Balance < 0 {
		t.Fatalf("pool went negative: %s", fmtLC(p.Balance))
	}
}

// THE conservation invariant for content payouts.
func TestPayoutConservesValue(t *testing.T) {
	for _, nVotes := range []int{0, 1, 2, 7, 201} { // 201 = a real post from lassecash.com
		p := &Pool{}
		p.Add(LC(5_000))
		post := &Post{Author: "author", Window: Viral, CreatedHeight: gen}

		for i := 0; i < nVotes; i++ {
			r := int64((i%13 + 1) * 1000)
			p.AddRshares(r)
			if !post.AddVote(Vote{Voter: fmt.Sprintf("v%d", i), Rshares: r}, gen) {
				t.Fatalf("vote %d refused", i)
			}
		}
		if nVotes == 0 {
			p.AddRshares(0)
		}

		author, curators, total := post.Payout(p)
		sum := author.Total()
		for _, c := range curators {
			sum += c.Total()
		}
		if sum != total {
			t.Fatalf("%d votes: rewards total %s but pool paid %s (leak %s)",
				nVotes, fmtLC(sum), fmtLC(total), fmtLC(total-sum))
		}
		if total > LC(5_000) {
			t.Fatalf("%d votes: paid %s from a %s pool", nVotes, fmtLC(total), fmtLC(LC(5_000)))
		}
	}
}

func TestAuthorCuratorSplitIs75_25(t *testing.T) {
	p := &Pool{}
	p.Add(LC(1_000))
	p.AddRshares(1_000)
	post := &Post{Author: "author", Window: Deep, CreatedHeight: gen}
	// Four equal curators.
	for i := 0; i < 4; i++ {
		post.AddVote(Vote{Voter: fmt.Sprintf("c%d", i), Rshares: 250}, gen)
	}

	author, curators, total := post.Payout(p)
	if len(curators) != 4 {
		t.Fatalf("expected 4 curator rewards, got %d", len(curators))
	}
	var curatorTotal Amount
	for _, c := range curators {
		curatorTotal += c.Total()
	}
	wantCurators, _ := MulDiv(total, CuratorPct, 100)
	if curatorTotal != wantCurators {
		t.Fatalf("curators got %s, want %s (25%%)", fmtLC(curatorTotal), fmtLC(wantCurators))
	}
	if author.Total() != total-curatorTotal {
		t.Fatalf("author got %s, want %s", fmtLC(author.Total()), fmtLC(total-curatorTotal))
	}
	t.Logf("pool %s -> author %s (75%%) + %d curators %s (25%%)",
		fmtLC(total), fmtLC(author.Total()), len(curators), fmtLC(curatorTotal))
}

// A post with no votes must pay nothing and not strand pool value.
func TestUnvotedPostPaysNothing(t *testing.T) {
	p := &Pool{}
	p.Add(LC(1_000))
	p.AddRshares(1_000)
	post := &Post{Author: "lonely", Window: Viral, CreatedHeight: gen}

	author, curators, total := post.Payout(p)
	if total != 0 || author.Total() != 0 || len(curators) != 0 {
		t.Fatalf("unvoted post paid out: total %s author %s curators %d",
			fmtLC(total), fmtLC(author.Total()), len(curators))
	}
	if p.Balance != LC(1_000) {
		t.Fatalf("pool was drained by an unvoted post: %s", fmtLC(p.Balance))
	}
}

func TestDoublePayoutRefused(t *testing.T) {
	p := &Pool{}
	p.Add(LC(1_000))
	p.AddRshares(100)
	post := &Post{Author: "a", Window: Viral, CreatedHeight: gen}
	post.AddVote(Vote{Voter: "v", Rshares: 100}, gen)

	_, _, first := post.Payout(p)
	if first <= 0 {
		t.Fatal("first payout should pay")
	}
	_, _, second := post.Payout(p)
	if second != 0 {
		t.Fatalf("second payout paid %s — double spend", fmtLC(second))
	}
}

func TestVotingClosesAtPayoutHeight(t *testing.T) {
	post := &Post{Author: "a", Window: Viral, CreatedHeight: gen}
	end := post.PayoutHeight()
	if (end-gen)/HeightsPerDay != ViralPayoutDays {
		t.Fatalf("viral window is %d days, want %d", (end-gen)/HeightsPerDay, ViralPayoutDays)
	}
	if !post.AddVote(Vote{Voter: "early", Rshares: 10}, end-1) {
		t.Fatal("vote just before payout should be accepted")
	}
	if post.AddVote(Vote{Voter: "late", Rshares: 10}, end) {
		t.Fatal("vote at payout height should be refused")
	}
	if post.AddVote(Vote{Voter: "later", Rshares: 10}, end+HeightsPerDay) {
		t.Fatal("vote after payout should be refused")
	}
}

func TestRevoteReplacesRatherThanStacks(t *testing.T) {
	post := &Post{Author: "a", Window: Deep, CreatedHeight: gen}
	post.AddVote(Vote{Voter: "v", Rshares: 100}, gen)
	post.AddVote(Vote{Voter: "v", Rshares: 300}, gen)
	if post.Rshares != 300 {
		t.Fatalf("re-vote stacked: rshares %d, want 300", post.Rshares)
	}
	if len(post.Votes) != 1 {
		t.Fatalf("re-vote duplicated the voter: %d entries", len(post.Votes))
	}
}

// --- payout routing -------------------------------------------------------

func TestRoutePayoutIs20_80(t *testing.T) {
	for _, in := range []Amount{0, 1, 5, 99, 100, LC(1), LC(1234), LC(999_999)} {
		l, p := RoutePayout(in)
		if l+p != in {
			t.Fatalf("RoutePayout(%s) lost value: %s + %s", fmtLC(in), fmtLC(l), fmtLC(p))
		}
		if in > 0 && l > p {
			t.Fatalf("RoutePayout(%s): liquid %s should not exceed pending %s",
				fmtLC(in), fmtLC(l), fmtLC(p))
		}
	}
	l, p := RoutePayout(LC(100))
	if l != LC(20) || p != LC(80) {
		t.Fatalf("100 LC routed to %s liquid / %s pending, want 20/80", fmtLC(l), fmtLC(p))
	}
}

// --- monthly aggregation --------------------------------------------------

// The reason PoB does not mint per payout: one integer per account, not a row.
func TestMonthlyMintAggregatesPayouts(t *testing.T) {
	pd := Pending{}
	// A prolific author: 30 posts plus 200 curation rewards in a month.
	for i := 0; i < 230; i++ {
		pd.Accrue("author", LC(10))
	}
	if len(pd) != 1 {
		t.Fatalf("230 payouts produced %d pending entries, want 1", len(pd))
	}

	pd.Touch("author", 1)
	reqs := pd.CollectMonthly(2, func(string) int64 { return MaxMintDays })
	if len(reqs) != 1 {
		t.Fatalf("230 payouts produced %d mints, want 1", len(reqs))
	}
	if reqs[0].Amount != LC(2_300) {
		t.Fatalf("aggregated %s, want %s", fmtLC(reqs[0].Amount), fmtLC(LC(2_300)))
	}
	// The BALANCE drains, but the record stays: it carries LastEpoch, which is
	// what stops the account minting twice in the same month.
	if pd.Balance("author") != 0 {
		t.Fatalf("pending balance not drained: %s", fmtLC(pd.Balance("author")))
	}
	if pd["author"].LastEpoch != 2 {
		t.Fatalf("epoch anchor not advanced: %d", pd["author"].LastEpoch)
	}
	// Settling again in the same month must do nothing.
	if _, ok := pd.SettleAccount("author", 2, 365); ok {
		t.Fatal("account minted twice in one month")
	}
	t.Logf("230 separate payouts -> 1 mint of %s for %d days",
		fmtLC(reqs[0].Amount), reqs[0].Days)
}

// Dust rolls over instead of creating a row of 0.00000001.
func TestDustRollsOverInsteadOfMinting(t *testing.T) {
	pd := Pending{}
	pd.Accrue("small", MinMintAmount-1)
	pd.Touch("small", 1)
	reqs := pd.CollectMonthly(2, func(string) int64 { return 365 })
	if len(reqs) != 0 {
		t.Fatalf("dust balance minted: %+v", reqs)
	}
	if pd.Balance("small") != MinMintAmount-1 {
		t.Fatalf("dust was lost rather than rolled over: %s", fmtLC(pd.Balance("small")))
	}
	// Next month it crosses the threshold and mints the accumulated total.
	pd.Accrue("small", LC(1))
	reqs = pd.CollectMonthly(3, func(string) int64 { return 365 })
	if len(reqs) != 1 {
		t.Fatalf("accumulated balance did not mint: %+v", reqs)
	}
	if reqs[0].Amount != MinMintAmount-1+LC(1) {
		t.Fatalf("rolled-over amount wrong: %s", fmtLC(reqs[0].Amount))
	}
}

// A bad settings value must not strand a user's rewards.
func TestBadDurationSettingIsClampedNotRejected(t *testing.T) {
	pd := Pending{}
	pd.Accrue("a", LC(100))
	pd.Accrue("b", LC(100))
	pd.Accrue("c", LC(100))
	durations := map[string]int64{"a": -5, "b": 99_999, "c": 500}

	for a := range durations {
		pd.Touch(a, 1)
	}
	reqs := pd.CollectMonthly(2, func(acct string) int64 { return durations[acct] })
	if len(reqs) != 3 {
		t.Fatalf("expected 3 mints, got %d", len(reqs))
	}
	for _, r := range reqs {
		if r.Days < MinMintDays || r.Days > MaxMintDays {
			t.Fatalf("%s: duration %d outside 1..1095", r.Account, r.Days)
		}
	}
}

// Validators must agree on the order mints are created in.
func TestMonthlyCollectionIsDeterministic(t *testing.T) {
	var first []MonthlyMintRequest
	for run := 0; run < 25; run++ {
		pd := Pending{}
		for i := 0; i < 40; i++ {
			pd.Accrue(fmt.Sprintf("user%02d", i), LC(int64(i+10)))
		}
		for i := 0; i < 40; i++ {
			pd.Touch(fmt.Sprintf("user%02d", i), 1)
		}
		reqs := pd.CollectMonthly(2, func(string) int64 { return 1095 })
		if first == nil {
			first = reqs
			continue
		}
		if len(reqs) != len(first) {
			t.Fatal("collection size varied between runs")
		}
		for i := range reqs {
			if reqs[i].Account != first[i].Account || reqs[i].Amount != first[i].Amount {
				t.Fatalf("collection order varied at %d: %s vs %s",
					i, reqs[i].Account, first[i].Account)
			}
		}
	}
}

// --- end to end -----------------------------------------------------------

// A month of blogging: emission -> pools -> posts -> pending -> one mint.
func TestFullMonthEndToEnd(t *testing.T) {
	s := testSchedule()
	s.GenesisHeight = gen

	// One month of emission into the viral pool.
	month := uint64(30) * HeightsPerDay
	emitted := s.EmissionBetween(gen, gen+month)
	alloc := Split(emitted)
	viralAmt, deepAmt := SplitPoB(alloc.ProofOfBrain)

	viralPool := &Pool{}
	viralPool.Add(viralAmt)

	pd := Pending{}
	var liquidPaid Amount

	// 30 posts, each with 20 curators.
	for i := 0; i < 30; i++ {
		post := &Post{Author: "blogger", Window: Viral, CreatedHeight: gen}
		for j := 0; j < 20; j++ {
			r := int64(1_000 + j*100)
			viralPool.AddRshares(r)
			post.AddVote(Vote{Voter: fmt.Sprintf("curator%02d", j), Rshares: r}, gen)
		}
		author, curators, _ := post.Payout(viralPool)
		pd.Accrue(author.Account, author.ToPending)
		liquidPaid += author.Liquid
		for _, c := range curators {
			pd.Accrue(c.Account, c.ToPending)
			liquidPaid += c.Liquid
		}
	}

	pd.Touch("author", 1)
	reqs := pd.CollectMonthly(2, func(string) int64 { return MaxMintDays })

	t.Logf("one month: emitted %s -> PoB %s (viral %s / deep %s)",
		fmtLC(emitted), fmtLC(alloc.ProofOfBrain), fmtLC(viralAmt), fmtLC(deepAmt))
	t.Logf("30 posts x 20 curators = %d payouts -> %d mints, %s liquid",
		30*21, len(reqs), fmtLC(liquidPaid))

	// 630 payouts must collapse into at most 21 mints (1 author + 20 curators).
	if len(reqs) > 21 {
		t.Fatalf("630 payouts produced %d mints — aggregation failed", len(reqs))
	}
	// And nothing may exceed what the pool held.
	var minted Amount
	for _, r := range reqs {
		minted += r.Amount
	}
	if minted+liquidPaid > viralAmt {
		t.Fatalf("paid out %s from a %s pool", fmtLC(minted+liquidPaid), fmtLC(viralAmt))
	}
}

// --- posting thresholds ---------------------------------------------------

func TestPostingThresholdsComeFromGovernance(t *testing.T) {
	r := NewRegistry()
	g := NewGovernance()
	var hs []Holder
	for i := 0; i < 10; i++ {
		hs = append(hs, Holder{fmt.Sprintf("m%d", i), Shares(int64(100-i) * ShareUnit)})
	}
	members := ConsensusGroup(hs)

	if ThresholdKeyFor(Viral) != ParamPostThresholdViral ||
		ThresholdKeyFor(Deep) != ParamPostThresholdDeep {
		t.Fatal("threshold keys mismatched")
	}

	// Members raise the viral threshold to 50 L-Shares.
	for i := 0; i < 10; i++ {
		g.SetPreference(r, members, fmt.Sprintf("m%d", i), ParamPostThresholdViral, 50*ShareUnit)
	}
	th := g.Effective(r, members, ParamPostThresholdViral)

	if CanPost(Shares(49*ShareUnit), th) {
		t.Fatal("account below threshold was allowed to post")
	}
	if !CanPost(Shares(50*ShareUnit), th) {
		t.Fatal("account exactly at threshold was refused")
	}
	if !CanPost(Shares(5_000*ShareUnit), th) {
		t.Fatal("account above threshold was refused")
	}
}

// --- lazy settlement (the on-chain path) ---------------------------------

// A global monthly sweep would blow the gas budget once thousands of accounts
// have pending balances. SettleAccount is O(1) and runs when an account is
// next touched — the same "compute on touch" discipline as emission.
func TestLazySettlementIsPerAccount(t *testing.T) {
	pd := Pending{}
	pd.Accrue("alice", LC(500))
	pd.Touch("alice", 10)

	// Same month: nothing due.
	if _, ok := pd.SettleAccount("alice", 10, 1095); ok {
		t.Fatal("settled within the same month")
	}
	// Next month: one mint.
	req, ok := pd.SettleAccount("alice", 11, 1095)
	if !ok {
		t.Fatal("month boundary did not trigger a mint")
	}
	if req.Amount != LC(500) || req.Days != 1095 {
		t.Fatalf("unexpected request: %+v", req)
	}
	// Immediately again: nothing left.
	if _, ok := pd.SettleAccount("alice", 11, 1095); ok {
		t.Fatal("double mint in one month")
	}
	// Unknown accounts must be safe.
	if _, ok := pd.SettleAccount("nobody", 12, 365); ok {
		t.Fatal("unknown account produced a mint")
	}
}

// Skipping months must not mint once per skipped month.
func TestLongGapMintsOnceNotPerMonth(t *testing.T) {
	pd := Pending{}
	pd.Accrue("bob", LC(300))
	pd.Touch("bob", 1)

	req, ok := pd.SettleAccount("bob", 25, 365) // two years later
	if !ok {
		t.Fatal("no mint after a long gap")
	}
	if req.Amount != LC(300) {
		t.Fatalf("minted %s, want the whole accrued %s", fmtLC(req.Amount), fmtLC(LC(300)))
	}
	if _, ok := pd.SettleAccount("bob", 25, 365); ok {
		t.Fatal("second mint for the same gap")
	}
}

// An account must not mint a partial first month it did not accrue through.
func TestFirstSightingAnchorsWithoutMinting(t *testing.T) {
	pd := Pending{}
	pd.Accrue("carol", LC(999))
	// No Touch: first SettleAccount should anchor, not mint.
	if _, ok := pd.SettleAccount("carol", 7, 365); ok {
		t.Fatal("minted on first sighting instead of anchoring")
	}
	if pd.Balance("carol") != LC(999) {
		t.Fatalf("balance disturbed on anchor: %s", fmtLC(pd.Balance("carol")))
	}
	if pd["carol"].LastEpoch != 7 {
		t.Fatalf("anchor not set: %d", pd["carol"].LastEpoch)
	}
	// The following month it mints normally.
	if _, ok := pd.SettleAccount("carol", 8, 365); !ok {
		t.Fatal("did not mint the month after anchoring")
	}
}

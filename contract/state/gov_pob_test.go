package state

import (
	"fmt"
	"testing"

	"github.com/lassecash/engine"
)

// seedHolders gives n accounts descending L-Shares via real mints, so the
// leaderboard is built the same way it would be in production.
func seedHolders(t *testing.T, s *MemStore, ctx Ctx, n int) []string {
	t.Helper()
	names := make([]string, n)
	for i := 0; i < n; i++ {
		acct := fmt.Sprintf("hive:h%02d", i)
		names[i] = acct
		amt := lc(int64(1_000 * (n - i)))
		if r := creditLiquid(s, acct, amt); !r.OK {
			t.Fatalf("credit %s: %s", acct, r.Msg)
		}
		if _, r := CreateMint(s, at(ctx, acct, genesis), amt, 1095); !r.OK {
			t.Fatalf("mint %s: %s", acct, r.Msg)
		}
	}
	return names
}

// --- leaderboard ----------------------------------------------------------

// The board must find the top 10 without ever scanning all accounts.
func TestLeaderboardTracksTopTen(t *testing.T) {
	s, ctx := newChain(t)
	seedHolders(t, s, ctx, 25)

	members := ConsensusMembers(s)
	if len(members) != engine.ConsensusSize {
		t.Fatalf("group size %d, want %d", len(members), engine.ConsensusSize)
	}
	if members[0].Account != "hive:h00" {
		t.Fatalf("largest holder should lead, got %s", members[0].Account)
	}
	for i := 1; i < len(members); i++ {
		if members[i].Shares > members[i-1].Shares {
			t.Fatal("consensus group is not ranked by holding")
		}
	}
	// State must not have grown a per-account index.
	if s.Get("gov_board") == nil {
		t.Fatal("board key missing")
	}
	auditSupply(t, s)
}

// A newcomer who out-mints the field must be able to take a seat.
func TestPromoteLetsNewcomerTakeASeat(t *testing.T) {
	s, ctx := newChain(t)
	seedHolders(t, s, ctx, 15)

	creditLiquid(s, "hive:newcomer", lc(500_000))
	if _, r := CreateMint(s, at(ctx, "hive:newcomer", genesis), lc(500_000), 1095); !r.OK {
		t.Fatalf("newcomer mint failed: %s", r.Msg)
	}

	members := ConsensusMembers(s)
	if members[0].Account != "hive:newcomer" {
		t.Fatalf("newcomer should lead the board, got %s", members[0].Account)
	}

	// Promote must refuse an account with nothing at stake.
	if r := Promote(s, "hive:nobody"); r.OK {
		t.Fatal("promoted an account holding no L-Shares")
	}
	if r := Promote(s, ""); r.OK {
		t.Fatal("promoted an empty account name")
	}
}

// A seat holder who exits must lose influence immediately, even if the stored
// board is briefly stale — shares are re-read live.
func TestExitedHolderLosesInfluenceImmediately(t *testing.T) {
	s, ctx := newChain(t)
	names := seedHolders(t, s, ctx, 12)
	top := names[0]

	if !engine.IsMember(ConsensusMembers(s), top) {
		t.Fatal("top holder should start on the group")
	}
	// End the mint early — shares go to zero.
	if r := ClaimMint(s, at(ctx, top, genesis+1), 1); !r.OK {
		t.Fatalf("early end failed: %s", r.Msg)
	}
	if SharesOf(s, top) != 0 {
		t.Fatalf("%s still holds %d shares", top, SharesOf(s, top))
	}
	if engine.IsMember(ConsensusMembers(s), top) {
		t.Fatal("exited holder kept a consensus seat")
	}
	auditSupply(t, s)
}

// --- median governance ----------------------------------------------------

func TestOnlyMembersCanSetPreferences(t *testing.T) {
	s, ctx := newChain(t)
	names := seedHolders(t, s, ctx, 12)

	// A member can vote inside the bounds.
	if r := SetPreference(s, at(ctx, names[0], genesis),
		string(engine.ParamPostThresholdViral), 50*engine.ShareUnit); !r.OK {
		t.Fatalf("member preference rejected: %s", r.Msg)
	}
	// An outsider cannot.
	if r := SetPreference(s, at(ctx, "hive:outsider", genesis),
		string(engine.ParamPostThresholdViral), 50*engine.ShareUnit); r.OK {
		t.Fatal("non-member set a governance preference")
	}
	// Unknown parameters are refused — the registry is closed.
	if r := SetPreference(s, at(ctx, names[0], genesis), "attacker.backdoor", 1); r.OK {
		t.Fatal("unknown parameter accepted")
	}
	// Out-of-bounds values are refused outright, not clamped silently.
	p, _ := Registry().Param(engine.ParamVolumeStart)
	if r := SetPreference(s, at(ctx, names[0], genesis),
		string(engine.ParamVolumeStart), p.Max+1); r.OK {
		t.Fatal("out-of-bounds preference accepted")
	}
}

func TestMedianDecidesAndBoundsHold(t *testing.T) {
	s, ctx := newChain(t)
	names := seedHolders(t, s, ctx, 10)
	key := string(engine.ParamPostThresholdViral)

	prefs := []int64{1, 2, 4, 5, 2, 3, 8, 9, 6, 7}
	for i, v := range prefs {
		if r := SetPreference(s, at(ctx, names[i], genesis), key, v*engine.ShareUnit); !r.OK {
			t.Fatalf("%s could not vote: %s", names[i], r.Msg)
		}
	}
	// sorted: 1 2 2 3 4 | 5 6 7 8 9 -> lower median 4
	if got := EffectiveParam(s, engine.ParamPostThresholdViral); got != 4*engine.ShareUnit {
		t.Fatalf("median %d, want 4", got/engine.ShareUnit)
	}

	// Even total capture cannot leave the hardcoded bounds.
	p, _ := Registry().Param(engine.ParamPostThresholdViral)
	for i := range names {
		SetPreference(s, at(ctx, names[i], genesis), key, p.Max)
	}
	got := EffectiveParam(s, engine.ParamPostThresholdViral)
	if got < p.Min || got > p.Max {
		t.Fatalf("captured governance escaped bounds: %d", got)
	}
	t.Logf("all 10 seats captured -> %d, bounds [%d,%d] hold",
		got/engine.ShareUnit, p.Min/engine.ShareUnit, p.Max/engine.ShareUnit)
}

// --- proof of brain -------------------------------------------------------

// setupMedia gives an author and curators enough shares to post and vote.
func setupMedia(t *testing.T, s *MemStore, ctx Ctx, curators int) (string, []string) {
	t.Helper()
	author := "hive:author"
	creditLiquid(s, author, lc(50_000))
	if _, r := CreateMint(s, at(ctx, author, genesis), lc(50_000), 1095); !r.OK {
		t.Fatalf("author mint: %s", r.Msg)
	}
	names := make([]string, curators)
	for i := 0; i < curators; i++ {
		c := fmt.Sprintf("hive:c%03d", i)
		names[i] = c
		creditLiquid(s, c, lc(1_000))
		if _, r := CreateMint(s, at(ctx, c, genesis), lc(1_000), 1095); !r.OK {
			t.Fatalf("curator mint: %s", r.Msg)
		}
	}
	return author, names
}

func TestPostingRequiresThreshold(t *testing.T) {
	s, ctx := newChain(t)
	author, _ := setupMedia(t, s, ctx, 0)

	if r := CreatePost(s, at(ctx, author, genesis), "hello", engine.Viral, PayoutDefault); !r.OK {
		t.Fatalf("author with shares could not post: %s", r.Msg)
	}
	// Duplicate permlink must be refused or a post could be overwritten.
	if r := CreatePost(s, at(ctx, author, genesis), "hello", engine.Viral, PayoutDefault); r.OK {
		t.Fatal("duplicate permlink accepted")
	}
	// No shares, no posting.
	if r := CreatePost(s, at(ctx, "hive:nobody", genesis), "x", engine.Viral, PayoutDefault); r.OK {
		t.Fatal("account below the threshold was allowed to post")
	}
	// A permlink containing the field separator would corrupt the key space.
	if r := CreatePost(s, at(ctx, author, genesis), "a|b", engine.Viral, PayoutDefault); r.OK {
		t.Fatal("permlink containing the separator accepted")
	}
}

func TestVotingConsumesPowerAndClosesOnTime(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 3)
	CreatePost(s, at(ctx, author, genesis), "p1", engine.Viral, PayoutDefault)

	c := curators[0]
	full := VotePowerOf(s, c, engine.Viral, genesis)
	if full != engine.MultScale {
		t.Fatalf("new voter should start at 100%%, got %d", full)
	}
	if r := Vote(s, at(ctx, c, genesis), author, "p1", 100); !r.OK {
		t.Fatalf("vote failed: %s", r.Msg)
	}
	after := VotePowerOf(s, c, engine.Viral, genesis)
	if after >= full {
		t.Fatalf("vote did not consume power: %d -> %d", full, after)
	}

	// Ten full votes empty the meter; the eleventh must be refused.
	for i := 0; i < 9; i++ {
		CreatePost(s, at(ctx, author, genesis), fmt.Sprintf("q%d", i), engine.Viral, PayoutDefault)
		Vote(s, at(ctx, c, genesis), author, fmt.Sprintf("q%d", i), 100)
	}
	CreatePost(s, at(ctx, author, genesis), "last", engine.Viral, PayoutDefault)
	if r := Vote(s, at(ctx, c, genesis), author, "last", 100); r.OK {
		t.Fatal("11th full vote should have been refused")
	}

	// Voting must close at the payout height.
	closed := genesis + engine.Viral.PayoutHeights()
	if r := Vote(s, at(ctx, curators[1], closed), author, "p1", 50); r.OK {
		t.Fatal("vote accepted after the window closed")
	}
	if r := Vote(s, at(ctx, curators[1], genesis), author, "p1", 0); r.OK {
		t.Fatal("zero-weight vote accepted")
	}
	if r := Vote(s, at(ctx, curators[1], genesis), author, "p1", 101); r.OK {
		t.Fatal("over-100% vote accepted")
	}
}

func TestRevoteReplacesRatherThanStacks(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 1)
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)

	Vote(s, at(ctx, curators[0], genesis), author, "p", 20)
	p1, _ := getPost(s, author, "p")
	Vote(s, at(ctx, curators[0], genesis), author, "p", 40)
	p2, _ := getPost(s, author, "p")

	if p2.Rshares <= p1.Rshares {
		t.Fatal("re-vote should have increased weight")
	}
	// Two votes at 20 then 40 must equal one vote of 40, not 60.
	s2, ctx2 := newChain(t)
	a2, c2 := setupMedia(t, s2, ctx2, 1)
	CreatePost(s2, at(ctx2, a2, genesis), "p", engine.Viral, PayoutDefault)
	Vote(s2, at(ctx2, c2[0], genesis), a2, "p", 40)
	ref, _ := getPost(s2, a2, "p")
	if p2.Rshares != ref.Rshares {
		t.Fatalf("re-vote stacked: %d vs single-vote %d", p2.Rshares, ref.Rshares)
	}
}

// The headline PoB test: 201 votes, author paid at payout, curators claim
// individually, and not one base unit escapes.
func TestPayoutAndCurationConserveValue(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 201)
	CreatePost(s, at(ctx, author, genesis), "viral", engine.Viral, PayoutDefault)

	for i, c := range curators {
		weight := int64(i%10+1) * 10
		if weight > 100 {
			weight = 100
		}
		Vote(s, at(ctx, c, genesis), author, "viral", weight)
	}

	payHeight := genesis + engine.Viral.PayoutHeights()
	if r := Payout(s, at(ctx, "hive:anyone", payHeight), author, "viral"); !r.OK {
		t.Fatalf("payout failed: %s", r.Msg)
	}
	// Permissionless, but only once.
	if r := Payout(s, at(ctx, "hive:anyone", payHeight), author, "viral"); r.OK {
		t.Fatal("post paid out twice")
	}

	for _, c := range curators {
		if r := ClaimCuration(s, at(ctx, c, payHeight), author, "viral", ""); !r.OK {
			t.Fatalf("%s could not claim: %s", c, r.Msg)
		}
		// And never twice.
		if r := ClaimCuration(s, at(ctx, c, payHeight), author, "viral", ""); r.OK {
			t.Fatalf("%s claimed curation twice", c)
		}
	}

	auditSupply(t, s)

	// The author must have received the larger share.
	if PendingOf(s, author) <= PendingOf(s, curators[0]) {
		t.Fatal("author should out-earn a single curator")
	}
	t.Logf("201 curators paid; author pending %s liquid %s",
		fmtA(PendingOf(s, author)), fmtA(Balance(s, author)))
}

func TestUnvotedPostPaysNothing(t *testing.T) {
	s, ctx := newChain(t)
	author, _ := setupMedia(t, s, ctx, 0)
	CreatePost(s, at(ctx, author, genesis), "ignored", engine.Viral, PayoutDefault)
	Settle(s, Ctx{Height: genesis + 30*engine.HeightsPerDay})

	before := PoolViral(s)
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "ignored")

	if PoolViral(s) != before {
		t.Fatalf("unvoted post drained the pool: %s -> %s", fmtA(before), fmtA(PoolViral(s)))
	}
	auditSupply(t, s)
}

// --- pending & monthly mint ----------------------------------------------

func TestPendingMintsOncePerMonth(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 5)
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, c := range curators {
		Vote(s, at(ctx, c, genesis), author, "p", 100)
	}
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "p")

	pending := PendingOf(s, author)
	if pending <= 0 {
		t.Fatal("author accrued nothing")
	}
	mintsBefore := getU64(s, mintSeqKey(author))

	// Same month: nothing due.
	sameMonth := Ctx{Sender: author, Height: payHeight, Epoch: 1}
	if r := SettlePending(s, sameMonth, author); !r.OK || getU64(s, mintSeqKey(author)) != mintsBefore {
		t.Fatalf("minted within the same month: %s", r.Msg)
	}
	// Next month: exactly one mint.
	nextMonth := Ctx{Sender: author, Height: payHeight, Epoch: 2}
	if r := SettlePending(s, nextMonth, author); !r.OK {
		t.Fatalf("monthly settle failed: %s", r.Msg)
	}
	if got := getU64(s, mintSeqKey(author)); got != mintsBefore+1 {
		t.Fatalf("expected exactly one new mint, seq %d -> %d", mintsBefore, got)
	}
	if PendingOf(s, author) != 0 {
		t.Fatalf("pending not drained: %s", fmtA(PendingOf(s, author)))
	}
	// And not again in the same month.
	if r := SettlePending(s, nextMonth, author); r.OK && getU64(s, mintSeqKey(author)) != mintsBefore+1 {
		t.Fatal("minted twice in one month")
	}
	auditSupply(t, s)
}

func TestPendingDustRollsOver(t *testing.T) {
	s, ctx := newChain(t)
	_ = ctx
	accruePending(s, "hive:small", engine.MinMintAmount-1, 1)
	before := getU64(s, mintSeqKey("hive:small"))

	r := SettlePending(s, Ctx{Sender: "hive:small", Height: genesis, Epoch: 2}, "hive:small")
	if !r.OK {
		t.Fatalf("settle failed: %s", r.Msg)
	}
	if getU64(s, mintSeqKey("hive:small")) != before {
		t.Fatal("dust created a mint")
	}
	if PendingOf(s, "hive:small") != engine.MinMintAmount-1 {
		t.Fatal("dust was lost instead of rolling over")
	}
	// Once it crosses the floor it mints the accumulated total.
	accruePending(s, "hive:small", engine.LC(1), 2)
	if r := SettlePending(s, Ctx{Sender: "hive:small", Height: genesis, Epoch: 3}, "hive:small"); !r.OK {
		t.Fatalf("settle after top-up failed: %s", r.Msg)
	}
	if getU64(s, mintSeqKey("hive:small")) != before+1 {
		t.Fatal("accumulated balance did not mint")
	}
}

// The whole point of monthly aggregation: many payouts, few mints.
func TestManyPayoutsCollapseIntoOneMint(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 20)

	for i := 0; i < 30; i++ {
		pl := fmt.Sprintf("post%02d", i)
		CreatePost(s, at(ctx, author, genesis), pl, engine.Deep, PayoutDefault)
		for _, c := range curators {
			Vote(s, at(ctx, c, genesis), author, pl, 5)
		}
	}
	payHeight := genesis + engine.Deep.PayoutHeights()
	for i := 0; i < 30; i++ {
		Payout(s, at(ctx, "hive:anyone", payHeight), author, fmt.Sprintf("post%02d", i))
	}

	seqBefore := getU64(s, mintSeqKey(author))
	SettlePending(s, Ctx{Sender: author, Height: payHeight, Epoch: 2}, author)
	created := getU64(s, mintSeqKey(author)) - seqBefore

	if created != 1 {
		t.Fatalf("30 post payouts produced %d mints, want 1", created)
	}
	t.Logf("30 posts x 20 curators = %d payouts -> %d author mint", 30*21, created)
	auditSupply(t, s)
}

// --- automatic curation -----------------------------------------------------

// THE point of the queue: a curator who never touches the site still gets paid.
func TestCuratorNeverClaimsAndIsStillPaid(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 3)
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, c := range curators {
		Vote(s, at(ctx, c, genesis), author, "p", 100)
	}

	payHeight := genesis + engine.Viral.PayoutHeights()
	if r := Payout(s, at(ctx, "hive:anyone", payHeight), author, "p"); !r.OK {
		t.Fatalf("payout failed: %s", r.Msg)
	}

	lazy := curators[0]
	if PendingOf(s, lazy) != 0 {
		t.Fatal("curation should not have reached the balance before settling")
	}
	if PendingCurationCount(s, lazy) != 1 {
		t.Fatalf("expected 1 queued claim, got %d", PendingCurationCount(s, lazy))
	}

	// The curator does NOTHING. Someone else — anyone — runs the monthly settle.
	next := Ctx{Sender: "hive:a-passing-stranger", Height: payHeight, Epoch: 2}
	SettlePending(s, next, lazy)

	if PendingCurationCount(s, lazy) != 0 {
		t.Fatal("queue not drained")
	}
	if getU64(s, mintSeqKey(lazy)) == 0 {
		t.Fatal("curator was never paid despite never claiming")
	}
	auditSupply(t, s)
}

// Curation drained this month must land in THIS month's mint, not wait for the
// next one — the drain has to run BEFORE the balance is read.
//
// Note the anchor rule: an account whose very first accrual happens in month N
// is anchored to N and mints in N+1, exactly like a capital minter. So this
// tests an account already active, which is the ordinary case.
func TestDrainRunsBeforeTheMint(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 2)
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, c := range curators {
		Vote(s, at(ctx, c, genesis), author, "p", 100)
	}
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "p")

	c := curators[0]
	// Already active: anchored in month 1.
	accruePending(s, c, engine.MinMintAmount, 1)
	seqBefore := getU64(s, mintSeqKey(c))

	SettlePending(s, Ctx{Sender: c, Height: payHeight, Epoch: 2}, c)

	if getU64(s, mintSeqKey(c)) != seqBefore+1 {
		t.Fatal("curation did not reach a mint in the same settle")
	}
	if PendingOf(s, c) != 0 {
		t.Fatalf("balance left over: %s", fmtA(PendingOf(s, c)))
	}
}

// A curator earning for the very first time is anchored, then mints the month
// after — the same rule that stops anyone minting a partial first month.
func TestFirstEverCurationAnchorsThenMintsNextMonth(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 2)
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, c := range curators {
		Vote(s, at(ctx, c, genesis), author, "p", 100)
	}
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "p")

	c := curators[0]
	seqBefore := getU64(s, mintSeqKey(c))

	// Month 2: paid and anchored, but not yet minted.
	SettlePending(s, Ctx{Sender: c, Height: payHeight, Epoch: 2}, c)
	if PendingOf(s, c) == 0 {
		t.Fatal("curation never reached the balance")
	}
	if getU64(s, mintSeqKey(c)) != seqBefore {
		t.Fatal("minted in the same month it first earned")
	}

	// Month 3: mints.
	SettlePending(s, Ctx{Sender: c, Height: payHeight, Epoch: 3}, c)
	if getU64(s, mintSeqKey(c)) != seqBefore+1 {
		t.Fatal("did not mint the month after anchoring")
	}
	auditSupply(t, s)
}

// An unpaid post must not block the claims queued behind it.
func TestUnpaidPostDoesNotBlockTheQueue(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 1)
	c := curators[0]

	// A deep post (30 days) voted first, then a viral post (7 days).
	CreatePost(s, at(ctx, author, genesis), "slow", engine.Deep, PayoutDefault)
	Vote(s, at(ctx, c, genesis), author, "slow", 50)
	CreatePost(s, at(ctx, author, genesis), "fast", engine.Viral, PayoutDefault)
	Vote(s, at(ctx, c, genesis), author, "fast", 50)

	// Only the viral one has closed.
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "fast")

	if n := DrainCuration(s, Ctx{Sender: c, Height: payHeight, Epoch: 2}, c, MaxCurationDrain); n != 1 {
		t.Fatalf("settled %d claims, want 1 — the open post blocked the queue", n)
	}
	// The deep post is still queued for later, not discarded.
	if PendingCurationCount(s, c) == 0 {
		t.Fatal("the still-open post was dropped from the queue")
	}

	// Once it closes it settles too.
	deepPay := genesis + engine.Deep.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", deepPay), author, "slow")
	if n := DrainCuration(s, Ctx{Sender: c, Height: deepPay, Epoch: 3}, c, MaxCurationDrain); n != 1 {
		t.Fatalf("settled %d, want 1 once the deep post closed", n)
	}
	auditSupply(t, s)
}

// The drain must stay bounded, or the gas problem the split-claim design
// exists to avoid comes straight back.
func TestDrainIsBounded(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 1)
	c := curators[0]

	// Vote on everything FIRST, then pay it all out. Interleaving would let the
	// piggyback drain settle claims as we went, and there would be no backlog
	// left to test the cap against.
	const posts = MaxCurationDrain + 15
	payHeight := genesis + engine.Viral.PayoutHeights()
	for i := 0; i < posts; i++ {
		pl := fmt.Sprintf("p%02d", i)
		CreatePost(s, at(ctx, author, genesis), pl, engine.Viral, PayoutDefault)
		Vote(s, at(ctx, c, genesis), author, pl, 10)
	}
	for i := 0; i < posts; i++ {
		Payout(s, at(ctx, "hive:anyone", payHeight), author, fmt.Sprintf("p%02d", i))
	}
	if PendingCurationCount(s, c) != posts {
		t.Fatalf("expected a backlog of %d, got %d", posts, PendingCurationCount(s, c))
	}

	n := DrainCuration(s, Ctx{Sender: c, Height: payHeight, Epoch: 2}, c, MaxCurationDrain)
	if n > MaxCurationDrain {
		t.Fatalf("one drain settled %d claims, cap is %d", n, MaxCurationDrain)
	}
	// The rest are still owed, not lost.
	if PendingCurationCount(s, c) == 0 {
		t.Fatal("the remaining claims were dropped")
	}
	// Repeated drains eventually clear them.
	for i := 0; i < 5 && PendingCurationCount(s, c) > 0; i++ {
		DrainCuration(s, Ctx{Sender: c, Height: payHeight, Epoch: uint64(3 + i)}, c, MaxCurationDrain)
	}
	if PendingCurationCount(s, c) != 0 {
		t.Fatalf("%d claims still queued after repeated drains", PendingCurationCount(s, c))
	}
	auditSupply(t, s)
}

// Re-voting must not queue the same post twice, or the account would be
// scheduled for two payments of one reward.
func TestRevoteQueuesOnce(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 1)
	c := curators[0]
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)

	Vote(s, at(ctx, c, genesis), author, "p", 20)
	Vote(s, at(ctx, c, genesis), author, "p", 60)
	Vote(s, at(ctx, c, genesis), author, "p", 100)

	if got := PendingCurationCount(s, c); got != 1 {
		t.Fatalf("three votes on one post queued %d claims, want 1", got)
	}
}

// Claiming manually and then draining must not pay twice.
func TestManualClaimThenDrainPaysOnce(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 2)
	c := curators[0]
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, x := range curators {
		Vote(s, at(ctx, x, genesis), author, "p", 100)
	}
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "p")

	ctxC := Ctx{Sender: c, Height: payHeight, Epoch: 2}
	if r := ClaimCuration(s, ctxC, author, "p", ""); !r.OK {
		t.Fatalf("manual claim failed: %s", r.Msg)
	}
	afterManual := PendingOf(s, c)

	DrainCuration(s, ctxC, c, MaxCurationDrain)
	if PendingOf(s, c) != afterManual {
		t.Fatalf("DOUBLE PAYMENT: %s -> %s", fmtA(afterManual), fmtA(PendingOf(s, c)))
	}
	auditSupply(t, s)
}

// Anyone may settle for anyone, and the money always goes to the curator.
func TestClaimIsPermissionlessButPaysTheCurator(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 2)
	c := curators[0]
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, x := range curators {
		Vote(s, at(ctx, x, genesis), author, "p", 100)
	}
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "p")

	strangerBefore := Balance(s, "hive:stranger") + PendingOf(s, "hive:stranger")
	if r := ClaimCuration(s, at(ctx, "hive:stranger", payHeight), author, "p", c); !r.OK {
		t.Fatalf("permissionless claim failed: %s", r.Msg)
	}
	if PendingOf(s, c) == 0 {
		t.Fatal("the curator was not paid")
	}
	if Balance(s, "hive:stranger")+PendingOf(s, "hive:stranger") != strangerBefore {
		t.Fatal("the CALLER was paid — a stranger must never collect someone else's curation")
	}
	auditSupply(t, s)
}

// An active curator should never build a backlog: voting settles a few of
// their own outstanding claims as a side-effect of a transaction they were
// already paying for.
func TestVotingSettlesYourOwnBacklog(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 1)
	c := curators[0]
	payHeight := genesis + engine.Viral.PayoutHeights()

	// Build a small backlog without voting in between.
	for i := 0; i < 5; i++ {
		pl := fmt.Sprintf("old%02d", i)
		CreatePost(s, at(ctx, author, genesis), pl, engine.Viral, PayoutDefault)
		Vote(s, at(ctx, c, genesis), author, pl, 10)
	}
	for i := 0; i < 5; i++ {
		Payout(s, at(ctx, "hive:anyone", payHeight), author, fmt.Sprintf("old%02d", i))
	}
	backlog := PendingCurationCount(s, c)
	if backlog == 0 {
		t.Fatal("no backlog to clear")
	}

	// One ordinary vote on something new.
	CreatePost(s, at(ctx, author, payHeight), "fresh", engine.Viral, PayoutDefault)
	if r := Vote(s, at(ctx, c, payHeight), author, "fresh", 10); !r.OK {
		t.Fatalf("vote failed: %s", r.Msg)
	}

	// It cleared some of the old ones, and queued exactly one new entry.
	after := PendingCurationCount(s, c)
	if after >= backlog+1 {
		t.Fatalf("voting cleared nothing: %d -> %d", backlog, after)
	}
	if backlog+1-after > PiggybackDrain {
		t.Fatalf("one vote cleared %d claims, cap is %d", backlog+1-after, PiggybackDrain)
	}
	auditSupply(t, s)
}

// --- curation expiry --------------------------------------------------------

func TestCurationSweepsAfterAYearNotBefore(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 3)
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, c := range curators {
		Vote(s, at(ctx, c, genesis), author, "p", 100)
	}
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "p")

	pot := func() engine.Amount {
		p, _ := getPost(s, author, "p")
		return p.CuratorPot
	}
	if pot() <= 0 {
		t.Fatal("no curator pot to sweep")
	}

	// Not yet — curators still have a year.
	day := uint64(engine.HeightsPerDay)
	for _, d := range []uint64{0, 1, 100, CurationExpiryDays - 1} {
		at := Ctx{Sender: "hive:anyone", Height: payHeight + d*day, Epoch: 2}
		if r := SweepCuration(s, at, author, "p"); r.OK {
			t.Fatalf("swept after only %d days", d)
		}
	}

	poolBefore := PoolLShare(s)
	remaining := pot()

	ripe := Ctx{Sender: "hive:anyone", Height: payHeight + CurationExpiryDays*day, Epoch: 20}
	if r := SweepCuration(s, ripe, author, "p"); !r.OK {
		t.Fatalf("sweep at one year failed: %s", r.Msg)
	}
	if pot() != 0 {
		t.Fatalf("pot not cleared: %s", fmtA(pot()))
	}
	if PoolLShare(s) != poolBefore+remaining {
		t.Fatalf("recycled %s, expected %s", fmtA(PoolLShare(s)-poolBefore), fmtA(remaining))
	}
	// And not twice.
	if r := SweepCuration(s, ripe, author, "p"); r.OK {
		t.Fatal("swept twice")
	}
	auditSupply(t, s)
}

// The clock runs from the ACTUAL payout, not from when the window closed —
// payout is permissionless and can happen late.
func TestExpiryRunsFromActualPayout(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 2)
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, c := range curators {
		Vote(s, at(ctx, c, genesis), author, "p", 100)
	}

	day := uint64(engine.HeightsPerDay)
	// Nobody settles it for six months.
	latePayout := genesis + engine.Viral.PayoutHeights() + 180*day
	Payout(s, at(ctx, "hive:anyone", latePayout), author, "p")

	// A year after the WINDOW closed is too early — the clock starts at payout.
	early := Ctx{Sender: "hive:x", Height: genesis + engine.Viral.PayoutHeights() + CurationExpiryDays*day, Epoch: 14}
	if r := SweepCuration(s, early, author, "p"); r.OK {
		t.Fatal("expiry measured from the window close, not the payout — a late payout would rob curators of six months")
	}
	ok := Ctx{Sender: "hive:x", Height: latePayout + CurationExpiryDays*day, Epoch: 20}
	if r := SweepCuration(s, ok, author, "p"); !r.OK {
		t.Fatalf("sweep a year after payout failed: %s", r.Msg)
	}
	auditSupply(t, s)
}

// A swept post must not leave its queue entries jammed forever.
func TestQueueSelfClearsAfterSweep(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 2)
	c := curators[0]
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, x := range curators {
		Vote(s, at(ctx, x, genesis), author, "p", 100)
	}
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "p")

	day := uint64(engine.HeightsPerDay)
	ripe := payHeight + CurationExpiryDays*day
	SweepCuration(s, Ctx{Sender: "hive:x", Height: ripe, Epoch: 20}, author, "p")

	// The curator returns far too late. Their queue entry must clear, not jam.
	DrainCuration(s, Ctx{Sender: c, Height: ripe, Epoch: 21}, c, MaxCurationDrain)
	if PendingCurationCount(s, c) != 0 {
		t.Fatalf("%d queue entries stuck after the sweep", PendingCurationCount(s, c))
	}
	auditSupply(t, s)
}

// The sweeper must gain nothing — a bounty would create pressure for a shorter
// expiry, and this must only ever touch abandoned rewards.
func TestSweeperIsPaidNothing(t *testing.T) {
	s, ctx := newChain(t)
	author, curators := setupMedia(t, s, ctx, 2)
	CreatePost(s, at(ctx, author, genesis), "p", engine.Viral, PayoutDefault)
	for _, x := range curators {
		Vote(s, at(ctx, x, genesis), author, "p", 100)
	}
	payHeight := genesis + engine.Viral.PayoutHeights()
	Payout(s, at(ctx, "hive:anyone", payHeight), author, "p")

	day := uint64(engine.HeightsPerDay)
	sweeper := "hive:sweeper"
	before := Balance(s, sweeper) + PendingOf(s, sweeper)
	SweepCuration(s, Ctx{Sender: sweeper, Height: payHeight + CurationExpiryDays*day, Epoch: 20}, author, "p")

	if Balance(s, sweeper)+PendingOf(s, sweeper) != before {
		t.Fatal("the sweeper was paid — there must be no bounty")
	}
	auditSupply(t, s)
}

// Comments (2026-08-22): a reply registered on a registered post runs viral
// economics but is gated by the separate, lower comment threshold. Below it,
// the contract refuses with a message the site shows BEFORE writing to Hive.
func TestCommentsAreGatedBySeparateThreshold(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:author", lc(50_000))
	creditLiquid(s, "hive:small", lc(500))
	creditLiquid(s, "hive:tiny", lc(10))
	// author: enough for a viral post; small: enough to comment but not to
	// post viral (100 < 500 < 1,000); tiny: below the comment threshold.
	CreateMint(s, at(ctx, "hive:author", genesis), lc(20_000), 365)
	CreateMint(s, at(ctx, "hive:small", genesis), lc(500), 365)
	CreateMint(s, at(ctx, "hive:tiny", genesis), lc(10), 365)

	if r := CreatePost(s, at(ctx, "hive:author", genesis), "root", engine.Viral, PayoutDefault); !r.OK {
		t.Fatal(r.Msg)
	}
	if r := CreatePost(s, at(ctx, "hive:small", genesis), "nope", engine.Viral, PayoutDefault); r.OK {
		t.Fatal("small should not clear the viral threshold")
	}
	if r := CreateComment(s, at(ctx, "hive:small", genesis), "re-root", PayoutDefault, "hive:author", "root"); !r.OK {
		t.Fatalf("small should clear the comment threshold: %s", r.Msg)
	}
	r := CreateComment(s, at(ctx, "hive:tiny", genesis), "re-root", PayoutDefault, "hive:author", "root")
	if r.OK || r.Msg != "need "+encI64(100*engine.ShareUnit)+" L-Shares to comment" {
		t.Fatalf("tiny must be refused with the comment message, got %+v", r)
	}
	// Only registered posts can be commented on.
	if r := CreateComment(s, at(ctx, "hive:small", genesis), "re-ghost", PayoutDefault, "hive:author", "ghost"); r.OK {
		t.Fatal("comment on an unregistered parent accepted")
	}
	// The comment is a viral-economics post with a parent.
	p, _ := getPost(s, "hive:small", "re-root")
	if !p.IsComment() || p.Window != uint8(engine.Viral) || p.ParentAuthor != "hive:author" || p.ParentPermlink != "root" {
		t.Fatalf("comment record wrong: %+v", p)
	}
	// It earns like any viral post: vote, wait out the window, pay out.
	Vote(s, at(ctx, "hive:author", genesis+1), "hive:small", "re-root", 100)
	h := genesis + uint64(engine.ViralPayoutDays+1)*engine.HeightsPerDay
	AccrueFully(s, h)
	before := Balance(s, "hive:small")
	if r := Payout(s, at(ctx, "hive:x", h), "hive:small", "re-root"); !r.OK {
		t.Fatalf("payout: %s", r.Msg)
	}
	if Balance(s, "hive:small") <= before {
		t.Fatal("a registered comment must earn on payout")
	}
	auditSupply(t, s)
}

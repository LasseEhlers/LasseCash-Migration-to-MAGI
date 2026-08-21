package state

import (
	"strings"

	"github.com/lassecash/engine"
)

// LasseMedia: posting, voting, and content payouts.
//
// THE CURATOR PAYOUT PROBLEM
//
// A real lassecash.com post carried 201 votes. Paying every curator inside the
// payout transaction means iterating every voter — bounded by how popular the
// post is, which is exactly the wrong thing to make a caller pay gas for. A
// viral post would cost its author more RC than an ignored one.
//
// So payout is split in two:
//
//	Payout       -> pays the author, and PARKS the curator pot on the post
//	ClaimCuration-> each curator collects their own share, O(1)
//
// Nobody pays for anyone else's popularity, and no loop is unbounded.

// --- payout modes ---------------------------------------------------------

// PayoutMode is the author's choice of how their share of a post payout is
// delivered. Set at publication and frozen with the post.
//
// It applies to the AUTHOR's reward only. Curators are never bound by someone
// else's setting — a curator who worked for their share gets it on their own
// terms, exactly as on Hive.
type PayoutMode uint8

const (
	// PayoutDefault splits 20% liquid now / 80% into the monthly mint.
	PayoutDefault PayoutMode = 0
	// PayoutPowerUp sends 100% to the monthly mint — nothing liquid.
	PayoutPowerUp PayoutMode = 1
	// PayoutBurn destroys the whole author reward. Declining rewards is a
	// statement, and the supply accounting must record it as a burn rather
	// than quietly leaving the tokens in a pool.
	PayoutBurn PayoutMode = 2
)

func payoutMode(v uint64) PayoutMode {
	switch PayoutMode(v) {
	case PayoutPowerUp:
		return PayoutPowerUp
	case PayoutBurn:
		return PayoutBurn
	default:
		return PayoutDefault
	}
}

// --- post records ---------------------------------------------------------

// post record fields, frozen order:
//
//	window | createdHeight | rshares | paidOut | curatorPot | curatorRshares
//	| votes | payoutMode | paidHeight
//
// Field order is APPEND-ONLY. `votes` was added after launch-shape records
// existed, so decoding treats it as 0 when absent rather than failing.
type postRec struct {
	Window         uint8
	CreatedHeight  uint64
	Rshares        int64
	PaidOut        bool
	CuratorPot     engine.Amount
	CuratorRshares int64
	// Mode is the author's payout choice, frozen at publication.
	Mode PayoutMode
	// PaidHeight is when the post actually settled, which is NOT
	// createdHeight + window: payout is permissionless, so it can happen late.
	// The expiry clock has to run from the real event, or a post settled six
	// months late would give its curators six months less to be paid.
	PaidHeight uint64
	// Votes only ever increments. The per-voter records are DELETED on
	// curation claim (that is what prevents double collection), so a count
	// derived from them would fall to zero as curators are paid — which is
	// exactly wrong for a feed.
	Votes int64
	// ParentAuthor/ParentPermlink make this a COMMENT on a registered post
	// (2026-08-22). Comments run viral economics (7 days, viral pool, viral
	// vote meter) but are gated by the lower comment threshold. Empty for a
	// root post. Fields 10 and 11, append-only.
	ParentAuthor   string
	ParentPermlink string
	// Promoted is the total LASSECASH burned to promote this post (field
	// 12, append-only). Display-only for ranking the promoted slot.
	Promoted engine.Amount
}

// IsComment reports whether the record is a reply to a registered post.
func (p postRec) IsComment() bool { return p.ParentPermlink != "" }

func encodePost(p postRec) string {
	return encU64(uint64(p.Window)) + sep +
		encU64(p.CreatedHeight) + sep +
		encI64(p.Rshares) + sep +
		encBool(p.PaidOut) + sep +
		encI64(int64(p.CuratorPot)) + sep +
		encI64(p.CuratorRshares) + sep +
		encI64(p.Votes) + sep +
		encU64(uint64(p.Mode)) + sep +
		encU64(p.PaidHeight) + sep +
		p.ParentAuthor + sep +
		p.ParentPermlink + sep +
		encI64(int64(p.Promoted))
}

func decodePost(raw string) (postRec, bool) {
	f := strings.Split(raw, sep)
	if len(f) < 6 {
		return postRec{}, false
	}
	rec := postRec{
		Window:         uint8(decU64(f[0])),
		CreatedHeight:  decU64(f[1]),
		Rshares:        decI64(f[2]),
		PaidOut:        decBool(f[3]),
		CuratorPot:     engine.Amount(decI64(f[4])),
		CuratorRshares: decI64(f[5]),
	}
	if len(f) >= 7 {
		rec.Votes = decI64(f[6])
	}
	if len(f) >= 8 {
		rec.Mode = payoutMode(decU64(f[7]))
	}
	if len(f) >= 9 {
		rec.PaidHeight = decU64(f[8])
	}
	if len(f) >= 11 {
		rec.ParentAuthor = f[9]
		rec.ParentPermlink = f[10]
	}
	if len(f) >= 12 {
		rec.Promoted = engine.Amount(decI64(f[11]))
	}
	return rec, true
}

func getPost(s Store, author, permlink string) (postRec, bool) {
	raw := get(s, postKey(author, permlink))
	if raw == nil {
		return postRec{}, false
	}
	return decodePost(*raw)
}

func putPost(s Store, author, permlink string, p postRec) {
	s.Set(postKey(author, permlink), encodePost(p))
}

func (p postRec) win() engine.Window {
	if p.Window == uint8(engine.Deep) {
		return engine.Deep
	}
	return engine.Viral
}

func poolKeys(w engine.Window) (poolKey, rsharesKey string) {
	if w == engine.Deep {
		return keyPoolDeep, keyRsharesDeep
	}
	return keyPoolViral, keyRsharesViral
}

// --- posting --------------------------------------------------------------

// CreatePost publishes content in one of the two windows.
//
// Requires enough L-Shares to clear the window's posting threshold, which is a
// governed parameter (median of the top 10, within hardcoded bounds).
func CreatePost(s Store, ctx Ctx, permlink string, window engine.Window, mode PayoutMode) Result {
	return createContent(s, ctx, permlink, window, mode, "", "")
}

// CreateComment registers a reply to an already-registered post. It earns
// exactly like a viral post (7-day window, viral pool) but is gated by the
// separate, lower comment threshold. Decided by Lasse 2026-08-22: on
// LasseCash a comment below the threshold is refused before anything is
// written, and a comment from any other Hive frontend is shown here only
// if its author holds the threshold.
func CreateComment(s Store, ctx Ctx, permlink string, mode PayoutMode, parentAuthor, parentPermlink string) Result {
	if parentAuthor == "" || parentPermlink == "" {
		return fail("comment needs a parent post")
	}
	if _, exists := getPost(s, parentAuthor, parentPermlink); !exists {
		return fail("parent post is not registered on LasseCash")
	}
	return createContent(s, ctx, permlink, engine.Viral, mode, parentAuthor, parentPermlink)
}

func createContent(s Store, ctx Ctx, permlink string, window engine.Window, mode PayoutMode,
	parentAuthor, parentPermlink string) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	if permlink == "" || strings.Contains(permlink, sep) ||
		strings.Contains(parentAuthor, sep) || strings.Contains(parentPermlink, sep) {
		return fail("invalid permlink")
	}
	if _, exists := getPost(s, ctx.Sender, permlink); exists {
		return fail("permlink already used")
	}

	key := engine.ThresholdKeyFor(window)
	if parentPermlink != "" {
		key = engine.ParamPostThresholdComment
	}
	threshold := EffectiveParam(s, key)
	if !engine.CanPost(SharesOf(s, ctx.Sender), threshold) {
		if parentPermlink != "" {
			return fail("need " + encI64(threshold) + " L-Shares to comment")
		}
		return fail("need " + encI64(threshold) + " L-Shares to post here")
	}

	putPost(s, ctx.Sender, permlink, postRec{
		Window:         uint8(window),
		CreatedHeight:  ctx.Height,
		Mode:           mode,
		ParentAuthor:   parentAuthor,
		ParentPermlink: parentPermlink,
	})
	if parentPermlink != "" {
		return ok("commented")
	}
	return ok("posted")
}

// PromotePost burns LASSECASH to buy a post a promoted slot. The burn goes to
// null like every burn; the post records the running total. Refused on
// comments, on paid-out posts, below the governed minimum, and once 75% of
// the window has elapsed.
func PromotePost(s Store, ctx Ctx, author, permlink string, amt engine.Amount) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	p, found := getPost(s, author, permlink)
	if !found {
		return fail("no such post")
	}
	if p.IsComment() {
		return fail("comments cannot be promoted")
	}
	if p.PaidOut {
		return fail("post already paid out")
	}
	if !engine.Window(p.Window).PromoteOpen(p.CreatedHeight, ctx.Height) {
		return fail("promotion closed: 75% of the window has elapsed")
	}
	minBurn := engine.Amount(EffectiveParam(s, engine.ParamPromoteMinBurn))
	if amt < minBurn {
		return fail("minimum promotion burn is " + encI64(int64(minBurn)))
	}
	if ctx.Sender == BurnAccount {
		return fail("null cannot act")
	}
	if !debit(s, ctx.Sender, amt) {
		return fail("insufficient balance")
	}
	burn(s, amt)
	p.Promoted += amt
	putPost(s, author, permlink, p)
	return ok("promoted with " + encI64(int64(amt)))
}

// --- voting ---------------------------------------------------------------

// votePower loads an account's meter for a window, defaulting to full.
func votePower(s Store, account string, w engine.Window) engine.VotePower {
	raw := get(s, votePowerKey(account, uint8(w)))
	if raw == nil {
		return engine.NewVotePower(0)
	}
	f := strings.Split(*raw, sep)
	if len(f) < 2 {
		return engine.NewVotePower(0)
	}
	return engine.VotePower{Power: decI64(f[0]), LastHeight: decU64(f[1])}
}

func putVotePower(s Store, account string, w engine.Window, vp engine.VotePower) {
	s.Set(votePowerKey(account, uint8(w)), encI64(vp.Power)+sep+encU64(vp.LastHeight))
}

// VotePowerOf reports an account's current vote power for a window, scaled by
// engine.MultScale. Read-only, for the frontend's vote slider.
func VotePowerOf(s Store, account string, w engine.Window, height uint64) int64 {
	return votePower(s, account, w).Current(w, height)
}

// Vote casts a weighted vote on a post.
//
// Vote weight is the voter's L-Shares times the power actually spent, and the
// reward curve is linear, so ten small votes are worth exactly one vote ten
// times the size. Re-voting replaces the previous weight rather than stacking.
func Vote(s Store, ctx Ctx, author, permlink string, weightPct int64) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	p, found := getPost(s, author, permlink)
	if !found {
		return fail("no such post")
	}
	w := p.win()
	if p.PaidOut || ctx.Height >= p.CreatedHeight+w.PayoutHeights() {
		return fail("voting has closed")
	}
	if weightPct <= 0 || weightPct > 100 {
		return fail("weight must be 1..100")
	}

	shares := SharesOf(s, ctx.Sender)
	if shares <= 0 {
		return fail("no L-Shares, no vote weight")
	}

	vp := votePower(s, ctx.Sender, w)
	spent := engine.VoteCost(weightPct)
	next, spendOK := vp.Spend(w, ctx.Height, weightPct)
	if !spendOK {
		return fail("not enough vote power")
	}

	rshares := engine.VoteWeight(shares, spent)
	if rshares <= 0 {
		return fail("vote too small to register")
	}

	// Replace any previous vote from this account rather than stacking.
	prev := int64(0)
	if raw := get(s, postVoteKey(author, permlink, ctx.Sender)); raw != nil {
		prev = decI64(*raw)
	} else {
		p.Votes++ // first vote from this account
		// Remember that this account will be owed curation, so the monthly
		// settle can pay them without them ever having to ask.
		cqAppend(s, ctx.Sender, author, permlink)
	}
	delta := rshares - prev

	p.Rshares += delta
	putPost(s, author, permlink, p)
	s.Set(postVoteKey(author, permlink, ctx.Sender), encI64(rshares))
	putVotePower(s, ctx.Sender, w, next)

	// The window pool's rshares total must move with the post's, or later
	// claims would be mis-proportioned.
	_, rk := poolKeys(w)
	setAmount(s, rk, getAmount(s, rk)+engine.Amount(delta))

	// Clear a few of the voter's own outstanding claims while we are here.
	// They are already paying for this transaction, so an active curator never
	// accumulates a backlog that needs sweeping later.
	DrainCuration(s, ctx, ctx.Sender, PiggybackDrain)

	return ok("voted")
}

// --- payout ---------------------------------------------------------------

// Payout settles a post once its window closes.
//
// Permissionless: anyone may trigger it, because leaving payout to the author
// would strand rewards for absent users. The author is paid here; curators
// collect their own shares via ClaimCuration.
func Payout(s Store, ctx Ctx, author, permlink string) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	p, found := getPost(s, author, permlink)
	if !found {
		return fail("no such post")
	}
	if p.PaidOut {
		return fail("already paid out")
	}
	w := p.win()
	if ctx.Height < p.CreatedHeight+w.PayoutHeights() {
		return fail("window still open")
	}

	// Bring emission current so the payout draws on an up-to-date pool.
	Settle(s, ctx)

	pk, rk := poolKeys(w)
	pool := &engine.Pool{
		Balance: getAmount(s, pk),
		Rshares: int64(getAmount(s, rk)),
	}
	total := pool.Claim(p.Rshares)
	setAmount(s, pk, pool.Balance)
	setAmount(s, rk, engine.Amount(pool.Rshares))

	p.PaidOut = true
	p.PaidHeight = ctx.Height

	if total <= 0 {
		// An unvoted post pays nothing and must not drain the pool.
		putPost(s, author, permlink, p)
		return ok("no rewards")
	}

	curatorPot, potOK := engine.MulDiv(total, engine.CuratorPct, 100)
	if !potOK {
		curatorPot = 0
	}
	// The author takes the rest, including any curation dust — nothing is lost.
	authorAmount := total - curatorPot

	p.CuratorPot = curatorPot
	p.CuratorRshares = p.Rshares
	putPost(s, author, permlink, p)

	payReward(s, ctx, author, authorAmount, p.Mode)
	return ok("paid author " + encI64(int64(authorAmount)))
}

// ClaimCuration pays one curator their share of an already-paid-out post.
//
// O(1): the curator's own rshares divided by the snapshot taken at payout. The
// vote record is deleted on claim, which is what prevents double collection.
//
// PERMISSIONLESS. `curator` may be anyone — the reward always goes to the
// curator, never to the caller. The split-claim design exists for a GAS reason
// (paying 201 curators in one transaction is unbounded iteration), and a
// technical constraint should not become a UX tax where people lose rewards by
// forgetting to click. Anyone — the frontend, a helper, a friend — can settle
// on a curator's behalf.
func ClaimCuration(s Store, ctx Ctx, author, permlink, curator string) Result {
	if curator == "" {
		curator = ctx.Sender
	}
	p, found := getPost(s, author, permlink)
	if !found {
		return fail("no such post")
	}
	if !p.PaidOut {
		return fail("post has not paid out yet")
	}
	if p.CuratorRshares <= 0 || p.CuratorPot <= 0 {
		return fail("nothing to claim")
	}

	vk := postVoteKey(author, permlink, curator)
	raw := get(s, vk)
	if raw == nil {
		return fail("no vote to claim")
	}
	mine := decI64(*raw)
	if mine <= 0 {
		s.Delete(vk)
		return fail("nothing to claim")
	}

	share, shareOK := engine.MulDiv(p.CuratorPot, mine, p.CuratorRshares)
	if !shareOK || share <= 0 {
		s.Delete(vk)
		return fail("share rounds to zero")
	}

	// Burn down the parked pot as it is collected, so the sum of all claims can
	// never exceed what was set aside.
	p.CuratorPot -= share
	p.CuratorRshares -= mine
	putPost(s, author, permlink, p)
	s.Delete(vk)

	// Curators always take the standard split — the author's payout choice is
	// theirs alone and cannot dictate how someone else is paid.
	payReward(s, ctx, curator, share, PayoutDefault)
	return ok("claimed " + encI64(int64(share)))
}

// payReward delivers a Proof-of-Brain reward according to the chosen mode.
//
//	PayoutDefault  20% liquid now, 80% to the monthly mint
//	PayoutPowerUp  100% to the monthly mint
//	PayoutBurn     destroyed, and recorded against total burned
func payReward(s Store, ctx Ctx, account string, amount engine.Amount, mode PayoutMode) {
	if amount <= 0 {
		return
	}
	switch mode {
	case PayoutBurn:
		// Credited to the null account, like every burn — leaving declined
		// rewards in a pool would silently inflate what is claimable, and a
		// bare counter would hide them from anyone auditing the null balance.
		burn(s, amount)
	case PayoutPowerUp:
		accruePending(s, account, amount, ctx.Epoch)
	default:
		liquid, pending := engine.RoutePayout(amount)
		credit(s, account, liquid)
		accruePending(s, account, pending, ctx.Epoch)
	}
}

// --- curation expiry ------------------------------------------------------

// CurationExpiryDays is how long a settled post keeps its curator pot before
// anyone may sweep the remainder into the reward pool.
//
// A YEAR is deliberately generous. Three layers already keep an active
// curator's queue near empty — the piggyback drain on voting, the sign-in
// sweep, and anyone being able to settle for anyone — so reaching this point
// means an account has been silent for twelve months. Nobody plausibly active
// loses anything.
//
// What it buys: nothing sits idle forever, and the recycled value feeds the
// L-Share reward pool, which is what funds rewards after emission ends.
const CurationExpiryDays = 365

// SweepCuration recycles a settled post's unclaimed curator pot.
//
// PERMISSIONLESS, and it pays the caller nothing — there is deliberately no
// bounty. A bounty would create an incentive to lobby for a shorter expiry,
// and the whole point is that this only ever touches genuinely abandoned
// rewards.
func SweepCuration(s Store, ctx Ctx, author, permlink string) Result {
	p, found := getPost(s, author, permlink)
	if !found {
		return fail("no such post")
	}
	if !p.PaidOut {
		return fail("post has not paid out yet")
	}
	if p.CuratorPot <= 0 {
		return fail("nothing left to sweep")
	}

	// PaidHeight is zero on posts settled before this field existed. Fall back
	// to the earliest defensible moment — when the window closed — so an old
	// record cannot be swept immediately by an unset clock.
	paid := p.PaidHeight
	if paid == 0 {
		paid = p.CreatedHeight + p.win().PayoutHeights()
	}
	ripe := paid + uint64(CurationExpiryDays)*engine.HeightsPerDay
	if ctx.Height < ripe {
		return fail("not expired: curators have until height " + encU64(ripe))
	}

	amount := p.CuratorPot
	p.CuratorPot = 0
	p.CuratorRshares = 0
	putPost(s, author, permlink, p)

	// Into the same pool that penalties and bleed feed. One named destination
	// for every recycled amount — see Recycle in ledger.go.
	Recycle(s, amount)

	return ok("swept " + encI64(int64(amount)))
}

// CurationExpiresAt returns the height at which a post's unclaimed curator pot
// becomes sweepable. Zero if it has not paid out.
func CurationExpiresAt(s Store, author, permlink string) uint64 {
	p, found := getPost(s, author, permlink)
	if !found || !p.PaidOut {
		return 0
	}
	paid := p.PaidHeight
	if paid == 0 {
		paid = p.CreatedHeight + p.win().PayoutHeights()
	}
	return paid + uint64(CurationExpiryDays)*engine.HeightsPerDay
}

// --- the curation queue ---------------------------------------------------

// MaxCurationDrain bounds how many queued claims one settle may process.
//
// The whole point of the split-claim design is that no transaction does
// unbounded work. A queue drain would reintroduce exactly that if it ran to
// completion, so it stops after this many and leaves the rest for next time.
const MaxCurationDrain = 20

// PiggybackDrain is how many queued claims are settled as a side-effect of an
// account's own vote.
//
// A voter is already sending a transaction and already paying RC for it, so
// clearing a few claims costs them almost nothing extra — and it means an
// ACTIVE curator never builds a backlog at all. Only genuinely dormant
// accounts accumulate, and they are not earning more either.
//
// Kept small on purpose: voting must stay cheap, or people vote less, which is
// worse for the whole reward system than a slightly longer queue.
const PiggybackDrain = 3

// cqAppend records that an account is owed curation on a post.
//
// Called on an account's FIRST vote for a post. A re-vote must not append
// again, or the account would be queued twice for one payment.
func cqAppend(s Store, account, author, permlink string) {
	tail := getU64(s, cqTailKey(account))
	s.Set(cqKey(account, tail), author+sep+permlink)
	setU64(s, cqTailKey(account), tail+1)
}

// DrainCuration settles up to `max` queued curation claims.
//
// Entries whose post has not paid out yet are LEFT IN PLACE and retried later —
// skipping them would lose the reward, and stopping at the first unpaid one
// would let a single slow post block everything behind it.
//
// Returns how many were settled.
func DrainCuration(s Store, ctx Ctx, account string, max int) int {
	if max <= 0 || max > MaxCurationDrain {
		max = MaxCurationDrain
	}
	head := getU64(s, cqHeadKey(account))
	tail := getU64(s, cqTailKey(account))

	settled := 0
	scanned := 0
	for n := head; n < tail && scanned < max; n++ {
		scanned++
		raw := get(s, cqKey(account, n))
		if raw == nil || *raw == "" {
			continue // already settled
		}
		f := strings.Split(*raw, sep)
		if len(f) < 2 {
			s.Delete(cqKey(account, n))
			continue
		}
		author, permlink := f[0], f[1]

		p, found := getPost(s, author, permlink)
		if !found {
			s.Delete(cqKey(account, n)) // post is gone; nothing to wait for
			continue
		}
		if !p.PaidOut {
			continue // still open — try again next month
		}

		// Pays the curator whatever their weight earns. A failure here means
		// the vote was already claimed manually, which is fine: either way the
		// slot is done.
		if r := ClaimCuration(s, ctx, author, permlink, account); r.OK {
			settled++
		}
		s.Delete(cqKey(account, n))
	}

	// Advance the head past a run of settled slots so the next drain starts
	// where there is actually work.
	for head < tail {
		if v := get(s, cqKey(account, head)); v != nil && *v != "" {
			break
		}
		s.Delete(cqKey(account, head))
		head++
	}
	setU64(s, cqHeadKey(account), head)

	return settled
}

// PendingCurationCount reports how many queued claims an account is owed.
// Off-chain display only — bounded by the cursors, not a scan.
func PendingCurationCount(s Store, account string) int {
	head := getU64(s, cqHeadKey(account))
	tail := getU64(s, cqTailKey(account))
	if tail <= head {
		return 0
	}
	return int(tail - head)
}

// --- pending & the monthly mint -------------------------------------------

func getPending(s Store, account string) engine.PendingAccount {
	raw := get(s, pendKey(account))
	if raw == nil {
		return engine.PendingAccount{}
	}
	return decodePending(*raw)
}

func putPending(s Store, account string, p engine.PendingAccount) {
	s.Set(pendKey(account), encodePending(p))
}

// accruePending adds to an account's pending balance, anchoring its epoch on
// first sighting so it never mints a partial first month.
func accruePending(s Store, account string, amount engine.Amount, epoch uint64) {
	p := getPending(s, account)
	p.Balance += amount
	if p.LastEpoch == 0 {
		p.LastEpoch = epoch
	}
	putPending(s, account, p)
}

// PendingOf returns an account's accrued balance awaiting its monthly mint.
func PendingOf(s Store, account string) engine.Amount { return getPending(s, account).Balance }

// SettlePending converts an account's pending balance into a mint, if a month
// boundary has passed.
//
// Lazy and per-account by design: a global monthly sweep over every account
// with a balance cannot fit in the gas budget, and MAGI has no cron. This runs
// when the account is next touched, or when anyone calls it.
func SettlePending(s Store, ctx Ctx, account string) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	// Settle any curation owed BEFORE reading the balance, so rewards claimed
	// this month are included in this month's mint rather than waiting another.
	DrainCuration(s, ctx, account, MaxCurationDrain)

	p := getPending(s, account)
	if p.LastEpoch == 0 {
		// First sighting: anchor without minting.
		p.LastEpoch = ctx.Epoch
		putPending(s, account, p)
		return ok("anchored")
	}
	if ctx.Epoch <= p.LastEpoch {
		return ok("not due yet")
	}
	if p.Balance < engine.MinMintAmount {
		// Dust rolls over rather than creating a mint of nothing. The epoch is
		// NOT advanced, so it stays eligible the moment it crosses the floor.
		return ok("below minimum, rolled over")
	}

	// Accrual must be current BEFORE the pending balance is touched, for the
	// same reason CreateMint checks before debiting: a refusal after mutation
	// would strand value. Nothing is lost either way — pending simply waits
	// for the next touch after an `advance` — but untouched is simpler than
	// restored.
	if !Accrue(s, ctx.Height) {
		return fail("accrual is behind; call advance then settle again")
	}

	amount := p.Balance
	p.Balance = 0
	p.LastEpoch = ctx.Epoch
	putPending(s, account, p)

	// Route through the ordinary mint path so PoB mints are indistinguishable
	// from capital mints once created — same shares formula, same lifecycle.
	days := MintDuration(s, account)
	params := MintParamsNow(s, ctx)
	m, made := engine.NewMint(account, amount, days, ctx.Height, params)
	if !made || m.Shares <= 0 {
		// Give it back rather than destroying it.
		p.Balance = amount
		putPending(s, account, p)
		return fail("mint would yield no shares")
	}

	registerMint(s, ctx, m)

	return ok("minted " + encI64(int64(amount)) + " for " + encI64(days) + " days")
}

// --- off-chain read helpers -----------------------------------------------
//
// Used by the simulator and the indexer. NOT called from any entrypoint —
// VoteCount in particular scans keys, which no contract path may ever do.

// PostRecord is a post's stored state, exposed for off-chain readers.
type PostRecord struct {
	Window         uint8
	CreatedHeight  uint64
	Rshares        int64
	PaidOut        bool
	CuratorPot     engine.Amount
	CuratorRshares int64
	Votes          int64
	Mode           PayoutMode
	PaidHeight     uint64
	ParentAuthor   string
	ParentPermlink string
	Promoted       engine.Amount
}

// GetPostView reads a post record.
func GetPostView(s Store, author, permlink string) (PostRecord, bool) {
	p, ok := getPost(s, author, permlink)
	if !ok {
		return PostRecord{}, false
	}
	return PostRecord{
		Window: p.Window, CreatedHeight: p.CreatedHeight, Rshares: p.Rshares,
		PaidOut: p.PaidOut, CuratorPot: p.CuratorPot,
		CuratorRshares: p.CuratorRshares, Votes: p.Votes, Mode: p.Mode,
		PaidHeight: p.PaidHeight, ParentAuthor: p.ParentAuthor,
		ParentPermlink: p.ParentPermlink, Promoted: p.Promoted,
	}, true
}

// PendingPayout returns what a post would earn if it paid out right now,
// computed by the engine against the live window pool.
func PendingPayout(s Store, author, permlink string) engine.Amount {
	p, ok := getPost(s, author, permlink)
	if !ok || p.PaidOut || p.Rshares <= 0 {
		return 0
	}
	pk, rk := poolKeys(p.win())
	pool := &engine.Pool{Balance: getAmount(s, pk), Rshares: int64(getAmount(s, rk))}
	// Claim on a COPY: this must not mutate state, it is a read.
	return pool.Claim(p.Rshares)
}

// VoteCount returns how many accounts have voted on a post.
//
// Read from the post's own counter, NOT by scanning vote records: those are
// deleted as curators claim, so a scan would show a popular post losing votes
// as it pays out.
func VoteCount(s Store, author, permlink string) int {
	p, ok := getPost(s, author, permlink)
	if !ok {
		return 0
	}
	return int(p.Votes)
}

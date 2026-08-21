package engine

// Proof-of-Brain: LasseMedia content rewards.
//
// 50% of every block reward funds this. That slice splits across two content
// windows, and each post's payout splits between its author and its curators.
//
//	block reward
//	  └─ 50% Proof-of-Brain
//	       ├─ 25% VIRAL  (7-day payout,  7-day vote regen)
//	       └─ 75% DEEP  (30-day payout, 30-day vote regen)
//	            each: 75% author / 25% curators
//
// PAYOUT ROUTING (differs from capital minting, deliberately):
//
// A post payout does NOT create a mint. Protocol-generated payouts need no user
// transaction, so they have no natural rate limit — one post with 201 votes
// would create 201 curation mints. At ~20 posts/day that is ~1.5M mints/year in
// contract state, which would kill the chain.
//
// Instead: 20% pays out liquid immediately, and 80% accrues to a per-account
// PENDING balance — one integer per account, not a row per payout. On the 1st
// of each month the whole pending balance becomes ONE mint at the duration the
// user chose in settings. Twelve mints a year instead of millions.
//
// Manual capital minting has no such problem: each mint costs a signed
// transaction and RC, which is a natural brake. It stays immediate and direct.

// --- windows --------------------------------------------------------------

// Window is a content class. The two differ in payout period, vote-power
// regeneration period, and share of the Proof-of-Brain pool.
type Window uint8

const (
	// Viral is fast content: 7-day payout, 25% of the PoB pool.
	Viral Window = iota
	// Deep is long-form AnCap content: 30-day payout, 75% of the PoB pool.
	Deep
)

const (
	ViralPayoutDays = 7
	DeepPayoutDays  = 30

	// Share of the Proof-of-Brain pool, in percent. Must total 100.
	ViralPoolPct = 25
	DeepPoolPct  = 75

	// AuthorPct / CuratorPct split each post's payout. Must total 100.
	AuthorPct  = 75
	CuratorPct = 25

	// FullVoteCostPct is the vote power consumed by a 100% vote.
	FullVoteCostPct = 10

	// PoB payout routing.
	PoBLiquidPct = 20 // paid immediately as liquid LASSECASH
	PoBMintPct   = 80 // accrues to pending, minted monthly

	// MinMintAmount stops dust-spam creating rows of 0.00000001. Pending
	// balances below this roll over to the following month instead of minting.
	MinMintAmount = Amount(100_000_000) // 1.00000000 LC
)

// PayoutDays returns the payout period for a window.
func (w Window) PayoutDays() int64 {
	if w == Deep {
		return DeepPayoutDays
	}
	return ViralPayoutDays
}

// PoolPct returns the window's share of the Proof-of-Brain pool.
func (w Window) PoolPct() int64 {
	if w == Deep {
		return DeepPoolPct
	}
	return ViralPoolPct
}

// PayoutHeights returns the payout period in heights.
func (w Window) PayoutHeights() uint64 {
	return uint64(w.PayoutDays()) * HeightsPerDay
}

// SplitPoB divides the Proof-of-Brain slice between the two windows.
// Deep receives the remainder so no base unit is lost.
func SplitPoB(pob Amount) (viral, deep Amount) {
	if pob <= 0 {
		return 0, 0
	}
	v, ok := MulDiv(pob, ViralPoolPct, 100)
	if !ok {
		return 0, 0
	}
	return v, pob - v
}

// --- vote power -----------------------------------------------------------

// VotePower tracks an account's remaining voting energy for one window.
//
// Each window regenerates independently and over its own period: viral
// recharges fully in 7 days, deep in 30. An account therefore cannot spend deep
// votes to exhaust its viral capacity or vice versa.
//
// Power is stored as a fraction scaled by MultScale (MultScale == 100%), and
// computed lazily from the last update rather than ticked, because a contract
// does not get to run every height.
type VotePower struct {
	// Power at LastHeight, scaled by MultScale.
	Power int64
	// LastHeight is when Power was last written.
	LastHeight uint64
}

// NewVotePower returns a fully-charged meter.
func NewVotePower(height uint64) VotePower {
	return VotePower{Power: MultScale, LastHeight: height}
}

// RegenHeights is how long a window takes to recharge from empty to full.
func (w Window) RegenHeights() uint64 {
	return uint64(w.PayoutDays()) * HeightsPerDay
}

// Current returns the power available at the given height, capped at 100%.
func (vp VotePower) Current(w Window, height uint64) int64 {
	if height <= vp.LastHeight {
		return clampPower(vp.Power)
	}
	elapsed := height - vp.LastHeight
	regen := int64(elapsed) * MultScale / int64(w.RegenHeights())
	return clampPower(vp.Power + regen)
}

func clampPower(p int64) int64 {
	if p < 0 {
		return 0
	}
	if p > MultScale {
		return MultScale
	}
	return p
}

// VoteCost returns the power consumed by a vote of the given weight.
//
// weightPct is 1..100. A full (100%) vote costs FullVoteCostPct of total power;
// a partial vote costs proportionally less.
func VoteCost(weightPct int64) int64 {
	if weightPct <= 0 {
		return 0
	}
	if weightPct > 100 {
		weightPct = 100
	}
	return MultScale * FullVoteCostPct * weightPct / (100 * 100)
}

// Spend applies a vote, returning the updated meter and whether it succeeded.
//
// A vote that would overdraw the meter is REFUSED rather than clamped: silently
// casting a weaker vote than the user asked for would misreport their influence.
func (vp VotePower) Spend(w Window, height uint64, weightPct int64) (VotePower, bool) {
	cur := vp.Current(w, height)
	cost := VoteCost(weightPct)
	if cost <= 0 || cost > cur {
		return vp, false
	}
	return VotePower{Power: cur - cost, LastHeight: height}, true
}

// --- vote weight ----------------------------------------------------------

// VoteWeight returns the rshares a vote contributes.
//
//	rshares = L-Shares * votePowerUsed
//
// The reward curve is LINEAR (power 1.0) for both authors and curators, so
// rshares translate directly into reward share with no superlinear
// concentration. Ten small votes are worth exactly one vote ten times the size.
func VoteWeight(shares Shares, powerSpent int64) int64 {
	if shares <= 0 || powerSpent <= 0 {
		return 0
	}
	w, ok := MulDiv(Amount(shares), powerSpent, MultScale)
	if !ok {
		return 0
	}
	return int64(w)
}

// --- reward pools ---------------------------------------------------------

// Pool is one window's accumulating reward pool and the total rshares claiming
// against it.
//
// This is the Hive model: rewards accumulate, posts accrue rshares, and at
// payout each post takes the fraction of the pool its rshares represent. Both
// the pool and the rshares total are then reduced, so the pool can never be
// over-drawn.
type Pool struct {
	Balance Amount
	Rshares int64
}

// Add credits emission into the pool.
func (p *Pool) Add(a Amount) {
	if a > 0 {
		p.Balance += a
	}
}

// AddRshares registers a vote's claim against the pool.
func (p *Pool) AddRshares(r int64) {
	if r > 0 {
		p.Rshares += r
	}
}

// Claim removes a post's share of the pool.
//
//	payout = balance * postRshares / totalRshares
//
// Floors, so the pool is never over-drawn. Both balance and rshares are
// decremented, keeping later claims correctly proportioned.
func (p *Pool) Claim(postRshares int64) Amount {
	if postRshares <= 0 || p.Rshares <= 0 || p.Balance <= 0 {
		return 0
	}
	if postRshares > p.Rshares {
		postRshares = p.Rshares // defensive: never claim more than exists
	}
	out, ok := MulDiv(p.Balance, postRshares, p.Rshares)
	if !ok {
		return 0
	}
	if out > p.Balance {
		out = p.Balance
	}
	p.Balance -= out
	p.Rshares -= postRshares
	return out
}

// --- posts ----------------------------------------------------------------

// Vote is one curator's contribution to a post.
type Vote struct {
	Voter   string
	Rshares int64
}

// Post is a piece of content accruing rewards.
type Post struct {
	Author        string
	Window        Window
	CreatedHeight uint64
	Rshares       int64
	Votes         []Vote
	PaidOut       bool
}

// PayoutHeight is when the post's window closes.
func (p Post) PayoutHeight() uint64 {
	return p.CreatedHeight + p.Window.PayoutHeights()
}

// IsPayable reports whether the post has reached its payout height.
func (p Post) IsPayable(height uint64) bool {
	return !p.PaidOut && height >= p.PayoutHeight()
}

// AddVote records a vote. Voting after the payout height is refused.
func (p *Post) AddVote(v Vote, height uint64) bool {
	if p.PaidOut || height >= p.PayoutHeight() || v.Rshares <= 0 {
		return false
	}
	for i := range p.Votes {
		if p.Votes[i].Voter == v.Voter {
			// Re-vote replaces the previous contribution.
			p.Rshares += v.Rshares - p.Votes[i].Rshares
			p.Votes[i].Rshares = v.Rshares
			return true
		}
	}
	p.Votes = append(p.Votes, v)
	p.Rshares += v.Rshares
	return true
}

// Reward is one account's share of a post payout, already routed.
type Reward struct {
	Account string
	// Liquid pays out immediately.
	Liquid Amount
	// ToPending accrues toward the monthly mint.
	ToPending Amount
}

// Total returns the whole reward before routing.
func (r Reward) Total() Amount { return r.Liquid + r.ToPending }

// RoutePayout splits an amount into the immediate-liquid and pending-mint
// portions: 20% liquid, 80% to the monthly mint.
//
// The pending side takes the remainder so no base unit is lost.
func RoutePayout(amount Amount) (liquid, pending Amount) {
	if amount <= 0 {
		return 0, 0
	}
	l, ok := MulDiv(amount, PoBLiquidPct, 100)
	if !ok {
		return 0, 0
	}
	return l, amount - l
}

// Payout settles a post against its pool, returning the author reward and one
// reward per curator.
//
// INVARIANT, asserted in tests: the sum of every returned Total() equals the
// amount claimed from the pool, exactly. Curation dust is given to the author
// rather than dropped.
func (p *Post) Payout(pool *Pool) (author Reward, curators []Reward, total Amount) {
	if p.PaidOut {
		return Reward{}, nil, 0
	}
	p.PaidOut = true

	total = pool.Claim(p.Rshares)
	if total <= 0 {
		return Reward{Account: p.Author}, nil, 0
	}

	curatorPot, ok := MulDiv(total, CuratorPct, 100)
	if !ok {
		curatorPot = 0
	}

	// Distribute the curator pot proportionally to rshares contributed.
	var handedOut Amount
	if p.Rshares > 0 && curatorPot > 0 {
		curators = make([]Reward, 0, len(p.Votes))
		for _, v := range p.Votes {
			share, ok := MulDiv(curatorPot, v.Rshares, p.Rshares)
			if !ok || share <= 0 {
				continue
			}
			l, pend := RoutePayout(share)
			curators = append(curators, Reward{Account: v.Voter, Liquid: l, ToPending: pend})
			handedOut += share
		}
	}

	// The author takes 75% plus any curation dust, so nothing is lost.
	authorAmount := total - handedOut
	al, ap := RoutePayout(authorAmount)
	author = Reward{Account: p.Author, Liquid: al, ToPending: ap}
	return author, curators, total
}

// --- pending balances and the monthly mint -------------------------------

// PendingAccount is one account's accrual awaiting its monthly mint.
//
// One record per account — not a row per payout. This is the whole reason PoB
// payouts do not create mints directly.
type PendingAccount struct {
	// Balance is the accrued 80% share awaiting minting.
	Balance Amount
	// LastEpoch is the month index in which this account last minted.
	LastEpoch uint64
}

// Pending holds every account's accrual.
type Pending map[string]PendingAccount

// Accrue adds a reward's mint portion to an account's pending balance.
func (pd Pending) Accrue(account string, amount Amount) {
	if amount <= 0 {
		return
	}
	a := pd[account]
	a.Balance += amount
	pd[account] = a
}

// Balance returns an account's pending balance.
func (pd Pending) Balance(account string) Amount { return pd[account].Balance }

// MonthlyMintRequest is what the caller turns into an actual Mint.
type MonthlyMintRequest struct {
	Account string
	Amount  Amount
	Days    int64
}

// SettleAccount converts one account's pending balance into a mint request, if
// a month boundary has passed since it last minted.
//
// THIS IS THE CONTRACT PATH, and it is deliberately lazy — O(1), one account at
// a time, triggered whenever that account is next touched (a reward accrues, or
// the user acts).
//
// A global monthly sweep would NOT work on-chain: iterating every account with
// a pending balance in a single call would blow the WASM gas budget once there
// are thousands of them, and there is no cron. The same reasoning as emission:
// compute from state on touch, never tick over everyone.
//
// epoch is the current month index, derived by the contract from
// block.timestamp. The engine stays pure and clock-free.
//
// days is the account's chosen mint length from settings (1..1095, sliding
// scale). Out-of-range values are CLAMPED rather than rejected — a bad setting
// must never strand a user's rewards.
//
// Balances below MinMintAmount are left in place to roll into the next month,
// so a light user accumulates instead of minting dust.
func (pd Pending) SettleAccount(account string, epoch uint64, days int64) (MonthlyMintRequest, bool) {
	a, exists := pd[account]
	if !exists {
		return MonthlyMintRequest{}, false
	}
	// First sighting: adopt the current epoch without minting, so an account
	// never mints a partial first month it did not accrue through.
	if a.LastEpoch == 0 {
		a.LastEpoch = epoch
		pd[account] = a
		return MonthlyMintRequest{}, false
	}
	if epoch <= a.LastEpoch || a.Balance < MinMintAmount {
		return MonthlyMintRequest{}, false
	}

	if days < MinMintDays {
		days = MinMintDays
	}
	if days > MaxMintDays {
		days = MaxMintDays
	}
	req := MonthlyMintRequest{Account: account, Amount: a.Balance, Days: days}

	a.Balance = 0
	a.LastEpoch = epoch
	pd[account] = a
	return req, true
}

// Touch registers an account at the current epoch without minting. Call when an
// account first accrues, so its month boundary is anchored.
func (pd Pending) Touch(account string, epoch uint64) {
	a, exists := pd[account]
	if !exists || a.LastEpoch == 0 {
		a.LastEpoch = epoch
		pd[account] = a
	}
}

// CollectMonthly settles every account at once.
//
// FOR THE SIMULATOR AND TESTS ONLY — never call this from the contract. It
// iterates every account, which is exactly the gas blow-up SettleAccount
// exists to avoid. It is useful off-chain for projecting a month's mints.
//
// Results are ordered by account name so off-chain runs are reproducible.
func (pd Pending) CollectMonthly(epoch uint64, durationFor func(string) int64) []MonthlyMintRequest {
	accounts := make([]string, 0, len(pd))
	for a := range pd {
		accounts = append(accounts, a)
	}
	sortStrings(accounts)

	out := make([]MonthlyMintRequest, 0, len(accounts))
	for _, a := range accounts {
		if req, ok := pd.SettleAccount(a, epoch, durationFor(a)); ok {
			out = append(out, req)
		}
	}
	return out
}

// sortStrings is a small insertion sort, used only on the off-chain path.
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// --- posting thresholds ---------------------------------------------------

// CanPost reports whether an account holds enough L-Shares to publish in a
// window. Thresholds are governed (median of the top 10) and bounded.
func CanPost(shares Shares, threshold int64) bool {
	return int64(shares) >= threshold
}

// ThresholdKeyFor returns the registry key holding a window's posting threshold.
func ThresholdKeyFor(w Window) ParamKey {
	if w == Deep {
		return ParamPostThresholdDeep
	}
	return ParamPostThresholdViral
}

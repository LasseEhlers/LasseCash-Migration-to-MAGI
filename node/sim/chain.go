// Package sim is the LasseCash dev chain.
//
// It runs the SAME code the real contract runs — contract-template/state, which
// wraps github.com/lassecash/engine — against an in-memory store. There is no
// second implementation of any rule here, and there must never be one. If the
// simulator and the chain ever disagree, the frontend will promise a payout
// MAGI refuses to pay.
//
// What the simulator adds over the contract is only what a chain provides:
// a clock (block height), a calendar (month epoch), and a transaction
// dispatcher. Nothing economic.
package sim

import (
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"contract-template/state"
	"github.com/lassecash/engine"
)

// Chain is a simulated LasseCash chain.
//
// Safe for concurrent use: the HTTP server serves many requests, and a
// half-applied transaction would corrupt the ledger.
type Chain struct {
	mu     sync.Mutex
	store  *state.MemStore
	assets *state.MemAssets

	// height is the simulated Hive block height (3 seconds per unit).
	height uint64
	// genesisTime anchors the calendar so month epochs are real months.
	genesisTime time.Time
	genesis     uint64

	// content stands in for Hive: article bodies, NOT contract state.
	content *contentStore
}

// New returns a chain initialised at the given genesis height.
//
// genesisTime is the wall-clock instant that height corresponds to; the
// simulator derives calendar months from it exactly as the contract derives
// them from block.timestamp.
func New(genesisHeight uint64, genesisTime time.Time) (*Chain, error) {
	c := &Chain{
		store:       state.NewMemStore(),
		assets:      state.NewMemAssets(),
		content:     newContentStore(),
		height:      genesisHeight,
		genesis:     genesisHeight,
		genesisTime: genesisTime.UTC(),
	}
	if r := state.Init(c.store, genesisHeight); !r.OK {
		return nil, errors.New(r.Msg)
	}
	return c, nil
}

// Height returns the current simulated height.
func (c *Chain) Height() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.height
}

// Now returns the simulated wall-clock time at the current height.
func (c *Chain) Now() time.Time { return c.timeAt(c.Height()) }

func (c *Chain) timeAt(h uint64) time.Time {
	if h < c.genesis {
		return c.genesisTime
	}
	secs := int64(h-c.genesis) * engine.SecondsPerHeight
	return c.genesisTime.Add(time.Duration(secs) * time.Second)
}

// epochAt converts a height into a monotonic month index, matching the
// contract's monthEpoch(): year*12 + month.
func (c *Chain) epochAt(h uint64) uint64 {
	t := c.timeAt(h)
	return uint64(t.Year())*12 + uint64(t.Month())
}

// ctx builds the operation context for a sender at the current height.
func (c *Chain) ctx(sender string) state.Ctx {
	return state.Ctx{Sender: sender, Height: c.height, Epoch: c.epochAt(c.height)}
}

// Advance moves the chain forward by n heights, settling emission as it goes.
//
// Settling once at the end would be equivalent — emission is a closed-form
// function of height — but stepping proves that property holds in the
// simulator too, which is exactly the thing a frontend must be able to trust.
func (c *Chain) Advance(heights uint64) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.height += heights
	state.Settle(c.store, c.ctx("system"))
	return c.height
}

// FundHBD gives an account mock HBD on the simulator — standing in for a real
// deposit from Hive L1 to MAGI. Dev-only; the contract never mints HBD.
func (c *Chain) FundHBD(account string, amount int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.assets.Wallets[account] += amount
}

// AdvanceDays is a convenience for the dev UI.
func (c *Chain) AdvanceDays(days uint64) uint64 {
	return c.Advance(days * engine.HeightsPerDay)
}

// --- transactions ---------------------------------------------------------

// Result is a dispatched transaction's outcome.
type Result struct {
	OK     bool   `json:"ok"`
	Msg    string `json:"msg"`
	Height uint64 `json:"height"`
}

// Submit dispatches a transaction by entrypoint name.
//
// The names and argument shapes mirror app/main.go exactly, so a call that
// works here works against the deployed contract unchanged. Keep them in step:
// a divergence here is a frontend that breaks on deploy day.
func (c *Chain) Submit(sender, entrypoint, payload string) Result {
	c.mu.Lock()
	defer c.mu.Unlock()

	ctx := c.ctx(sender)
	args := state.ParseArgs(payload)
	s, a := c.store, c.assets

	var r state.Result
	switch entrypoint {

	// genesis
	case "migrate":
		liquid, okL := args.Amount(1)
		staked, okS := args.Amount(2)
		if !okL || !okS {
			r = bad("usage: <account>|<liquid>|<staked>")
		} else {
			r = state.CreditMigration(s, args.Str(0), liquid, staked)
		}

	case "migrate_batch":
		entries, usage := parseTriples(args)
		if usage {
			r = bad("usage: <account>,<liquid>,<staked>|…")
		} else {
			r = state.CreditMigrationBatch(s, entries)
		}

	case "burn_batch":
		entries, usage := parseTriples(args)
		if usage {
			r = bad("usage: <account>,<liquid>,<staked>|…")
		} else {
			r = state.BurnMigrationBatch(s, entries)
		}

	// claim-based migration
	case "set_snapshot":
		total, okT := args.Amount(1)
		burnT, okB := args.Amount(2)
		if args.Str(0) == "" || !okT || !okB {
			r = bad("usage: <rootHex>|<qualifierTotal>|<burnTotal>")
		} else {
			r = state.SetSnapshot(s, args.Str(0), total, burnT)
		}
	case "claim_migration":
		liquid, okL := args.Amount(0)
		staked, okS := args.Amount(1)
		if !okL || !okS {
			r = bad("usage: <liquid>|<staked>|<proofHex,…>")
		} else {
			r = state.ClaimMigration(s, ctx, liquid, staked, state.ParseProof(args.Str(2)))
		}
	case "record_burn":
		liquid, okL := args.Amount(1)
		staked, okS := args.Amount(2)
		if args.Str(0) == "" || !okL || !okS {
			r = bad("usage: <account>|<liquid>|<staked>|<proofHex,…>")
		} else {
			r = state.RecordBurn(s, args.Str(0), liquid, staked, state.ParseProof(args.Str(3)))
		}
	case "sweep_unclaimed":
		r = state.SweepUnclaimed(s, ctx)

	// ledger
	case "transfer":
		amount, ok := args.Amount(1)
		if !ok {
			r = bad("usage: <to>|<amount>")
		} else {
			r = state.Transfer(s, ctx, args.Str(0), amount)
		}
	case "burn":
		amount, ok := args.Amount(0)
		if !ok {
			r = bad("usage: <amount>")
		} else {
			r = state.Burn(s, ctx, amount)
		}
	case "settle":
		r = state.Settle(s, ctx)

	// minting
	case "mint":
		amount, okA := args.Amount(0)
		days, okD := args.I64(1)
		if !okA || !okD {
			r = bad("usage: <amount>|<days>")
		} else {
			_, r = state.CreateMint(s, ctx, amount, days)
		}
	case "claim_mint":
		id, ok := args.U64(0)
		if !ok {
			r = bad("usage: <mintId>")
		} else {
			r = state.ClaimMint(s, ctx, id)
		}
	case "sweep_mint":
		id, ok := args.U64(1)
		if args.Str(0) == "" || !ok {
			r = bad("usage: <owner>|<mintId>")
		} else {
			r = state.SweepMint(s, ctx, args.Str(0), id)
		}
	case "good_accounting":
		id, ok := args.U64(0)
		if !ok {
			r = bad("usage: <mintId>")
		} else {
			r = state.ArmGoodAccounting(s, ctx, id)
		}
	case "set_duration":
		days, ok := args.I64(0)
		if !ok {
			r = bad("usage: <days>")
		} else {
			r = state.SetMintDuration(s, ctx, days)
		}
	case "settle_pending":
		account := args.Str(0)
		if account == "" {
			account = sender
		}
		r = state.SettlePending(s, ctx, account)

	// governance
	case "promote":
		account := args.Str(0)
		if account == "" {
			account = sender
		}
		r = state.Promote(s, account)
	case "set_param":
		value, ok := args.I64(1)
		if !ok {
			r = bad("usage: <paramKey>|<value>")
		} else {
			r = state.SetPreference(s, ctx, args.Str(0), value)
		}

	// LasseMedia
	case "post":
		w, ok := args.U64(1)
		if !ok || w > 1 {
			r = bad("usage: <permlink>|<window 0=viral 1=deep>|[payoutMode]")
		} else {
			mode, _ := args.U64(2) // absent = 0 = the default 20/80 split
			r = state.CreatePost(s, ctx, args.Str(0), window(w), state.PayoutMode(mode))
		}
	case "comment":
		permlink, pa, pp := args.Str(0), args.Str(1), args.Str(2)
		if permlink == "" || pa == "" || pp == "" {
			r = bad("usage: <permlink>|<parentAuthor>|<parentPermlink>|[payoutMode]")
		} else {
			mode, _ := args.U64(3)
			r = state.CreateComment(s, ctx, permlink, state.PayoutMode(mode), pa, pp)
		}
	case "promote_post":
		amount, ok := args.Amount(2)
		if args.Str(0) == "" || args.Str(1) == "" || !ok {
			r = bad("usage: <author>|<permlink>|<amount>")
		} else {
			r = state.PromotePost(s, ctx, args.Str(0), args.Str(1), amount)
		}
	case "vote":
		weight, ok := args.I64(2)
		if !ok {
			r = bad("usage: <author>|<permlink>|<weightPct>")
		} else {
			r = state.Vote(s, ctx, args.Str(0), args.Str(1), weight)
		}
	case "payout":
		r = state.Payout(s, ctx, args.Str(0), args.Str(1))
	case "sweep_curation":
		r = state.SweepCuration(s, ctx, args.Str(0), args.Str(1))
	case "claim_curation":
		// Third argument optional: anyone may settle for any curator.
		r = state.ClaimCuration(s, ctx, args.Str(0), args.Str(1), args.Str(2))

	// pool
	case "add_liquidity":
		lcIn, okL := args.Amount(0)
		maxHbd, okH := args.Amount(1)
		if !okL || !okH {
			r = bad("usage: <lcAmount>|<maxHbd>")
		} else {
			_, r = state.AddLiquidity(s, a, ctx, lcIn, maxHbd)
		}
	case "remove_liquidity":
		id, ok := args.U64(0)
		if !ok {
			r = bad("usage: <trancheId>")
		} else {
			r = state.RemoveLiquidity(s, a, ctx, id)
		}
	case "claim_pool":
		id, ok := args.U64(0)
		if !ok {
			r = bad("usage: <trancheId>")
		} else {
			r = state.ClaimPoolRewards(s, ctx, id)
		}
	case "swap_lc_hbd":
		in, okI := args.Amount(0)
		minOut, okM := args.Amount(1)
		if !okI || !okM {
			r = bad("usage: <lcIn>|<minHbdOut>")
		} else {
			r = state.SwapLCForHBD(s, a, ctx, in, minOut)
		}
	case "swap_hbd_lc":
		in, okI := args.Amount(0)
		minOut, okM := args.Amount(1)
		if !okI || !okM {
			r = bad("usage: <hbdIn>|<minLcOut>")
		} else {
			r = state.SwapHBDForLC(s, a, ctx, in, minOut)
		}

	default:
		r = bad("unknown entrypoint: " + entrypoint)
	}

	return Result{OK: r.OK, Msg: r.Msg, Height: c.height}
}

func bad(msg string) state.Result { return state.Result{OK: false, Msg: msg} }

func window(w uint64) engine.Window {
	if w == 1 {
		return engine.Deep
	}
	return engine.Viral
}

// --- reads ----------------------------------------------------------------
//
// Everything below is DERIVED FROM CONTRACT STATE. The simulator computes no
// economics of its own — it reads what the contract already decided. This is
// the same discipline the TypeScript indexer must follow.

// ChainInfo is the chain's global position.
type ChainInfo struct {
	Height         uint64 `json:"height"`
	Timestamp      string `json:"timestamp"`
	Epoch          uint64 `json:"epoch"`
	GenesisHeight  uint64 `json:"genesis_height"`
	SettledHeight  uint64 `json:"settled_height"`
	MigratedSupply string `json:"migrated_supply"`
	// SnapshotTotal is burned + claimable as committed at genesis (claim
	// model); equals MigratedSupply once every claim has landed or swept.
	SnapshotTotal string `json:"snapshot_total"`
	// SnapshotBurn is the burn half of the snapshot, fixed at genesis. NOT
	// the same as TotalBurned, which also carries every burn since.
	SnapshotBurn   string   `json:"snapshot_burned"`
	TotalEmitted   string   `json:"total_emitted"`
	TotalBurned    string   `json:"total_burned"`
	TotalShares    string   `json:"total_shares"`
	PoolLShare     string   `json:"pool_lshare"`
	PoolViral      string   `json:"pool_viral"`
	PoolDeep       string   `json:"pool_deep"`
	PoolLiquidity  string   `json:"pool_liquidity"`
	AmmLC          string   `json:"amm_lc"`
	AmmHBD         string   `json:"amm_hbd"`
	AmmShares      string   `json:"amm_shares"`
	ConsensusGroup []string `json:"consensus_group"`
}

// Info returns the chain's global position.
func (c *Chain) Info() ChainInfo {
	c.mu.Lock()
	defer c.mu.Unlock()

	lcRes, hbdRes := state.PoolReserves(c.store)
	members := state.ConsensusMembers(c.store)
	group := make([]string, 0, len(members))
	for _, m := range members {
		group = append(group, m.Account)
	}

	return ChainInfo{
		Height:         c.height,
		Timestamp:      c.timeAt(c.height).Format(time.RFC3339),
		Epoch:          c.epochAt(c.height),
		GenesisHeight:  state.GenesisHeight(c.store),
		SettledHeight:  state.SettledHeight(c.store),
		MigratedSupply: dec(state.MigratedSupply(c.store)),
		SnapshotTotal:  dec(state.SnapshotTotal(c.store)),
		SnapshotBurn:   dec(state.SnapshotBurn(c.store)),
		TotalEmitted:   dec(state.TotalEmitted(c.store)),
		TotalBurned:    dec(state.TotalBurned(c.store)),
		TotalShares:    dec(engine.Amount(state.TotalShares(c.store))),
		PoolLShare:     dec(state.PoolLShare(c.store)),
		PoolViral:      dec(state.PoolViral(c.store)),
		PoolDeep:       dec(state.PoolDeep(c.store)),
		PoolLiquidity:  dec(c.rawAmount("pool_liq")),
		AmmLC:          dec(lcRes),
		AmmHBD:         dec(hbdRes),
		AmmShares:      dec(engine.Amount(state.PoolShares(c.store))),
		ConsensusGroup: group,
	}
}

// MintView is one mint, with everything the dashboard needs already computed.
type MintView struct {
	ID             uint64 `json:"id"`
	Principal      string `json:"principal"`
	Shares         string `json:"shares"`
	StartHeight    uint64 `json:"start_height"`
	Days           int64  `json:"days"`
	MaturityHeight uint64 `json:"maturity_height"`
	MaturityTime   string `json:"maturity_time"`
	Mature         bool   `json:"mature"`
	GoodAccounting bool   `json:"good_accounting"`
	CanArm         bool   `json:"can_arm_good_accounting"`
	Ended          bool   `json:"ended"`
	PendingYield   string `json:"pending_yield"`
	// IfClaimedNow is what the owner would receive right now — the number the
	// dashboard shows. Computed by the ENGINE, never by the frontend.
	IfClaimedNow string `json:"if_claimed_now"`
	Slashed      string `json:"slashed_if_claimed_now"`
	BleedPct     string `json:"bleed_remaining_pct"`
}

// TrancheView is one liquidity position.
type TrancheView struct {
	ID          uint64 `json:"id"`
	Shares      string `json:"shares"`
	StartHeight uint64 `json:"start_height"`
	AgeDays     int64  `json:"age_days"`
	LoyaltyX    string `json:"loyalty_multiplier"`
	Weight      string `json:"weight"`
	Closed      bool   `json:"closed"`
	ValueLC     string `json:"value_lc"`
	ValueHBD    string `json:"value_hbd"`
	// PendingReward is what "Claim rewards" would pay right now. Engine-computed.
	PendingReward string `json:"pending_reward"`
	// LastTouch is the height of the last proof of life (deposit, claim or
	// withdraw) — the anti-zombie clock's zero point.
	LastTouch uint64 `json:"last_touch"`
}

// AccountView is everything the frontend shows for one account.
type AccountView struct {
	Account     string            `json:"account"`
	Balance     string            `json:"balance"`
	Shares      string            `json:"shares"`
	Pending     string            `json:"pending"`
	MintDays    int64             `json:"mint_duration_days"`
	HBD         int64             `json:"hbd"`
	VotePower   map[string]string `json:"vote_power"`
	Mints       []MintView        `json:"mints"`
	Tranches    []TrancheView     `json:"tranches"`
	IsConsensus bool              `json:"is_consensus_member"`
}

// Account assembles an account view straight from contract state.
func (c *Chain) Account(account string) AccountView {
	c.mu.Lock()
	defer c.mu.Unlock()

	s, h := c.store, c.height
	v := AccountView{
		Account:  account,
		Balance:  dec(state.Balance(s, account)),
		Shares:   dec(engine.Amount(state.SharesOf(s, account))),
		Pending:  dec(state.PendingOf(s, account)),
		MintDays: state.MintDuration(s, account),
		HBD:      c.assets.Wallets[account],
		VotePower: map[string]string{
			"viral": pct(state.VotePowerOf(s, account, engine.Viral, h)),
			"deep":  pct(state.VotePowerOf(s, account, engine.Deep, h)),
		},
		IsConsensus: engine.IsMember(state.ConsensusMembers(s), account),
	}

	// Mints, newest first — the dashboard leads with what just happened.
	seq := c.rawU64("mseq_" + account)
	for id := seq; id >= 1; id-- {
		m, found := state.GetMint(s, account, id)
		if !found {
			continue
		}
		yield := state.PendingYield(s, account, id, h)
		settlement := m.Settle(h, yield)
		v.Mints = append(v.Mints, MintView{
			ID:             id,
			Principal:      dec(m.Principal),
			Shares:         dec(engine.Amount(m.Shares)),
			StartHeight:    m.StartHeight,
			Days:           m.Days,
			MaturityHeight: m.MaturityHeight(),
			MaturityTime:   c.timeAt(m.MaturityHeight()).Format(time.RFC3339),
			Mature:         m.IsMature(h),
			GoodAccounting: m.GoodAccounting,
			CanArm:         m.CanArmGoodAccounting(h),
			Ended:          m.Ended,
			PendingYield:   dec(yield),
			IfClaimedNow:   dec(settlement.ToOwner),
			Slashed:        dec(settlement.ToRewardPool),
			BleedPct:       pct(m.BleedRemaining(h)),
		})
		if id == 1 {
			break
		}
	}

	// Liquidity tranches.
	lcRes, hbdRes := state.PoolReserves(s)
	totalShares := state.PoolShares(s)
	lseq := c.rawU64("lpseq_" + account)
	for id := lseq; id >= 1; id-- {
		t, found := state.GetTranche(s, account, id)
		if !found {
			continue
		}
		age := engine.AgeDays(t.StartHeight, h)
		valLC, valHBD, _ := engine.WithdrawAmounts(t.Shares, totalShares, lcRes, hbdRes)
		v.Tranches = append(v.Tranches, TrancheView{
			ID:            id,
			Shares:        dec(engine.Amount(t.Shares)),
			StartHeight:   t.StartHeight,
			AgeDays:       age,
			LoyaltyX:      pct(engine.LoyaltyMultiplier(age)),
			Weight:        dec(engine.Amount(t.Weight)),
			Closed:        t.Closed,
			ValueLC:       dec(valLC),
			ValueHBD:      dec(valHBD),
			PendingReward: dec(state.PoolRewardsOwed(s, t)),
			LastTouch:     t.LastTouch,
		})
		if id == 1 {
			break
		}
	}
	return v
}

// StateKeys returns raw contract state, mirroring MAGI's getStateByKeys.
func (c *Chain) StateKeys(keys []string) map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]string{}
	for _, k := range keys {
		if v := c.store.Get(k); v != nil {
			out[k] = *v
		}
	}
	return out
}

// Dump returns every state key, sorted. Debugging only — a real node would
// never expose this, and nothing in the frontend may depend on it.
func (c *Chain) Dump() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	keys := c.store.Keys()
	sort.Strings(keys)
	out := make(map[string]string, len(keys))
	for _, k := range keys {
		if v := c.store.Get(k); v != nil {
			out[k] = *v
		}
	}
	return out
}

// --- helpers --------------------------------------------------------------

func (c *Chain) rawAmount(key string) engine.Amount {
	v := c.store.Get(key)
	if v == nil {
		return 0
	}
	n, _ := strconv.ParseInt(*v, 10, 64)
	return engine.Amount(n)
}

// rawString reads a state value, collapsing MAGI's empty-string-for-missing
// into "". Never test a state key with != nil alone — see CLAUDE.md, the
// empty-vs-nil bug.
func (c *Chain) rawString(key string) string {
	v := c.store.Get(key)
	if v == nil {
		return ""
	}
	return *v
}

func (c *Chain) rawU64(key string) uint64 {
	v := c.store.Get(key)
	if v == nil {
		return 0
	}
	n, _ := strconv.ParseUint(*v, 10, 64)
	return n
}

// dec renders base units as a fixed 8-decimal string.
//
// Amounts cross the wire as STRINGS, never JSON numbers: 51,000,000 LASSECASH
// is 5.1e15 base units, and JavaScript's Number loses precision above 2^53.
// A frontend that parsed these as floats would display balances that do not
// match the chain.
func dec(a engine.Amount) string {
	neg := ""
	v := int64(a)
	if v < 0 {
		neg, v = "-", -v
	}
	whole := v / engine.Unit
	frac := v % engine.Unit
	fs := strconv.FormatInt(frac, 10)
	return neg + strconv.FormatInt(whole, 10) + "." + strings.Repeat("0", 8-len(fs)) + fs
}

// pct renders a MultScale-scaled fraction as a decimal string.
func pct(v int64) string { return dec(engine.Amount(v)) }

// Publish writes an article to the content layer and registers it with the
// contract, in that order.
//
// Order matters: if registration fails (below the posting threshold, duplicate
// permlink) the article is still readable, but no reward window opened — which
// is recoverable. Registering first and failing to publish would open a payout
// window over content that does not exist.
//
// `link` is the author's chosen slug — the short URL — or empty to derive one
// from the title. Either way it is normalised through Permlink so the key the
// contract stores is always a valid, lowercase `[a-z0-9-]` string.
func (c *Chain) Publish(
	sender, title, body, summary string, tags []string,
	window engine.Window, mode uint64, link string,
) (string, Result) {
	permlink := Permlink(link)
	if permlink == "" {
		permlink = Permlink(title)
	}
	if permlink == "" {
		return "", Result{Msg: "title must contain letters or numbers", Height: c.Height()}
	}
	c.content.put(sender, permlink, Content{
		Title: title, Body: body, Summary: summary, Tags: tags,
	})
	payload := permlink + "|" + strconv.FormatUint(uint64(window), 10) +
		"|" + strconv.FormatUint(mode, 10)
	return permlink, c.Submit(sender, "post", payload)
}

// PublishComment writes a REPLY to the content layer and registers it, in the
// same order and for the same reason as Publish.
//
// A comment is a post record with a parent: same encoding, viral economics,
// but gated by the lower `post.threshold_comment` stake. The permlink is
// supplied by the CALLER rather than derived from a title — a reply has no
// title, and the frontend has already derived the permlink it wrote to the
// content layer. Both steps must use the identical string or the reward
// attaches to nothing.
func (c *Chain) PublishComment(
	sender, permlink, body, parentAuthor, parentPermlink string, mode uint64,
) (string, Result) {
	if permlink == "" {
		return "", Result{Msg: "permlink required", Height: c.Height()}
	}
	if parentAuthor == "" || parentPermlink == "" {
		return "", Result{Msg: "a comment needs a parent post", Height: c.Height()}
	}
	// The reply has no title of its own; the feed and the sitemap never list
	// comments, so nothing needs one.
	c.content.put(sender, permlink, Content{Body: body})
	payload := permlink + "|" + parentAuthor + "|" + parentPermlink +
		"|" + strconv.FormatUint(mode, 10)
	return permlink, c.Submit(sender, "comment", payload)
}

// Content returns an article body, if the content layer has it.
func (c *Chain) Content(author, permlink string) (Content, bool) {
	return c.content.get(author, permlink)
}

// --- quotes ---------------------------------------------------------------
//
// A preview is still a calculation, so it MUST come from the engine — the
// frontend may never work out what a swap or a mint would produce. On a real
// node these map to simulateContractCalls; here they call the same engine
// functions the entrypoints call, against live state.

// SwapQuote previews a swap without executing it.
type SwapQuote struct {
	AmountIn   string `json:"amount_in"`
	AmountOut  string `json:"amount_out"`
	Rate       string `json:"rate"`
	Impact     string `json:"price_impact_pct"`
	ReserveIn  string `json:"reserve_in"`
	ReserveOut string `json:"reserve_out"`
	OK         bool   `json:"ok"`
	Msg        string `json:"msg"`
}

// QuoteSwap previews selling `amountIn` in the given direction.
// direction is "lc_hbd" (sell LASSECASH) or "hbd_lc" (buy LASSECASH).
func (c *Chain) QuoteSwap(direction string, amountIn engine.Amount) SwapQuote {
	c.mu.Lock()
	defer c.mu.Unlock()

	lcRes, hbdRes := state.PoolReserves(c.store)

	resIn, resOut := lcRes, hbdRes
	if direction == "hbd_lc" {
		resIn, resOut = hbdRes, lcRes
	}

	q := SwapQuote{
		AmountIn:  dec(amountIn),
		ReserveIn: dec(resIn), ReserveOut: dec(resOut),
	}
	out, ok := engine.SwapOut(resIn, resOut, amountIn)
	if !ok {
		q.Msg = "swap not possible at this size"
		return q
	}
	q.OK = true
	q.AmountOut = dec(out)

	// Rate: output per 1.0 unit of input.
	if amountIn > 0 {
		if rate, okRate := engine.MulDiv(out, engine.Unit, int64(amountIn)); okRate {
			q.Rate = dec(rate)
		}
	}
	// Price impact: how far the executed rate sits below the spot rate.
	if resIn > 0 {
		spot, okSpot := engine.MulDiv(resOut, engine.Unit, int64(resIn))
		if okSpot && spot > 0 {
			exec, okExec := engine.MulDiv(out, engine.Unit, int64(amountIn))
			if okExec {
				diff := spot - exec
				if impact, okImp := engine.MulDiv(diff, 100*engine.Unit, int64(spot)); okImp {
					q.Impact = dec(impact)
				}
			}
		}
	}
	return q
}

// MintQuote previews a mint without creating it.
type MintQuote struct {
	Principal      string `json:"principal"`
	Days           int64  `json:"days"`
	Shares         string `json:"shares"`
	ShareRate      string `json:"share_rate"`
	DurationBonus  string `json:"duration_multiplier"`
	VolumeBonus    string `json:"volume_multiplier"`
	Combined       string `json:"combined_multiplier"`
	MaturityHeight uint64 `json:"maturity_height"`
	MaturityTime   string `json:"maturity_time"`
	OK             bool   `json:"ok"`
	Msg            string `json:"msg"`
}

// QuoteMint previews the L-Shares a mint would grant, using the parameters and
// share rate in force right now.
func (c *Chain) QuoteMint(principal engine.Amount, days int64) MintQuote {
	c.mu.Lock()
	defer c.mu.Unlock()

	ctx := c.ctx("preview")
	params := state.MintParamsNow(c.store, ctx)

	q := MintQuote{
		Principal: dec(principal), Days: days,
		ShareRate:     dec(params.ShareRate),
		DurationBonus: pct(engine.DurationMultiplier(days)),
		VolumeBonus:   pct(engine.VolumeMultiplier(principal, params.VolumeStart, params.VolumeEnd)),
	}
	combined, _ := engine.MulDiv(
		engine.Amount(engine.DurationMultiplier(days)),
		engine.VolumeMultiplier(principal, params.VolumeStart, params.VolumeEnd),
		engine.MultScale)
	q.Combined = pct(int64(combined))

	shares, ok := engine.ComputeShares(principal, days, params)
	if !ok {
		q.Msg = "mint not valid: check amount and duration (1..1095 days)"
		return q
	}
	q.OK = true
	q.Shares = dec(engine.Amount(shares))
	mh := c.height + uint64(days)*engine.HeightsPerDay
	q.MaturityHeight = mh
	q.MaturityTime = c.timeAt(mh).Format(time.RFC3339)
	return q
}

// LiquidityQuote previews what a deposit requires and what it earns.
type LiquidityQuote struct {
	LCIn      string `json:"lc_in"`
	HBDNeeded string `json:"hbd_needed"`
	Shares    string `json:"shares"`
	PoolShare string `json:"pool_share_pct"`
	First     bool   `json:"is_first_deposit"`
	OK        bool   `json:"ok"`
	Msg       string `json:"msg"`
}

// QuoteLiquidity previews an add_liquidity call.
func (c *Chain) QuoteLiquidity(lcIn engine.Amount) LiquidityQuote {
	c.mu.Lock()
	defer c.mu.Unlock()

	lcRes, hbdRes := state.PoolReserves(c.store)
	total := state.PoolShares(c.store)
	q := LiquidityQuote{LCIn: dec(lcIn)}

	if total <= 0 || lcRes <= 0 || hbdRes <= 0 {
		q.First, q.OK = true, true
		q.Msg = "first deposit sets the opening price — supply any HBD amount"
		return q
	}
	need, okNeed := engine.HbdRequiredFor(lcIn, lcRes, hbdRes)
	if !okNeed {
		q.Msg = "cannot price deposit"
		return q
	}
	shares, okShares := engine.LPSharesFor(lcIn, lcRes, total)
	if !okShares {
		q.Msg = "deposit too small to earn shares"
		return q
	}
	q.OK = true
	q.HBDNeeded = dec(need)
	q.Shares = dec(engine.Amount(shares))
	if newTotal := total + shares; newTotal > 0 {
		if p, okP := engine.MulDiv(engine.Amount(shares), 100*engine.Unit, int64(newTotal)); okP {
			q.PoolShare = dec(p)
		}
	}
	return q
}

// --- content listing ------------------------------------------------------
//
// NOTE ON WHERE THIS BELONGS: the CONTRACT cannot enumerate posts — that is
// unbounded iteration and would blow the gas budget. Listing is an off-chain
// concern. The simulator can scan its own store because it holds the whole
// state in memory; a real indexer builds the same view from transaction
// history. Either way the numbers below are read from contract state, never
// recomputed.

// PostView is one post, with its payout position already worked out.
type PostView struct {
	Author        string `json:"author"`
	Permlink      string `json:"permlink"`
	Window        string `json:"window"`
	CreatedHeight uint64 `json:"created_height"`
	CreatedTime   string `json:"created_time"`
	PayoutHeight  uint64 `json:"payout_height"`
	PayoutTime    string `json:"payout_time"`
	Rshares       string `json:"rshares"`
	PayoutMode    int    `json:"payout_mode"`
	// ParentAuthor/ParentPermlink are set for COMMENTS (registered replies).
	ParentAuthor   string `json:"parent_author"`
	ParentPermlink string `json:"parent_permlink"`
	// Promoted is the total LASSECASH burned to promote this post.
	Promoted string `json:"promoted"`
	Title    string `json:"title"`
	Summary  string `json:"summary"`
	// BodyExcerpt is the opening of the article — enough for the feed card to
	// find a cover image and show a preview, not the whole post.
	BodyExcerpt string   `json:"body_excerpt"`
	Tags        []string `json:"tags"`
	Votes       int      `json:"votes"`
	PaidOut     bool     `json:"paid_out"`
	Payable     bool     `json:"payable"`
	// PendingPayout is what the post would earn if it paid out right now,
	// computed by the engine against the live window pool.
	PendingPayout string `json:"pending_payout"`
	CuratorPot    string `json:"curator_pot"`
	// CurationExpiresAt is when an unclaimed curator pot may be swept into the
	// reward pool. Zero until the post has paid out.
	CurationExpiresAt uint64 `json:"curation_expires_at"`
	// Registered is always true here: the simulator can only see posts it
	// holds a record for. Against MAGI the indexer also surfaces Hive posts
	// tagged `lassecash` whose author clears the viral threshold, which carry
	// no record and no economics until the first vote registers them — those
	// come back false. The field exists on both so the UI has one shape.
	Registered bool `json:"registered"`
}

// Posts lists content, newest first.
func (c *Chain) Posts(limit int) []PostView {
	c.mu.Lock()
	defer c.mu.Unlock()

	if limit <= 0 || limit > 200 {
		limit = 50
	}
	keys := c.store.Keys()
	sortStrings(keys)

	out := make([]PostView, 0, limit)
	for _, k := range keys {
		if !strings.HasPrefix(k, "post_") {
			continue
		}
		// post_<author>_<permlink>. Keys are flat (slashes do not persist on
		// MAGI — see CLAUDE.md), so the split is at the FIRST underscore:
		// hive account names cannot contain one, and authors are the chain-
		// validated sender, never free text.
		rest := strings.TrimPrefix(k, "post_")
		sep := strings.Index(rest, "_")
		if sep < 0 {
			continue
		}
		author, permlink := rest[:sep], rest[sep+1:]

		p, ok := state.GetPostView(c.store, author, permlink)
		if !ok {
			continue
		}
		// ROOT POSTS ONLY. A registered reply is a post record with a parent,
		// and it must never surface in the feed, the sitemap or the RSS as an
		// article. Replies are served by Comments() instead — which is also
		// what MagiBackend does, where the two lists are disjoint because
		// discovery watches two different entrypoints.
		if p.ParentPermlink != "" {
			continue
		}
		out = append(out, c.viewOf(author, permlink, p))
		if len(out) >= limit {
			break
		}
	}
	// Newest first.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// Comments lists the registered REPLIES to one post, newest first.
//
// SCANNING KEYS IS FINE HERE AND NOWHERE ELSE, exactly as in Posts() and
// PostVotes(): the contract can never enumerate, which is why listing lives
// off-chain. MagiBackend reaches the same rows by rediscovering `comment`
// calls from transaction history.
//
// Every figure below is read from contract state. A reply earns viral
// economics and carries a real pending payout, so it is a full PostView — the
// UI renders it more lightly, but the money is the same money.
func (c *Chain) Comments(author, permlink string) []PostView {
	c.mu.Lock()
	defer c.mu.Unlock()

	keys := c.store.Keys()
	sortStrings(keys)

	out := []PostView{}
	for _, k := range keys {
		if !strings.HasPrefix(k, "post_") {
			continue
		}
		rest := strings.TrimPrefix(k, "post_")
		sep := strings.Index(rest, "_")
		if sep < 0 {
			continue
		}
		a, pl := rest[:sep], rest[sep+1:]
		p, ok := state.GetPostView(c.store, a, pl)
		if !ok || p.ParentAuthor != author || p.ParentPermlink != permlink {
			continue
		}
		out = append(out, c.viewOf(a, pl, p))
	}
	// Newest first. The UI re-orders by pending reward, which is a fact about
	// money it already holds; a stable order here is only so two calls agree.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// viewOf renders one post record — root or reply — as a PostView.
//
// ONE decoder for both, because a comment IS a post record with a parent:
// same encoding, same window arithmetic, same payout estimate. A second copy
// is how the two would drift the day the frozen field order grew a field.
//
// Caller must hold c.mu.
func (c *Chain) viewOf(author, permlink string, p state.PostRecord) PostView {
	w := engine.Viral
	name := "viral"
	if p.Window == uint8(engine.Deep) {
		w, name = engine.Deep, "deep"
	}
	payoutHeight := p.CreatedHeight + w.PayoutHeights()

	body, _ := c.content.get(author, permlink)
	title := body.Title
	// A reply has no title and needs none — it is rendered as a body. Only a
	// root post registered on-chain but never published to the content layer
	// gets the permlink as a stand-in, so the feed shows a card and not a gap.
	if title == "" && p.ParentPermlink == "" {
		title = strings.ReplaceAll(permlink, "-", " ")
	}
	return PostView{
		Author:            author,
		Permlink:          permlink,
		PayoutMode:        int(p.Mode),
		ParentAuthor:      p.ParentAuthor,
		ParentPermlink:    p.ParentPermlink,
		Promoted:          dec(p.Promoted),
		Title:             title,
		Summary:           body.Summary,
		BodyExcerpt:       excerptOf(body.Body, 600),
		Tags:              body.Tags,
		Window:            name,
		CreatedHeight:     p.CreatedHeight,
		CreatedTime:       c.timeAt(p.CreatedHeight).Format(time.RFC3339),
		PayoutHeight:      payoutHeight,
		PayoutTime:        c.timeAt(payoutHeight).Format(time.RFC3339),
		Rshares:           encI64(p.Rshares),
		Votes:             state.VoteCount(c.store, author, permlink),
		PaidOut:           p.PaidOut,
		Payable:           !p.PaidOut && c.height >= payoutHeight,
		PendingPayout:     dec(state.PendingPayout(c.store, author, permlink)),
		CuratorPot:        dec(p.CuratorPot),
		CurationExpiresAt: state.CurationExpiresAt(c.store, author, permlink),
		Registered:        true,
	}
}

// GovernanceMember is one `gov_board` account as RAW STATE.
//
// Base-unit strings, not decimals: these rows exist to be handed straight to
// engine.ConsensusGroup and engine.EffectiveValue. Nothing here decides who
// holds a seat or what value is in force — the median, the clamping and the
// tie-break belong to the engine, and this is the identical read a foreign
// dApp contract makes against the frozen public ABI (CLAUDE.md, "Public state
// ABI").
type GovernanceMember struct {
	Account string `json:"account"`
	Shares  string `json:"shares"`
	// Preferences maps a parameter key to that member's standing preference.
	// ABSENT (null) means never voted — which is NOT zero. The engine skips a
	// non-voter; one counted at zero would drag every median to the floor.
	Preferences map[string]*string `json:"preferences"`
}

// Governance returns the whole board — up to 20 candidates, not a
// pre-selected ten — with each member's L-Shares and standing preferences.
func (c *Chain) Governance(paramKeys []string) []GovernanceMember {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := []GovernanceMember{}
	for _, account := range strings.Split(c.rawString("gov_board"), "|") {
		if account == "" {
			continue
		}
		prefs := map[string]*string{}
		for _, k := range paramKeys {
			if k == "" {
				continue
			}
			// A missing key reads as a pointer to "" here exactly as it does
			// on MAGI, so empty must collapse to absent — never to "0".
			if v := c.rawString("gov_" + k + "_" + account); v != "" {
				pref := v
				prefs[k] = &pref
			} else {
				prefs[k] = nil
			}
		}
		shares := c.rawString("shr_" + account)
		if shares == "" {
			shares = "0"
		}
		out = append(out, GovernanceMember{
			Account: account, Shares: shares, Preferences: prefs,
		})
	}
	return out
}

func encI64(v int64) string { return strconv.FormatInt(v, 10) }

// excerptOf returns the opening of a body, cut on a rune boundary so the
// excerpt can never end mid-character and corrupt the JSON.
func excerptOf(body string, max int) string {
	if len(body) <= max {
		return body
	}
	r := []rune(body)
	if len(r) <= max {
		return body
	}
	return string(r[:max])
}

func sortStrings(s []string) { sort.Strings(s) }

// parseTriples mirrors app/main.go: `<account>,<liquid>,<staked>|…`, each
// triple split at its LAST TWO commas.
func parseTriples(args state.Args) ([]state.MigrationEntry, bool) {
	entries := make([]state.MigrationEntry, 0, len(args))
	for i := range args {
		triple := args.Str(i)
		cutS := strings.LastIndexByte(triple, ',')
		cutL := -1
		if cutS > 0 {
			cutL = strings.LastIndexByte(triple[:cutS], ',')
		}
		if cutL <= 0 || cutS == len(triple)-1 {
			return nil, true
		}
		liq, errL := strconv.ParseInt(triple[cutL+1:cutS], 10, 64)
		stk, errS := strconv.ParseInt(triple[cutS+1:], 10, 64)
		if errL != nil || errS != nil || liq < 0 || stk < 0 {
			return nil, true
		}
		entries = append(entries, state.MigrationEntry{
			Account: triple[:cutL],
			Liquid:  engine.Amount(liq),
			Staked:  engine.Amount(stk),
		})
	}
	return entries, false
}

// VoteView is one voter's recorded weight on a post.
//
// Rshares cross the wire as a STRING for the same reason every amount does:
// they are 1e8-scaled and a large post's total leaves JavaScript's safe
// integer range.
type VoteView struct {
	Voter   string `json:"voter"`
	Rshares string `json:"rshares"`
}

// PostVotes lists a post's surviving vote records, heaviest first.
//
// SCANNING KEYS IS FINE HERE AND NOWHERE ELSE. The contract can never
// enumerate — unbounded iteration does not fit in the gas budget — which is
// exactly why this lives in the simulator, alongside Posts(), and why the
// MAGI backend has to rediscover the voters from transaction history instead.
//
// ⚠️ A vote record is DELETED when its curator is paid, so this list shrinks
// after payout while the post's vote counter stays put. The UI must say so
// rather than presenting it as everyone who ever voted.
func (c *Chain) PostVotes(author, permlink string) []VoteView {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Key layout is contract/state/keys.go postVoteKey:
	// pv_<author>_<permlink>_<voter>. Author and permlink are both known, so
	// the prefix is exact and the remainder is the voter — nothing is parsed.
	prefix := "pv_" + author + "_" + permlink + "_"
	out := []VoteView{}
	for _, k := range c.store.Keys() {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		v := c.store.Get(k)
		// A missing key reads as a pointer to "" on MAGI, and MemStore is
		// deliberately just as awkward. Never test for nil alone.
		if v == nil || *v == "" {
			continue
		}
		n, err := strconv.ParseInt(*v, 10, 64)
		if err != nil {
			continue
		}
		out = append(out, VoteView{Voter: strings.TrimPrefix(k, prefix), Rshares: encI64(n)})
	}
	// Heaviest first, then by name, so the order is stable across calls.
	sort.Slice(out, func(i, j int) bool {
		a, _ := strconv.ParseInt(out[i].Rshares, 10, 64)
		b, _ := strconv.ParseInt(out[j].Rshares, 10, 64)
		if a != b {
			return a > b
		}
		return out[i].Voter < out[j].Voter
	})
	return out
}

// Package main is the LasseCash contract for MAGI.
//
// It is deliberately THIN. Every entrypoint does the same four things:
//
//  1. read the chain context from the SDK
//  2. parse pipe-delimited arguments
//  3. call one function in contract-template/state
//  4. abort on failure, or return a message
//
// No arithmetic, no policy, and no state layout lives here. All of that is in
// state/, which is pure Go and unit-tested natively — the SDK's //go:wasmimport
// declarations make anything importing it impossible to `go test`.
//
// Build:
//
//	docker run --rm -v "$PWD":/src -w /src tinygo/tinygo:0.39.0 \
//	  tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
//	  -target=wasm-unknown -o artifacts/main.wasm ./app
//
// Constraints inside a contract: no goroutines, no channels, no defer, and
// panic() cannot be recovered.
package main

import (
	_ "contract-template/runtime" // supplies alloc/free for -gc=custom
	"contract-template/sdk"
	"contract-template/state"

	"github.com/lassecash/engine"
)

func main() {}

// --- plumbing -------------------------------------------------------------

// store implements state.Store over the SDK's contract database.
type store struct{}

func (store) Get(key string) *string { return sdk.StateGetObject(key) }
func (store) Set(key, value string)  { sdk.StateSetObject(key, value) }
func (store) Delete(key string)      { sdk.StateDeleteObject(key) }

// ctx builds the operation context from the chain environment.
//
// Height is the Hive block height (3s granularity); MAGI blocks land on every
// 10th height. Epoch is the calendar month, parsed here so that state/ stays
// clock-free and testable.
func ctx() (state.Ctx, sdk.Env) {
	env := sdk.GetEnv()
	return state.Ctx{
		Sender: env.Sender.Address.String(),
		Height: env.BlockHeight,
		Epoch:  monthEpoch(env.Timestamp),
	}, env
}

// monthEpoch converts an ISO timestamp ("2026-08-20T13:02:24") into a
// monotonic month index, so "the 1st of the month" is a real calendar boundary
// rather than a drifting 30-day cycle.
//
// Returns 0 for an unparseable timestamp, which every caller treats as "not a
// new month" — failing closed rather than minting on a bad clock reading.
func monthEpoch(ts string) uint64 {
	if len(ts) < 7 {
		return 0
	}
	year, okY := atoiN(ts[0:4])
	month, okM := atoiN(ts[5:7])
	if !okY || !okM || month < 1 || month > 12 {
		return 0
	}
	return year*12 + month
}

// atoiN parses a small unsigned decimal without pulling in strconv's error
// machinery. Rejects any non-digit rather than silently reading a prefix.
func atoiN(s string) (uint64, bool) {
	if len(s) == 0 {
		return 0, false
	}
	var v uint64
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		v = v*10 + uint64(c-'0')
	}
	return v, true
}

// finish converts a Result into an entrypoint return, aborting on failure so
// the whole transaction reverts. A failed operation must never commit a partial
// state change.
func finish(r state.Result) *string {
	if !r.OK {
		sdk.Abort(r.Msg)
	}
	msg := r.Msg
	return &msg
}

// requireOwner aborts unless the caller owns the contract. Used for the two
// genesis-only operations.
func requireOwner(env sdk.Env) {
	if env.Sender.Address.String() != env.ContractOwner {
		sdk.Abort("owner only")
	}
}

// --- genesis --------------------------------------------------------------

// init_ configures the genesis height. Owner only, once ever.
//
//	args: <genesisHeight>
//
//go:wasmexport init
func Init(a *string) *string {
	_, env := ctx()
	requireOwner(env)
	args := state.ParseArgs(*a)
	h, ok := args.U64(0)
	if !ok {
		sdk.Abort("usage: <genesisHeight>")
	}
	return finish(state.Init(store{}, h))
}

// set_snapshot commits the Merkle root of the migration tree, the total of
// all claimable leaves, and the burn total (credited to hive:null here).
// Owner only, genesis phase, once. Claim-based migration — see state/claim.go.
//
//	args: <rootHex>|<qualifierTotal>|<burnTotal>
//
//go:wasmexport set_snapshot
func SetSnapshot(a *string) *string {
	_, env := ctx()
	requireOwner(env)
	args := state.ParseArgs(*a)
	total, okT := args.Amount(1)
	burnT, okB := args.Amount(2)
	if args.Str(0) == "" || !okT || !okB {
		sdk.Abort("usage: <rootHex>|<qualifierTotal>|<burnTotal>")
	}
	return finish(state.SetSnapshot(store{}, args.Str(0), total, burnT))
}

// claim_migration collects the caller's snapshot position with a Merkle
// proof. Anyone in the tree, paying their own RC. Before day 30 the staked
// part becomes the 30-day migration mint; after, it pays out on the mint's
// own grace/bleed curve; after day 150 the window is closed.
//
//	args: <liquid>|<staked>|<proofHex,proofHex,…>
//
//go:wasmexport claim_migration
func ClaimMigration(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	liquid, okL := args.Amount(0)
	staked, okS := args.Amount(1)
	if !okL || !okS {
		sdk.Abort("usage: <liquid>|<staked>|<proofHex,…>")
	}
	return finish(state.ClaimMigration(store{}, c, liquid, staked, state.ParseProof(args.Str(2))))
}

// record_burn writes the permanent receipt for a burned leaf. Permissionless,
// moves nothing — the tree already proves it; this puts it in state.
//
//	args: <account>|<liquid>|<staked>|<proofHex,…>
//
//go:wasmexport record_burn
func RecordBurn(a *string) *string {
	args := state.ParseArgs(*a)
	liquid, okL := args.Amount(1)
	staked, okS := args.Amount(2)
	if args.Str(0) == "" || !okL || !okS {
		sdk.Abort("usage: <account>|<liquid>|<staked>|<proofHex,…>")
	}
	return finish(state.RecordBurn(store{}, args.Str(0), liquid, staked, state.ParseProof(args.Str(3))))
}

// sweep_unclaimed recycles whatever was committed but never claimed into the
// L-Share reward pool once the claim window has closed. Permissionless, once.
//
//go:wasmexport sweep_unclaimed
func SweepUnclaimed(_ *string) *string {
	c, _ := ctx()
	return finish(state.SweepUnclaimed(store{}, c))
}

// --- ledger ---------------------------------------------------------------

// transfer moves liquid LASSECASH.
//
//	args: <to>|<amount>
//
//go:wasmexport transfer
func Transfer(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	to := args.Str(0)
	amount, ok := args.Amount(1)
	if to == "" || !ok {
		sdk.Abort("usage: <to>|<amount>")
	}
	return finish(state.Transfer(store{}, c, to, amount))
}

// burn permanently destroys the caller's liquid balance.
//
//	args: <amount>
//
//go:wasmexport burn
func Burn(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	amount, ok := args.Amount(0)
	if !ok {
		sdk.Abort("usage: <amount>")
	}
	return finish(state.Burn(store{}, c, amount))
}

// settle credits block rewards up to the current height. Permissionless: an
// idle chain must not be able to fall behind.
//
//go:wasmexport settle
func Settle(a *string) *string {
	c, _ := ctx()
	return finish(state.Settle(store{}, c))
}

// advance walks the L-Share yield accumulator forward.
//
// PERMISSIONLESS AND PAYS THE CALLER NOTHING. Every ordinary transaction
// advances the accumulator as a side effect, so on a live chain this is never
// needed. It exists for the one case that would otherwise be a dead end: the
// walk is capped per call (state.MaxAccrualDays), so after a long silence a
// claim can find the accumulator still behind its mint's maturity day, and
// somebody has to be able to close that gap.
//
// It is idempotent and safe to call repeatedly; a caller with a stubborn gap
// simply calls it again. It carries no reward deliberately — a bounty here
// would create an incentive to keep the chain quiet.
//
//	args: [maxDays]  (optional; how many days to walk this call)
//
// The cap argument exists because gas charges against rc_limit and a
// maximum-length walk costs ~58,000 RC — no meter can pay it in one call.
// Walking 50 days (~2,500 RC) at a time closes any gap affordably.
//
//go:wasmexport advance
func Advance(a *string) *string {
	c, _ := ctx()
	days := 0 // 0 = the full in-contract cap
	if v, ok := state.ParseArgs(*a).I64(0); ok && v > 0 {
		days = int(v)
	}
	if state.AccrueSteps(store{}, c.Height, days) {
		return finish(state.OK("accrual is current"))
	}
	return finish(state.OK("advanced; still behind, call again"))
}

// --- minting --------------------------------------------------------------

// mint locks liquid LASSECASH into a time-lock position.
//
//	args: <amount>|<days>
//
//go:wasmexport mint
func Mint(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	amount, okA := args.Amount(0)
	days, okD := args.I64(1)
	if !okA || !okD {
		sdk.Abort("usage: <amount>|<days 1..1095>")
	}
	_, r := state.CreateMint(store{}, c, amount, days)
	return finish(r)
}

// claim_mint closes a position. The engine decides from the height whether this
// is an early end (slashed principal, forfeited yield) or a mature claim, so a
// caller cannot choose the more favourable path.
//
//	args: <mintId>
//
//go:wasmexport claim_mint
func ClaimMint(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	id, ok := args.U64(0)
	if !ok {
		sdk.Abort("usage: <mintId>")
	}
	return finish(state.ClaimMint(store{}, c, id))
}

// sweep_mint closes a position the post-maturity bleed has fully consumed,
// recycling its stranded value into the reward pool and releasing its
// governance shares. Permissionless — the settlement must show the owner is
// owed exactly zero, so nothing can ever be taken from anyone — and it pays
// the caller nothing.
//
//	args: <owner>|<mintId>
//
//go:wasmexport sweep_mint
func SweepMint(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	owner := args.Str(0)
	id, ok := args.U64(1)
	if owner == "" || !ok {
		sdk.Abort("usage: <owner>|<mintId>")
	}
	return finish(state.SweepMint(store{}, c, owner, id))
}

// good_accounting arms tax deferral. Only in the 30 days before maturity.
//
//	args: <mintId>
//
//go:wasmexport good_accounting
func GoodAccounting(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	id, ok := args.U64(0)
	if !ok {
		sdk.Abort("usage: <mintId>")
	}
	return finish(state.ArmGoodAccounting(store{}, c, id))
}

// set_duration records the mint length used for the monthly Proof-of-Brain
// mint. Sliding scale, 1..1095 days.
//
//	args: <days>
//
//go:wasmexport set_duration
func SetDuration(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	days, ok := args.I64(0)
	if !ok {
		sdk.Abort("usage: <days 1..1095>")
	}
	return finish(state.SetMintDuration(store{}, c, days))
}

// settle_pending converts an account's accrued Proof-of-Brain rewards into its
// monthly mint. Permissionless and lazy — a global sweep over every account
// would not fit in the gas budget, and MAGI has no cron.
//
//	args: [account]   (defaults to the caller)
//
//go:wasmexport settle_pending
func SettlePending(a *string) *string {
	c, _ := ctx()
	account := state.ParseArgs(*a).Str(0)
	if account == "" {
		account = c.Sender
	}
	return finish(state.SettlePending(store{}, c, account))
}

// --- governance -----------------------------------------------------------

// promote offers an account for a consensus leaderboard seat. Permissionless:
// the board can only ever wrongly exclude, and anyone may correct that.
//
//	args: [account]   (defaults to the caller)
//
//go:wasmexport promote
func Promote(a *string) *string {
	c, _ := ctx()
	account := state.ParseArgs(*a).Str(0)
	if account == "" {
		account = c.Sender
	}
	return finish(state.Promote(store{}, account))
}

// set_param records a consensus member's standing preference. There are no
// proposals: the median of the top 10's preferences is simply the value in
// force, continuously.
//
//	args: <paramKey>|<value>
//
//go:wasmexport set_param
func SetParam(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	key := args.Str(0)
	value, ok := args.I64(1)
	if key == "" || !ok {
		sdk.Abort("usage: <paramKey>|<value>")
	}
	return finish(state.SetPreference(store{}, c, key, value))
}

// --- LasseMedia -----------------------------------------------------------

// post publishes content. window: 0 = viral (7 day), 1 = deep (30 day).
//
// payoutMode is the AUTHOR's choice for their own reward and is optional
// (absent = 0): 0 = 20% liquid / 80% monthly mint, 1 = 100% to the mint,
// 2 = burn. Curators are never bound by it.
//
//	args: <permlink>|<window>|[payoutMode]
//
//go:wasmexport post
func Post(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	permlink := args.Str(0)
	w, ok := args.U64(1)
	if permlink == "" || !ok || w > 1 {
		sdk.Abort("usage: <permlink>|<window 0=viral 1=deep>|[payoutMode]")
	}
	mode, _ := args.U64(2) // absent = 0 = default split
	if mode > 2 {
		sdk.Abort("payoutMode must be 0 (split), 1 (power up) or 2 (burn)")
	}
	return finish(state.CreatePost(store{}, c, permlink, window(w), state.PayoutMode(mode)))
}

// comment registers a reply to a registered post. Viral economics (7 days,
// viral pool), gated by the separate comment threshold.
//
//	args: <permlink>|<parentAuthor>|<parentPermlink>|[payoutMode]
//
//go:wasmexport comment
func Comment(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	permlink, pa, pp := args.Str(0), args.Str(1), args.Str(2)
	if permlink == "" || pa == "" || pp == "" {
		sdk.Abort("usage: <permlink>|<parentAuthor>|<parentPermlink>|[payoutMode]")
	}
	mode, _ := args.U64(3)
	return finish(state.CreateComment(store{}, c, permlink, state.PayoutMode(mode), pa, pp))
}

// vote casts a weighted vote. weight is 1..100 percent.
//
//	args: <author>|<permlink>|<weightPct>
//
//go:wasmexport vote
func Vote(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	author := args.Str(0)
	permlink := args.Str(1)
	weight, ok := args.I64(2)
	if author == "" || permlink == "" || !ok {
		sdk.Abort("usage: <author>|<permlink>|<weightPct 1..100>")
	}
	return finish(state.Vote(store{}, c, author, permlink, weight))
}

// payout settles a post once its window closes and pays the author.
// Permissionless, so an absent author cannot strand their curators' rewards.
//
//	args: <author>|<permlink>
//
//go:wasmexport payout
func Payout(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	author := args.Str(0)
	permlink := args.Str(1)
	if author == "" || permlink == "" {
		sdk.Abort("usage: <author>|<permlink>")
	}
	return finish(state.Payout(store{}, c, author, permlink))
}

// claim_curation collects one curator's share of an already-paid-out post.
//
// O(1) per curator — nobody pays gas for another post's popularity — and
// PERMISSIONLESS: the optional third argument names the curator, and the reward
// always goes to them, never to the caller. Splitting the claim is a gas
// necessity, so it must not become a way to lose rewards by forgetting.
//
//	args: <author>|<permlink>|[curator]
//
//go:wasmexport claim_curation
func ClaimCuration(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	author := args.Str(0)
	permlink := args.Str(1)
	if author == "" || permlink == "" {
		sdk.Abort("usage: <author>|<permlink>|[curator]")
	}
	return finish(state.ClaimCuration(store{}, c, author, permlink, args.Str(2)))
}

// sweep_curation recycles a settled post's unclaimed curator pot into the
// L-Share reward pool, one year after it paid out.
//
// Permissionless and pays the caller NOTHING — a bounty would create an
// incentive to argue for a shorter expiry, and this must only ever touch
// genuinely abandoned rewards.
//
//	args: <author>|<permlink>
//
//go:wasmexport sweep_curation
func SweepCuration(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	author := args.Str(0)
	permlink := args.Str(1)
	if author == "" || permlink == "" {
		sdk.Abort("usage: <author>|<permlink>")
	}
	return finish(state.SweepCuration(store{}, c, author, permlink))
}

func window(w uint64) engine.Window {
	if w == 1 {
		return engine.Deep
	}
	return engine.Viral
}

// --- LASSECASH:HBD pool ---------------------------------------------------

// assets moves real HBD through the SDK.
//
// LASSECASH lives in contract state, but HBD is a genuine Magi asset — `hbd` is
// one of the four the SDK understands. So one side of this pool is real
// custodied value and the other is our own ledger.
type assets struct{}

// Draw pulls HBD from the caller into the contract.
//
// sdk.HiveDraw aborts the transaction on failure rather than returning an
// error, so reaching the return means it succeeded.
func (assets) Draw(amount int64) bool {
	if amount <= 0 {
		return false
	}
	sdk.HiveDraw(amount, sdk.AssetHbd)
	return true
}

// Transfer sends HBD from the contract to an address.
func (assets) Transfer(to string, amount int64) bool {
	if amount <= 0 || to == "" {
		return false
	}
	sdk.HiveTransfer(sdk.Address(to), amount, sdk.AssetHbd)
	return true
}

// add_liquidity deposits into the pool and opens a tranche.
//
// maxHbd is the most HBD the caller will supply; only what the ratio requires
// is actually drawn. On the very first deposit it sets the opening price.
//
//	args: <lcAmount>|<maxHbd>
//
//go:wasmexport add_liquidity
func AddLiquidity(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	lcIn, okLC := args.Amount(0)
	maxHbd, okHbd := args.Amount(1)
	if !okLC || !okHbd {
		sdk.Abort("usage: <lcAmount>|<maxHbd>")
	}
	_, r := state.AddLiquidity(store{}, assets{}, c, lcIn, maxHbd)
	return finish(r)
}

// remove_liquidity closes one tranche, returning both sides plus any accrued
// rewards. Tranches are exited by id — nothing is consumed oldest-first behind
// the user's back, so a partial exit cannot destroy their matured loyalty.
//
//	args: <trancheId>
//
//go:wasmexport remove_liquidity
func RemoveLiquidity(a *string) *string {
	c, _ := ctx()
	id, ok := state.ParseArgs(*a).U64(0)
	if !ok {
		sdk.Abort("usage: <trancheId>")
	}
	return finish(state.RemoveLiquidity(store{}, assets{}, c, id))
}

// claim_pool collects a tranche's share of the liquidity reward pool, weighted
// by its loyalty multiplier (1.00x fresh, up to 1.90x at 90 days).
//
//	args: <trancheId>
//
//go:wasmexport claim_pool
func ClaimPool(a *string) *string {
	c, _ := ctx()
	id, ok := state.ParseArgs(*a).U64(0)
	if !ok {
		sdk.Abort("usage: <trancheId>")
	}
	return finish(state.ClaimPoolRewards(store{}, c, id))
}

// swap_lc_hbd sells LASSECASH for HBD.
//
// minOut is slippage protection: the caller states the worst price they accept,
// so a trade cannot be sandwiched into a far worse rate than they were shown.
//
//	args: <lcIn>|<minHbdOut>
//
//go:wasmexport swap_lc_hbd
func SwapLCForHBD(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	in, okIn := args.Amount(0)
	minOut, okMin := args.Amount(1)
	if !okIn || !okMin {
		sdk.Abort("usage: <lcIn>|<minHbdOut>")
	}
	return finish(state.SwapLCForHBD(store{}, assets{}, c, in, minOut))
}

// swap_hbd_lc buys LASSECASH with HBD.
//
//	args: <hbdIn>|<minLcOut>
//
//go:wasmexport swap_hbd_lc
func SwapHBDForLC(a *string) *string {
	c, _ := ctx()
	args := state.ParseArgs(*a)
	in, okIn := args.Amount(0)
	minOut, okMin := args.Amount(1)
	if !okIn || !okMin {
		sdk.Abort("usage: <hbdIn>|<minLcOut>")
	}
	return finish(state.SwapHBDForLC(store{}, assets{}, c, in, minOut))
}

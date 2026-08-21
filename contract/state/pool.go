package state

import (
	"strconv"
	"strings"

	"github.com/lassecash/engine"
)

// The LASSECASH:HBD pool, held inside this contract.
//
// LASSECASH lives in contract state; HBD is a REAL asset the contract custodies
// through the SDK. That asymmetry is why liquidity operations take an Assets
// mover — state/ must not import sdk (see store.go), so the HBD side is passed
// in as an interface and mocked in tests.

// Assets moves real HBD in and out of the contract.
//
// Draw pulls from the caller into the contract; Transfer sends from the
// contract to an address. Both return false on failure, and a false return MUST
// abort the operation — a half-completed liquidity add would mint pool shares
// against HBD that never arrived.
type Assets interface {
	Draw(amount int64) bool
	Transfer(to string, amount int64) bool
}

// MemAssets is an in-memory Assets for tests and the simulator.
type MemAssets struct {
	Held    int64
	Wallets map[string]int64
	Fail    bool // force failures, to test the abort paths
}

func NewMemAssets() *MemAssets { return &MemAssets{Wallets: map[string]int64{}} }

func (a *MemAssets) Draw(amount int64) bool {
	if a.Fail || amount <= 0 {
		return false
	}
	a.Held += amount
	return true
}

func (a *MemAssets) Transfer(to string, amount int64) bool {
	if a.Fail || amount <= 0 || amount > a.Held {
		return false
	}
	a.Held -= amount
	a.Wallets[to] += amount
	return true
}

// --- pool state -----------------------------------------------------------

const (
	keyPoolLC     = "amm_lc"     // LASSECASH reserve
	keyPoolHBD    = "amm_hbd"    // HBD reserve (backed by real custodied HBD)
	keyPoolShares = "amm_shares" // total LP shares outstanding
	keyPoolWeight = "amm_weight" // total loyalty-weighted shares, for rewards
	// LP reward accumulator (2026-08-21): cumulative reward per weight unit,
	// the remainder held while no weight exists, and the pool_liq balance
	// last folded in — so a tranche earns ONLY what arrived while it was in
	// the pool. Same design as the L-Share accumulator; see accrual.go.
	keyPoolAcc     = "amm_acc"
	keyPoolAccHeld = "amm_accheld"
	keyPoolAccSeen = "amm_accseen"
)

func lpSeqKey(account string) string { return "lpseq_" + account }

func lpKey(account string, id uint64) string {
	return "lp_" + account + "_" + strconv.FormatUint(id, 10)
}

// Tranche is one liquidity position.
//
// Each deposit creates its own tranche so that loyalty is tracked per-deposit,
// exactly as the spec requires: "each time a person provides liquidity, a new
// tranche is created — meaning different tranches can have different maturity
// lengths".
type Tranche struct {
	Owner       string
	Shares      engine.Shares
	StartHeight uint64
	// Weight is the loyalty-weighted share count currently counted in the
	// global total. Refreshed whenever the tranche is touched.
	Weight engine.Shares
	Closed bool
	// AccStart is the LP accumulator reading when this tranche's weight was
	// last registered (on deposit and on every claim). Its rewards are the
	// accumulator's RISE since then, times its weight.
	AccStart int64
}

// Field order is frozen, append-only: shares | start | weight | closed | accStart
func encodeTranche(t Tranche) string {
	return encI64(int64(t.Shares)) + sep +
		encU64(t.StartHeight) + sep +
		encI64(int64(t.Weight)) + sep +
		encBool(t.Closed) + sep +
		encI64(t.AccStart)
}

func decodeTranche(owner, raw string) (Tranche, bool) {
	f := strings.Split(raw, sep)
	if len(f) < 4 {
		return Tranche{}, false
	}
	tr := Tranche{
		Owner:       owner,
		Shares:      engine.Shares(decI64(f[0])),
		StartHeight: decU64(f[1]),
		Weight:      engine.Shares(decI64(f[2])),
		Closed:      decBool(f[3]),
	}
	if len(f) > 4 {
		tr.AccStart = decI64(f[4])
	}
	return tr, true
}

// syncPoolAccumulator folds any reward that reached the liquidity pool since
// the last sync into the accumulator, across the weight that was registered
// at the time. Called before every deposit, claim and withdrawal, so the
// inflow is always attributed to the weight that was actually there to earn
// it — a tranche added afterwards starts from today's reading and can never
// claim a share of it. (Before this, rewards were split at claim time by
// current weight: the "claim last wins" bug fixed for L-Shares earlier the
// same day.)
func syncPoolAccumulator(s Store) int64 {
	pool := getAmount(s, keyPoolLiquidity)
	seen := getAmount(s, keyPoolAccSeen)
	acc := int64(getU64(s, keyPoolAcc))
	if pool > seen {
		held := getAmount(s, keyPoolAccHeld)
		acc, held = engine.AccumulatorStep(acc, pool-seen, held, getShares(s, keyPoolWeight))
		setU64(s, keyPoolAcc, uint64(acc))
		setAmount(s, keyPoolAccHeld, held)
	}
	setAmount(s, keyPoolAccSeen, pool)
	return acc
}

// GetTranche loads one liquidity position.
func GetTranche(s Store, account string, id uint64) (Tranche, bool) {
	raw := get(s, lpKey(account, id))
	if raw == nil {
		return Tranche{}, false
	}
	return decodeTranche(account, *raw)
}

func putTranche(s Store, id uint64, t Tranche) { s.Set(lpKey(t.Owner, id), encodeTranche(t)) }

// PoolReserves returns the pool's LASSECASH and HBD reserves.
func PoolReserves(s Store) (engine.Amount, engine.Amount) {
	return getAmount(s, keyPoolLC), getAmount(s, keyPoolHBD)
}

// PoolShares returns the total LP shares outstanding.
func PoolShares(s Store) engine.Shares { return getShares(s, keyPoolShares) }

// --- liquidity ------------------------------------------------------------

// AddLiquidity deposits into the pool and opens a new tranche.
//
// The first provider sets the price and may deposit any ratio. Every later
// provider must match the pool's current ratio, so a deposit cannot shift the
// price — otherwise every add would be a free arbitrage.
func AddLiquidity(s Store, a Assets, ctx Ctx, lcIn engine.Amount, maxHbd engine.Amount) (uint64, Result) {
	if !IsInit(s) {
		return 0, fail("not initialised")
	}
	if lcIn <= 0 {
		return 0, fail("amount must be positive")
	}
	if Balance(s, ctx.Sender) < lcIn {
		return 0, fail("insufficient LASSECASH")
	}

	lcRes, hbdRes := PoolReserves(s)
	total := PoolShares(s)

	var hbdIn engine.Amount
	if total <= 0 || lcRes <= 0 || hbdRes <= 0 {
		// First deposit: the caller's HBD sets the opening price.
		if maxHbd <= 0 {
			return 0, fail("first deposit must supply HBD to set the price")
		}
		hbdIn = maxHbd
	} else {
		need, okNeed := engine.HbdRequiredFor(lcIn, lcRes, hbdRes)
		if !okNeed {
			return 0, fail("cannot price deposit")
		}
		if need > maxHbd {
			return 0, fail("needs " + encI64(int64(need)) + " HBD, above the limit given")
		}
		hbdIn = need
	}

	shares, okShares := engine.LPSharesFor(lcIn, lcRes, total)
	if !okShares || shares <= 0 {
		return 0, fail("deposit too small to earn shares")
	}

	// Take the real HBD first. If this fails nothing else has happened yet.
	if !a.Draw(int64(hbdIn)) {
		return 0, fail("HBD transfer failed")
	}
	if !debit(s, ctx.Sender, lcIn) {
		return 0, fail("insufficient LASSECASH")
	}

	setAmount(s, keyPoolLC, lcRes+lcIn)
	setAmount(s, keyPoolHBD, hbdRes+hbdIn)
	setShares(s, keyPoolShares, total+shares)

	// Fold in everything earned so far BEFORE this weight joins, so the new
	// tranche starts from today's accumulator reading and owns none of it.
	Settle(s, ctx)
	acc := syncPoolAccumulator(s)

	// A new tranche starts at 1.00x and earns loyalty as it ages.
	weight := engine.TrancheWeight(shares, 0)
	setShares(s, keyPoolWeight, getShares(s, keyPoolWeight)+weight)

	id := getU64(s, lpSeqKey(ctx.Sender)) + 1
	setU64(s, lpSeqKey(ctx.Sender), id)
	putTranche(s, id, Tranche{
		Owner: ctx.Sender, Shares: shares, StartHeight: ctx.Height, Weight: weight,
		AccStart: acc,
	})

	return id, ok("added " + encI64(int64(lcIn)) + " LC and " + encI64(int64(hbdIn)) + " HBD")
}

// RemoveLiquidity closes a tranche, paying out its proportional share of both
// reserves plus any accrued rewards.
//
// Tranches are exited individually by id — exactly like mints. Nothing is
// consumed oldest-first behind the user's back, so a partial exit can never
// silently destroy their most-matured loyalty position.
func RemoveLiquidity(s Store, a Assets, ctx Ctx, id uint64) Result {
	t, found := GetTranche(s, ctx.Sender, id)
	if !found {
		return fail("no such tranche")
	}
	if t.Closed {
		return fail("tranche already closed")
	}

	// Pay out whatever rewards it earned before dissolving it.
	ClaimPoolRewards(s, ctx, id)
	t, _ = GetTranche(s, ctx.Sender, id)

	lcRes, hbdRes := PoolReserves(s)
	total := PoolShares(s)
	lcOut, hbdOut, okAmt := engine.WithdrawAmounts(t.Shares, total, lcRes, hbdRes)
	if !okAmt {
		return fail("cannot compute withdrawal")
	}

	if hbdOut > 0 && !a.Transfer(ctx.Sender, int64(hbdOut)) {
		return fail("HBD transfer failed")
	}

	setAmount(s, keyPoolLC, lcRes-lcOut)
	setAmount(s, keyPoolHBD, hbdRes-hbdOut)
	setShares(s, keyPoolShares, total-t.Shares)
	setShares(s, keyPoolWeight, getShares(s, keyPoolWeight)-t.Weight)

	if !credit(s, ctx.Sender, lcOut) {
		return fail("credit failed")
	}

	t.Closed = true
	t.Weight = 0
	putTranche(s, id, t)

	return ok("withdrew " + encI64(int64(lcOut)) + " LC and " + encI64(int64(hbdOut)) + " HBD")
}

// --- rewards --------------------------------------------------------------

// PoolRewardsOwed is the READ-ONLY view of what ClaimPoolRewards would pay a
// tranche right now: the accumulator as it would read after folding in the
// inflow since the last sync, without writing anything. For dashboards.
func PoolRewardsOwed(s Store, t Tranche) engine.Amount {
	if t.Closed || t.Weight <= 0 {
		return 0
	}
	pool := getAmount(s, keyPoolLiquidity)
	seen := getAmount(s, keyPoolAccSeen)
	acc := int64(getU64(s, keyPoolAcc))
	if pool > seen {
		acc, _ = engine.AccumulatorStep(acc, pool-seen, getAmount(s, keyPoolAccHeld), getShares(s, keyPoolWeight))
	}
	owed := engine.Entitlement(t.Weight, t.AccStart, acc)
	if owed > pool {
		owed = pool
	}
	return owed
}

// ClaimPoolRewards pays a tranche the rewards that arrived while its weight
// was registered, then re-registers it at its current loyalty age.
//
//	owed = weight * (acc_now - acc_at_last_registration) / AccScale
//
// Re-registering is what applies the loyalty bonus: an untouched tranche keeps
// its old (lower) weight and under-earns rather than over-earns; a claim
// brings the weight up to date for the future. Conserves exactly.
func ClaimPoolRewards(s Store, ctx Ctx, id uint64) Result {
	t, found := GetTranche(s, ctx.Sender, id)
	if !found || t.Closed {
		return fail("no open tranche")
	}

	Settle(s, ctx)
	acc := syncPoolAccumulator(s)

	owed := engine.Entitlement(t.Weight, t.AccStart, acc)
	pool := getAmount(s, keyPoolLiquidity)
	if owed > pool {
		owed = pool // never overdraw; flooring should make this unreachable
	}

	// Re-register at the current age. The weight change applies to FUTURE
	// inflow only — the accumulator reading is stamped now.
	newWeight := engine.TrancheWeight(t.Shares, engine.AgeDays(t.StartHeight, ctx.Height))
	setShares(s, keyPoolWeight, getShares(s, keyPoolWeight)-t.Weight+newWeight)
	t.Weight = newWeight
	t.AccStart = acc
	putTranche(s, id, t)

	if owed <= 0 {
		return ok("nothing to claim")
	}
	setAmount(s, keyPoolLiquidity, pool-owed)
	// The pool shrank by a payout, not grew by an inflow: keep the sync
	// watermark in step so the next sync does not read the drop as nothing
	// and the following inflow correctly.
	setAmount(s, keyPoolAccSeen, pool-owed)
	if !credit(s, ctx.Sender, owed) {
		return fail("credit failed")
	}
	return ok("claimed " + encI64(int64(owed)))
}

func SwapLCForHBD(s Store, a Assets, ctx Ctx, lcIn engine.Amount, minOut engine.Amount) Result {
	if lcIn <= 0 {
		return fail("amount must be positive")
	}
	if Balance(s, ctx.Sender) < lcIn {
		return fail("insufficient LASSECASH")
	}
	lcRes, hbdRes := PoolReserves(s)
	out, okSwap := engine.SwapOut(lcRes, hbdRes, lcIn)
	if !okSwap {
		return fail("swap not possible at this size")
	}
	// Slippage protection: the caller states the worst price they accept, so a
	// trade cannot be sandwiched into a far worse rate than they saw.
	if out < minOut {
		return fail("output " + encI64(int64(out)) + " below the minimum required")
	}
	if !debit(s, ctx.Sender, lcIn) {
		return fail("insufficient LASSECASH")
	}
	if !a.Transfer(ctx.Sender, int64(out)) {
		credit(s, ctx.Sender, lcIn)
		return fail("HBD transfer failed")
	}
	setAmount(s, keyPoolLC, lcRes+lcIn)
	setAmount(s, keyPoolHBD, hbdRes-out)
	return ok("swapped for " + encI64(int64(out)) + " HBD")
}

// SwapHBDForLC buys LASSECASH from the pool with HBD.
func SwapHBDForLC(s Store, a Assets, ctx Ctx, hbdIn engine.Amount, minOut engine.Amount) Result {
	if hbdIn <= 0 {
		return fail("amount must be positive")
	}
	lcRes, hbdRes := PoolReserves(s)
	out, okSwap := engine.SwapOut(hbdRes, lcRes, hbdIn)
	if !okSwap {
		return fail("swap not possible at this size")
	}
	if out < minOut {
		return fail("output " + encI64(int64(out)) + " below the minimum required")
	}
	if !a.Draw(int64(hbdIn)) {
		return fail("HBD transfer failed")
	}
	setAmount(s, keyPoolHBD, hbdRes+hbdIn)
	setAmount(s, keyPoolLC, lcRes-out)
	if !credit(s, ctx.Sender, out) {
		return fail("credit failed")
	}
	return ok("swapped for " + encI64(int64(out)) + " LASSECASH")
}

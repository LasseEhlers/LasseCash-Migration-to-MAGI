package state

import "github.com/lassecash/engine"

// LasseMint: creating, ending and claiming time-lock positions.
//
// Manual capital minting is immediate and direct — unlike Proof-of-Brain
// payouts, every mint here costs the caller a signed transaction and RC, which
// is a natural brake on volume. See CLAUDE.md.

// MinDurationDays / MaxDurationDays mirror the engine's immutable bounds and
// are re-checked here so a malformed argument is refused at the boundary rather
// than silently clamped deeper in.
const (
	MinDurationDays = engine.MinMintDays
	MaxDurationDays = engine.MaxMintDays
)

// GetMint loads one mint.
func GetMint(s Store, account string, id uint64) (engine.Mint, bool) {
	raw := get(s, mintKey(account, id))
	if raw == nil {
		return engine.Mint{}, false
	}
	return decodeMint(account, *raw)
}

func putMint(s Store, id uint64, m engine.Mint) {
	s.Set(mintKey(m.Owner, id), encodeMint(m))
}

// SharesOf returns an account's live L-Shares — its voting weight and its claim
// on the yield pool.
//
// Denormalised into its own key rather than summed over the account's mints:
// summing would be unbounded iteration, and voting reads this on every vote.
func SharesOf(s Store, account string) engine.Shares { return getShares(s, sharesKey(account)) }

// TotalShares returns the network-wide L-Share total, the yield denominator.
func TotalShares(s Store) engine.Shares { return getShares(s, keySharesTotal) }

// addShares adjusts an account's live L-Shares and the network total, then
// offers the account to the consensus leaderboard. The offer is O(BoardSize)
// and is what keeps the top 10 current without ever scanning all accounts.
func addShares(s Store, account string, d engine.Shares) {
	setShares(s, sharesKey(account), SharesOf(s, account)+d)
	setShares(s, keySharesTotal, TotalShares(s)+d)
	offer(s, account)
}

// MintDuration returns the mint length an account chose in settings, used for
// the monthly Proof-of-Brain mint. Defaults to the full three years.
func MintDuration(s Store, account string) int64 {
	v := get(s, durationKey(account))
	if v == nil {
		return MaxDurationDays
	}
	d := decI64(*v)
	if d < MinDurationDays {
		return MinDurationDays
	}
	if d > MaxDurationDays {
		return MaxDurationDays
	}
	return d
}

// SetMintDuration records the account's preferred mint length (sliding scale,
// 1..1095 days). Out-of-range values are refused so the user sees the error
// rather than silently getting a different lock than they asked for.
func SetMintDuration(s Store, ctx Ctx, days int64) Result {
	if days < MinDurationDays || days > MaxDurationDays {
		return fail("duration must be 1..1095 days")
	}
	s.Set(durationKey(ctx.Sender), encI64(days))
	return ok("duration set")
}

// --- creating -------------------------------------------------------------

// CreateMint locks liquid LASSECASH into a new time-lock position.
//
// Shares are computed once, here, from the parameters in force at this moment,
// and frozen into the record. No later governance vote or share-rate ratchet
// may recompute them.
func CreateMint(s Store, ctx Ctx, principal engine.Amount, days int64) (uint64, Result) {
	if !IsInit(s) {
		return 0, fail("not initialised")
	}
	if principal < engine.MinMintAmount {
		return 0, fail("below minimum mint amount")
	}
	if days < MinDurationDays || days > MaxDurationDays {
		return 0, fail("duration must be 1..1095 days")
	}
	if Balance(s, ctx.Sender) < principal {
		return 0, fail("insufficient balance")
	}
	// Accrual must be current BEFORE any money moves. The refusal used to sit
	// inside registerMint — after the debit — and a refused mint kept the
	// debit, stranding the principal. Caught by
	// TestMintIsRefusedWhileAccrualIsBehind the moment the refusal existed.
	if !Accrue(s, ctx.Height) {
		return 0, fail("accrual is behind; call advance then mint again")
	}

	params := MintParamsNow(s, ctx)
	m, made := engine.NewMint(ctx.Sender, principal, days, ctx.Height, params)
	if !made || m.Shares <= 0 {
		return 0, fail("mint would yield no shares")
	}
	if !debit(s, ctx.Sender, principal) {
		return 0, fail("insufficient balance")
	}

	id, ready := registerMint(s, ctx, m)
	if !ready {
		return 0, fail("accrual is behind; call advance then mint again")
	}
	return id, ok("minted " + encI64(int64(m.Shares)) + " L-Shares")
}

// registerMint is the ONE way a mint enters state.
//
// Both mint-creating paths — capital mints (CreateMint) and the monthly
// Proof-of-Brain mint (MintPending) — MUST go through here. The accrual
// rewrite made that non-negotiable: a mint registered without an AccStart
// stamp claims the entire accumulator history since genesis, and one whose
// expiry is never scheduled dilutes every live minter forever. Exactly that
// bug shipped in the first WASM, because pob.go had its own copy of this tail;
// caught 2026-08-21 hunting unwired paths before the second test deploy.
func registerMint(s Store, ctx Ctx, m engine.Mint) (uint64, bool) {
	ids, ok := registerMints(s, ctx, []engine.Mint{m})
	if !ok {
		return 0, false
	}
	return ids[0], true
}

// registerMints is the bulk form of registerMint — the same stamping for
// every mint, but the shared writes (active total, the aggregate expiry, the
// per-account expiry chunks) happen once per maturity day rather than once
// per mint. The migration credits thousands of mints onto ONE maturity day;
// measured on the devnet 2026-08-21, doing that one mint at a time was
// superlinear in gas. Economics are identical either way.
func registerMints(s Store, ctx Ctx, mints []engine.Mint) ([]uint64, bool) {
	// Bring accrual current BEFORE stamping, so each mint's starting point is
	// today's accumulator and it cannot claim emission that predates it.
	//
	// REFUSED, not tolerated, when the walk cannot catch up in one bounded
	// call. Measured on-chain (2026-08-21): a 1200-day catch-up inside mint
	// cost 5.85B gas — 200x a normal call, ambushing whichever user happened
	// to transact first after a long silence. And a mint stamped against a
	// stale accumulator joins the share denominator for days that predate it,
	// quietly reopening the late-minter dilution this rewrite exists to close.
	if !Accrue(s, ctx.Height) {
		return nil, false
	}
	acc := AccPerShare(s)

	ids := make([]uint64, len(mints))
	var totalShares engine.Shares
	// Group the per-account expiry entries by maturity day, preserving order.
	days := []uint64{}
	byDay := map[uint64][]int{}
	for i := range mints {
		m := &mints[i]
		m.AccStart = acc
		ids[i] = getU64(s, mintSeqKey(m.Owner)) + 1
		setU64(s, mintSeqKey(m.Owner), ids[i])
		setShares(s, sharesKey(m.Owner), SharesOf(s, m.Owner)+m.Shares)
		offer(s, m.Owner)
		totalShares += m.Shares
		d := DayOf(s, m.MaturityHeight())
		if _, seen := byDay[d]; !seen {
			days = append(days, d)
		}
		byDay[d] = append(byDay[d], i)
	}
	setShares(s, keySharesTotal, TotalShares(s)+totalShares)

	// Maturity is known now, so the stop is scheduled now. Discovering it
	// later would mean scanning every mint, which contract code cannot
	// afford. Two schedules per day: the aggregate (earning denominator) and
	// the per-account list (voting weight — ALL voting power ends at maturity).
	for _, d := range days {
		idx := byDay[d]
		var dayShares engine.Shares
		entries := make([]string, len(idx))
		for j, i := range idx {
			dayShares += mints[i].Shares
			entries[j] = expiryEntry(mints[i].Owner, mints[i].Shares)
		}
		scheduleExpiry(s, d, dayShares)
		chunks := scheduleExpiryEntries(s, d, entries)
		for j, i := range idx {
			mints[i].ExpChunk = chunks[j]
		}
	}
	for i := range mints {
		putMint(s, ids[i], mints[i])
		// The account roll. A stake-only holder never passes through credit at
		// a non-zero amount -- at genesis @daneamanda is 0 liquid and 250,000
		// staked -- so without this hook the roll would silently miss exactly
		// the holders whose whole position is a mint. See ledger.go.
		noteAccount(s, mints[i].Owner)
	}
	return ids, true
}

// MintParamsNow captures the governed parameters and share rate in force now.
//
// These are frozen into the mint at creation. A later governance change moves
// the goalposts only for FUTURE mints — it can never re-weight an existing one.
func MintParamsNow(s Store, ctx Ctx) engine.MintParams {
	return engine.MintParams{
		VolumeStart: engine.Amount(EffectiveParam(s, engine.ParamVolumeStart)),
		VolumeEnd:   engine.Amount(EffectiveParam(s, engine.ParamVolumeEnd)),
		ShareRate:   engine.ShareRate(GenesisHeight(s), ctx.Height),
	}
}

// --- ending ---------------------------------------------------------------

// ClaimMint closes a position and pays the owner.
//
// One entrypoint handles both the early end and the mature claim: the engine
// decides which applies from the height, so there is no way for a caller to
// pick the more favourable path. Before maturity the principal is slashed on a
// linear curve and all yield is forfeited; after maturity the payout is
// principal plus yield, less any post-maturity bleed.
func ClaimMint(s Store, ctx Ctx, id uint64) Result {
	return endMint(s, ctx, ctx.Sender, id, false)
}

// SweepMint closes a position the bleed has FULLY consumed — the owner-payable
// amount must be exactly zero, computed by the same settlement a claim would
// run, so a sweep can never take a base unit from anyone.
//
// Permissionless, and it pays the caller NOTHING — a bounty would create an
// incentive to lobby for shorter grace and bleed periods, and this must only
// ever touch positions that are already worthless to their owner.
//
// Why it must exist (found 2026-08-21, decided by Lasse): claiming is the only
// path that recycles a mint's value and releases its shares. A dead account's
// fully-bled mint would otherwise strand its principal outside the reward pool
// forever AND keep voting with `shr_` governance weight forever — a zombie
// seat nobody could evict after the key burn. Good Accounting's grace is
// finite for exactly this reason; the sweep is the mechanism that completes
// that intent.
func SweepMint(s Store, ctx Ctx, owner string, id uint64) Result {
	return endMint(s, ctx, owner, id, true)
}

// endMint is the ONE way a position closes — ClaimMint and SweepMint both run
// through it, so there is exactly one settlement computation. A separate sweep
// tail would be the same class of bug as the duplicated mint-registration tail
// that let PoB mints skip the accrual rewrite.
func endMint(s Store, ctx Ctx, owner string, id uint64, sweep bool) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	m, found := GetMint(s, owner, id)
	if !found {
		return fail("no such mint")
	}
	if m.Ended {
		return fail("mint already ended")
	}

	// Accrual must be current before the yield is computed, or an idle chain
	// would pay out against a stale accumulator.
	caughtUp := Accrue(s, ctx.Height)

	// The yield is the accumulator's RISE across this mint's life — the
	// emission that arrived while its shares were live, and nothing else.
	// It stops at maturity (Lasse, 2026-08-21): a matured position has served
	// its commitment and must not keep diluting minters who are still locked.
	matured := ctx.Height >= m.MaturityHeight()
	matDay := DayOf(s, m.MaturityHeight())
	// Whether the WALK has already retired these shares is a different question
	// from whether the mint has matured: on the maturity day itself the mint is
	// mature but the day is not yet complete, so the walk has not reached its
	// expiry. Conflating the two either double-subtracts the shares or never
	// subtracts them at all.
	retiredByWalk := AccruedDays(s) > matDay

	accEnd := AccPerShare(s)
	if matured {
		cp, have := AccAtDay(s, matDay)
		if !have {
			// ⚠️ The maturity day has not fully closed — no accAt_<matDay>
			// checkpoint exists yet. This used to fall back to the LIVE
			// accumulator here (which covers only days before matDay), while
			// this claim ALSO pulled the mint's shares out of shares_total
			// immediately — so a prompt claim forfeited its own maturity
			// day's yield, AND that day's remaining emission then divided
			// across a smaller pool for whoever was still active. On a day
			// where thousands of mints share one maturity height (the
			// migration cliff), an unrelated mint that simply did not claim
			// that day could pick up the entire day's L-Share emission.
			// Measured 2026-08-23: 50 x 200,000 LC claiming together handed
			// one unrelated 200 LC mint 100.0% of that day's emission,
			// 11x its own principal, in one day. Found by review, before
			// genesis — fixed here rather than left for the 48h timelock.
			//
			// Refuse instead, with the SAME remedy as the ordinary "behind"
			// case: call advance (or simply wait) until the day closes, then
			// claim. Every claim on a matured mint now reads the SAME
			// checkpoint no matter when within the day it is made — early
			// and late claimers are treated identically.
			return fail("mint matured today; the day has not closed yet — call advance, then claim again")
		}
		accEnd = cp
	}
	_ = caughtUp
	accrued := engine.Entitlement(m.Shares, m.AccStart, accEnd)
	pool := PoolLShare(s)
	if accrued > pool {
		accrued = pool // never overdraw; flooring should make this unreachable
	}

	settlement := m.Settle(ctx.Height, accrued)

	// A sweep may proceed ONLY once the settlement itself says the owner would
	// receive nothing — the bleed has consumed the entire position. Any value
	// at all, and only the owner may end it.
	if sweep && settlement.ToOwner > 0 {
		return fail("mint still holds value; only the owner may end it")
	}

	// Remove the accrued portion from the pool regardless of where it lands:
	// whether the owner receives it or it is recycled, it must leave the pool
	// exactly once.
	if accrued > 0 {
		setAmount(s, keyPoolLShare, pool-accrued)
	}

	m.Ended = true
	putMint(s, id, m)
	// Voting shares (`shr_`) end at maturity, retired by the walk — so a close
	// releases them here ONLY if it beat the walk to it (an early end, or a
	// claim on the maturity day itself). It must then also remove its
	// expiry-list entry, or the walk would retire the same shares again. The
	// cursor check covers the edge where a partial drain of the maturity day
	// already processed this mint's chunk.
	drained := getU64(s, explCursorKey(matDay)) > m.ExpChunk
	if !retiredByWalk && !drained {
		left := SharesOf(s, owner) - m.Shares
		if left < 0 {
			left = 0
		}
		setShares(s, sharesKey(owner), left)
		removeExpiryEntry(s, matDay, m.ExpChunk, owner, m.Shares)
	}
	if !retiredByWalk {
		setShares(s, keySharesTotal, TotalShares(s)-m.Shares)
		unscheduleExpiry(s, matDay, m.Shares)
	}
	offer(s, owner)

	if settlement.ToOwner > 0 && !credit(s, owner, settlement.ToOwner) {
		return fail("credit failed")
	}
	// Slashed principal, forfeited yield, and anything bled all sweep back into
	// the reward pool. This is the recycling engine that funds rewards after
	// emission ends.
	Recycle(s, settlement.ToRewardPool)

	if sweep {
		return ok("swept " + encI64(int64(settlement.ToRewardPool)) + " to the reward pool")
	}
	if settlement.Early {
		return ok("ended early, recovered " + encI64(int64(settlement.ToOwner)))
	}
	return ok("claimed " + encI64(int64(settlement.ToOwner)))
}

// ArmGoodAccounting enables tax-deferral on a mint.
//
// Only during the grace month after maturity, never once the bleed has
// started: a user who could arm it late would watch themselves bleed and
// then retroactively opt out.
func ArmGoodAccounting(s Store, ctx Ctx, id uint64) Result {
	m, found := GetMint(s, ctx.Sender, id)
	if !found {
		return fail("no such mint")
	}
	if !m.CanArmGoodAccounting(ctx.Height) {
		if m.IsMature(ctx.Height) {
			return fail("too late: grace is over and the bleed has started")
		}
		return fail("too early: opens at maturity")
	}
	m.GoodAccounting = true
	putMint(s, id, m)
	return ok("good accounting armed")
}

// PendingYield reports what a mint would currently earn, without settling it.
// Read-only: used by the indexer to show a live figure on the dashboard.
//
// `height` is the real current height, not a day count — needed so this can
// tell "still earning, not yet at the exact maturity height" apart from
// "matured, but today's checkpoint isn't written yet". A day-count-only
// version of this test (the previous implementation) conflated the two: it
// used AccruedDays(s) > DayOf(MaturityHeight) as its only "am I mature"
// signal, which is day-granular and so wrongly zeroed an ACTIVE mint for
// the whole calendar day before its exact maturity height, and — after
// endMint was fixed to refuse a same-day-matured claim (2026-08-23) —
// wrongly showed a live, growing figure for a mint a real claim would
// refuse outright. Found by review 2026-08-24, before genesis.
func PendingYield(s Store, account string, id uint64, height uint64) engine.Amount {
	m, found := GetMint(s, account, id)
	if !found || m.Ended {
		return 0
	}
	// Mirrors endMint exactly: the accumulator's rise across this mint's
	// life, frozen at maturity. A figure that disagreed with what claiming
	// actually pays would be worse than showing nothing.
	accEnd := AccPerShare(s)
	if height >= m.MaturityHeight() {
		matDay := DayOf(s, m.MaturityHeight())
		cp, have := AccAtDay(s, matDay)
		if !have {
			// Matured, but the maturity day has not closed yet: a real claim
			// would be refused (see endMint), not partially paid.
			return 0
		}
		accEnd = cp
	}
	return engine.Entitlement(m.Shares, m.AccStart, accEnd)
}

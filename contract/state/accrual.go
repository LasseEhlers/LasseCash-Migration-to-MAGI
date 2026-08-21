package state

import (
	"strings"

	"github.com/lassecash/engine"
)

// L-Share yield accrual.
//
// Emission arrives continuously, but a mint must be paid only for the emission
// that arrived WHILE ITS SHARES WERE LIVE — not for a year that accrued before
// it existed, and (Lasse, 2026-08-21) not for a day after it matured.
//
// The mechanism is a cumulative reward-per-share accumulator (see
// engine/accumulator.go). Settling a mint is then two reads and a subtraction,
// no matter how long it was locked:
//
//	yield = shares * (acc[maturityDay] - acc[creation]) / AccScale
//
// `acc[maturityDay]` has to be a value someone actually RECORDED at that
// moment, which is what this walk is for. It steps whole days, distributing
// each day's emission across the shares that were active that day, and on any
// day where mints mature it writes the checkpoint and drops those shares out
// of the denominator.
//
// HEX solves the same problem by storing per-day payout figures and looping
// over every day of a stake when it ends — which is why ending a long HEX stake
// is expensive. Storing the running total instead turns that loop into a
// subtraction, which matters here because gas is charged to the caller's RC.

// MaxAccrualDays bounds the walk in a single call.
//
// ⚠️ PLACEHOLDER — MEASURE IT. Like MaxCurationDrain, this was chosen by
// judgement, not measurement. `simulateContractCalls` reports `gas_used`;
// measure a full-length walk against a test deployment and set this as high as
// comfortably fits. Every day it cannot cover is a day someone has to pay for
// in a second transaction.
//
// 1200 is chosen so that a MAXIMUM-LENGTH mint (1095 days) can always be
// claimed in a single transaction even if nothing else ever touched the chain.
// Anything shorter than that would mean a user whose mint matured during a
// quiet stretch is told to go and call `advance` first — technically fine, but
// a confusing thing to hand someone collecting three years of yield.
//
// After the optimisation above an ordinary day costs ONE state read, so the
// walk is far cheaper than its length suggests. It is still the single most
// expensive loop in the contract, and it is still a guess until measured.
//
// In practice the walk is one day or zero: any transaction advances it, and a
// live token is touched constantly. The cap only matters after a long silence.
const MaxAccrualDays = 1200

// DayOf converts a height to whole days since genesis.
func DayOf(s Store, height uint64) uint64 {
	g := GenesisHeight(s)
	if height <= g {
		return 0
	}
	return (height - g) / uint64(engine.HeightsPerDay)
}

// heightOfDay is the first height of a day.
func heightOfDay(s Store, day uint64) uint64 {
	return GenesisHeight(s) + day*uint64(engine.HeightsPerDay)
}

// AccPerShare is the current cumulative reward-per-share.
func AccPerShare(s Store) int64 { return int64(getU64(s, keyAccPerShare)) }

// AccruedDays is how many whole days have been accrued so far.
func AccruedDays(s Store) uint64 { return getU64(s, keyAccDay) }

// scheduleExpiry records that `shares` stop earning at the end of `day`.
func scheduleExpiry(s Store, day uint64, shares engine.Shares) {
	setShares(s, expKey(day), getShares(s, expKey(day))+shares)
}

// ExpiryChunkSize bounds one row of a day's per-account expiry list. Small
// enough that a chunk is one modest read; the migration day (thousands of
// accounts maturing together) simply spans many chunks.
const ExpiryChunkSize = 25

// MaxRetirePerWalk bounds how many per-account share retirements one walk
// call performs. A heavy day (the migration mints all mature together) is
// crossed over several `advance` calls, exactly like a long accrual gap.
// ⚠️ Like MaxAccrualDays, a judgement value — measure with
// simulateContractCalls before the production freeze.
const MaxRetirePerWalk = 200

// scheduleExpiryEntries appends MANY entries for one day, writing each chunk
// ONCE. The per-mint append re-reads and rewrites a growing chunk up to 25
// times; for the migration day (thousands of mints, one maturity day) that
// was measured on the devnet as superlinear gas. Returns each entry's chunk.
func scheduleExpiryEntries(s Store, day uint64, entries []string) []uint64 {
	chunks := make([]uint64, len(entries))
	if len(entries) == 0 {
		return chunks
	}
	count := getU64(s, explCountKey(day))
	i := 0
	// Top up the last existing chunk first.
	if count > 0 {
		last := count - 1
		if raw := get(s, explChunkKey(day, last)); raw != nil {
			have := countEntries(*raw)
			if have < ExpiryChunkSize {
				take := ExpiryChunkSize - have
				if take > len(entries) {
					take = len(entries)
				}
				s.Set(explChunkKey(day, last), *raw+sep+strings.Join(entries[:take], sep))
				for j := 0; j < take; j++ {
					chunks[j] = last
				}
				i = take
			}
		}
	}
	// Then whole new chunks.
	for i < len(entries) {
		end := i + ExpiryChunkSize
		if end > len(entries) {
			end = len(entries)
		}
		s.Set(explChunkKey(day, count), strings.Join(entries[i:end], sep))
		for j := i; j < end; j++ {
			chunks[j] = count
		}
		count++
		i = end
	}
	setU64(s, explCountKey(day), count)
	return chunks
}

func expiryEntry(account string, shares engine.Shares) string {
	return account + "," + encI64(int64(shares))
}

func countEntries(raw string) int {
	if raw == "" {
		return 0
	}
	return strings.Count(raw, sep) + 1
}

// drainExpiryList retires the day's matured shares from each owner's `shr_`
// voting balance — Lasse's rule (2026-08-21): ALL voting power, governance
// and posts alike, ends 100% at maturity. Grace is a claim safety-net, not a
// voting extension, and a dead account can no longer haunt the top-10.
//
// Resumable: `budget` is decremented per entry, and when it runs out the
// cursor is stored so the next walk call continues mid-day. Returns whether
// the day's list is fully drained.
func drainExpiryList(s Store, day uint64, budget *int) bool {
	count := getU64(s, explCountKey(day))
	if count == 0 {
		return true
	}
	cur := getU64(s, explCursorKey(day))
	for cur < count {
		raw := get(s, explChunkKey(day, cur))
		if raw == nil {
			cur++
			continue
		}
		entries := strings.Split(*raw, sep)
		if *budget < len(entries) {
			setU64(s, explCursorKey(day), cur)
			return false
		}
		for _, e := range entries {
			c := strings.LastIndexByte(e, ',')
			if c <= 0 {
				continue // defensive: never wedge the walk on a bad entry
			}
			acct := e[:c]
			left := SharesOf(s, acct) - engine.Shares(decI64(e[c+1:]))
			if left < 0 {
				left = 0 // defensive: a voting balance can never go negative
			}
			setShares(s, sharesKey(acct), left)
		}
		*budget -= len(entries)
		s.Delete(explChunkKey(day, cur))
		cur++
	}
	s.Delete(explCountKey(day))
	s.Delete(explCursorKey(day))
	return true
}

// removeExpiryEntry deletes one account's entry from a day's list, for a mint
// closed before the walk reached its maturity day — the close itself already
// released the shares, and draining the stale entry later would double-retire.
func removeExpiryEntry(s Store, day, chunk uint64, account string, shares engine.Shares) {
	raw := get(s, explChunkKey(day, chunk))
	if raw == nil {
		return
	}
	needle := account + "," + encI64(int64(shares))
	entries := strings.Split(*raw, sep)
	for i, e := range entries {
		if e == needle {
			entries = append(entries[:i], entries[i+1:]...)
			if len(entries) == 0 {
				s.Delete(explChunkKey(day, chunk))
			} else {
				s.Set(explChunkKey(day, chunk), strings.Join(entries, sep))
			}
			return
		}
	}
}

// AccAtDay reads the accumulator checkpoint for the end of a day, if the walk
// has passed it.
func AccAtDay(s Store, day uint64) (int64, bool) {
	if AccruedDays(s) <= day {
		return 0, false // not yet reached; no checkpoint exists
	}
	return int64(getU64(s, accAtKey(day))), true
}

// Accrue advances the walk toward `toHeight`, at most MaxAccrualDays days.
//
// Returns whether it caught up. A caller that needs a historical checkpoint
// must check this rather than assume: after a long silence the accumulator can
// legitimately still be behind, and paying out against a stale accumulator
// would short the claimant.
func Accrue(s Store, toHeight uint64) bool {
	return AccrueSteps(s, toHeight, MaxAccrualDays)
}

// AccrueSteps is Accrue with a caller-chosen per-call cap.
//
// Exists because gas is charged against rc_limit (100,000 gas = 1 RC,
// measured) and a full MaxAccrualDays walk costs ~58,000 RC — far beyond any
// realistic meter. The permissionless `advance` takes the cap as an argument,
// so a caller can close a long gap in affordable slices: fifty days costs
// ~2,500 RC, repeat until current.
func AccrueSteps(s Store, toHeight uint64, maxDays int) bool {
	if maxDays <= 0 || maxDays > MaxAccrualDays {
		maxDays = MaxAccrualDays
	}
	target := DayOf(s, toHeight)
	day := AccruedDays(s)
	if day >= target {
		return true
	}
	sc := Schedule(s)

	acc := AccPerShare(s)
	held := getAmount(s, keyAccHeld)
	active := TotalShares(s)

	// Per-day work is kept to ONE state read on an ordinary day.
	//
	// The accumulator needs day granularity only because `active` changes when
	// mints mature. Everything else — emission, the 50/25/25 split, the pool
	// credits — is closed-form and additive, so it is computed per day in pure
	// arithmetic and written to state ONCE for the whole walk. Writing four
	// pool balances every day would multiply the gas of a long catch-up by an
	// order of magnitude for no difference in the result.
	var totalEmitted, lshareTotal engine.Amount
	steps := 0
	retireBudget := MaxRetirePerWalk
	for day < target && steps < maxDays {
		// Retire the day's matured VOTING shares first. If the per-call budget
		// runs out mid-list (thousands maturing together, e.g. the migration
		// day), the walk stops here with its cursor stored and the next call
		// resumes — the day is not complete until its list is drained.
		if !drainExpiryList(s, day, &retireBudget) {
			break
		}
		from, to := heightOfDay(s, day), heightOfDay(s, day+1)
		var lshare engine.Amount
		if amount := sc.EmissionBetween(from, to); amount > 0 {
			alloc := engine.Split(amount)
			totalEmitted += amount
			lshareTotal += alloc.LShare
			lshare = alloc.LShare
		}
		// Stepped even when today's emission is zero: `held` may carry value
		// recycled while nobody was actively minting, and after emission ends
		// in year 75 EVERY day is a zero-emission day. Gating this on emission
		// stranded such value forever — the recycling engine, the only reward
		// source post-emission, silently died. Found by TestSeventyFiveYearRun.
		if lshare > 0 || held > 0 {
			acc, held = engine.AccumulatorStep(acc, lshare, held, active)
		}

		// Mints maturing today stop earning. The checkpoint is written AFTER
		// the day's emission, so a mint earns through its maturity day and not
		// one block beyond it.
		//
		// accAt is stored ONLY on expiry days: a checkpoint is only ever read
		// for a mint's maturity day, and over 75 years storing every day would
		// be 27,375 rows nobody looks at.
		if exp := getShares(s, expKey(day)); exp > 0 {
			active -= exp
			if active < 0 {
				active = 0 // defensive: never let the denominator go negative
			}
			s.Delete(expKey(day))
			setU64(s, accAtKey(day), uint64(acc))
		}

		day++
		steps++
	}

	if totalEmitted > 0 {
		viral, deep := engine.SplitPoB(engine.Split(totalEmitted).ProofOfBrain)
		addPool(s, keyPoolViral, viral)
		addPool(s, keyPoolDeep, deep)
		addPool(s, keyPoolLiquidity, engine.Split(totalEmitted).Liquidity)
		addPool(s, keyPoolLShare, lshareTotal)
		setAmount(s, keyEmitted, getAmount(s, keyEmitted)+totalEmitted)
	}

	setU64(s, keyAccPerShare, uint64(acc))
	setAmount(s, keyAccHeld, held)
	setShares(s, keySharesTotal, active)
	setU64(s, keyAccDay, day)
	// Emission is credited through the last COMPLETE day that was walked.
	setU64(s, keySettled, heightOfDay(s, day))

	return day >= target
}

// RecycleThroughAccumulator returns penalties, bleed and forfeited yield to the
// L-Share pool AND to the accumulator, so recycled value is shared out by the
// same rule as emission.
//
// Without this, recycled value would sit in the pool unclaimable by anyone: the
// accumulator is what grants a claim, and the pool balance alone grants none.
func RecycleThroughAccumulator(s Store, amt engine.Amount) {
	if amt <= 0 {
		return
	}
	addPool(s, keyPoolLShare, amt)
	acc, held := engine.AccumulatorStep(
		AccPerShare(s), amt, getAmount(s, keyAccHeld), TotalShares(s))
	setU64(s, keyAccPerShare, uint64(acc))
	setAmount(s, keyAccHeld, held)
}

// unscheduleExpiry cancels a scheduled stop, for a mint ended before maturity.
//
// Without this the walk would later subtract shares that had already left the
// active total when the mint was closed early, quietly shrinking the
// denominator and over-paying everyone still active.
func unscheduleExpiry(s Store, day uint64, shares engine.Shares) {
	if AccruedDays(s) > day {
		return // the walk already passed this day; nothing is scheduled
	}
	rest := getShares(s, expKey(day)) - shares
	if rest <= 0 {
		s.Delete(expKey(day))
		return
	}
	setShares(s, expKey(day), rest)
}

// AccrueFully loops the walk until it catches up.
//
// ⚠️ FOR THE SIMULATOR AND TESTS ONLY — NEVER CALL THIS FROM CONTRACT CODE.
// It is unbounded by construction, which is exactly what contract code may not
// be. On-chain the walk is deliberately capped at MaxAccrualDays per call and
// anyone may call the permissionless `advance` entrypoint to close a long gap.
// Same precedent as CollectMonthly.
func AccrueFully(s Store, toHeight uint64) {
	for !Accrue(s, toHeight) {
	}
}

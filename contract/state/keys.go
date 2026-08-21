package state

import "strconv"

// Contract state key layout.
//
// Keys are namespaced with a short prefix so that a state diff is readable and
// so that no two record types can ever collide. Prefixes are frozen: changing
// one orphans every record already written under the old name.
//
// IMPORTANT: there is no key that enumerates accounts. Any operation needing
// "every account" would be unbounded iteration, which cannot fit in the gas
// budget — see CLAUDE.md. Enumeration belongs off-chain, in the indexer.

const (
	// Config, written once at genesis.
	keyGenesis = "cfg_genesis" // uint64 Hive height at which emission starts
	keyInit    = "cfg_init"    // presence marks the contract initialised

	// Emission settlement watermark: the height through which block rewards
	// have already been credited to the three pools.
	keySettled = "cfg_settled"

	// Supply accounting.
	keyMigrated = "sup_migrated" // total credited by the migration snapshot
	keyEmitted  = "sup_emitted"  // total block rewards credited so far
	// sup_burned is RETIRED (2026-08-21): burns now credit hive:null, so the
	// burn total is that account's balance. The key name must never be reused.

	// Reward pools.
	keyPoolLShare = "pool_lshare" // 25% slice, plus all recycled penalties
	keyPoolViral  = "pool_viral"  // PoB 25%
	keyPoolDeep   = "pool_deep"   // PoB 75%
	// Liquidity slice, held until the LASSECASH:HBD swap contract exists to
	// receive it. Tracked separately so it can never be spent twice.
	keyPoolLiquidity = "pool_liq"

	// Rshares claiming against each PoB pool.
	keyRsharesViral = "rsh_viral"
	keyRsharesDeep  = "rsh_deep"

	// Total ACTIVE L-Shares: the denominator for yield.
	//
	// ⚠️ This is NOT the sum of every account's `shares/<account>`. Shares stop
	// earning at maturity and are removed from this total by the accrual walk,
	// but they remain on the ACCOUNT until the mint is claimed, because they
	// are still owned and still carry governance weight. Held shares vote;
	// active shares earn.
	keySharesTotal = "shares_total"

	// --- L-Share yield accrual ---------------------------------------------
	//
	// See engine/accumulator.go. `acc/per` is the cumulative reward-per-share,
	// scaled by engine.AccScale, and only ever rises. A mint records it at
	// creation and reads the checkpoint at its maturity day, so its yield is
	// exactly the emission that arrived while its shares were live.
	keyAccPerShare = "acc_per"  // int64, cumulative reward per share
	keyAccHeld     = "acc_held" // inflow not yet distributable (see MinSharesForAccrual)
	keyAccDay      = "acc_day"  // whole days since genesis already accrued
)

// balKey is an account's liquid LASSECASH balance.
func balKey(account string) string { return "bal_" + account }

// sharesKey is an account's total live L-Shares (the sum of its open mints).
// Denormalised so voting weight is an O(1) read rather than a scan of mints.
func sharesKey(account string) string { return "shr_" + account }

// mintSeqKey is the next mint id to allocate for an account.
func mintSeqKey(account string) string { return "mseq_" + account }

// mintKey addresses one mint. Ids are per-account and never reused, so a
// settled mint's key stays permanently retired.
func mintKey(account string, id uint64) string {
	return "mint_" + account + "_" + strconv.FormatUint(id, 10)
}

// pendKey is an account's pending Proof-of-Brain accrual awaiting its monthly
// mint. One record per account — never one per payout.
func pendKey(account string) string { return "pend_" + account }

// durationKey is the mint length the account chose in settings, in days.
func durationKey(account string) string { return "set_" + account + "_days" }

// --- curation queue -------------------------------------------------------
//
// A per-account list of posts the account has voted on and not yet been paid
// for. This is what lets the monthly settle claim curation automatically: the
// chain remembers what you are owed, so a curator never has to click.
//
// It is a RING, addressed by two integer cursors rather than a slice, because
// a slice would have to be read and rewritten whole on every vote.

// cqHeadKey is the oldest entry not yet drained.
func cqHeadKey(account string) string { return "cqh_" + account }

// cqTailKey is where the next entry will be written.
func cqTailKey(account string) string { return "cqt_" + account }

// cqKey addresses one queue slot. Value is "author|permlink", or empty once
// the slot has been settled.
func cqKey(account string, n uint64) string {
	return "cq_" + account + "_" + strconv.FormatUint(n, 10)
}

// govKey is one consensus member's standing preference for one parameter.
func govKey(param, account string) string { return "gov_" + param + "_" + account }

// votePowerKey is an account's vote-power meter for one content window.
func votePowerKey(account string, window uint8) string {
	return "vp_" + account + "_" + strconv.FormatUint(uint64(window), 10)
}

// postKey addresses a post by author and permlink.
func postKey(author, permlink string) string { return "post_" + author + "_" + permlink }

// postVoteKey addresses one voter's rshares on a post.
func postVoteKey(author, permlink, voter string) string {
	return "pv_" + author + "_" + permlink + "_" + voter
}

// accAtKey is the accumulator's value at the END of a given day.
//
// Written only for days on which mints mature, which is the only place a
// historical reading is ever needed. Storing every day would be pure waste:
// over the 75-year emission life that would be 27,375 rows nobody reads.
func accAtKey(day uint64) string { return "accAt_" + strconv.FormatUint(day, 10) }

// explCountKey / explChunkKey / explCursorKey hold a day's PER-ACCOUNT expiry
// list — who matures that day, in bounded chunks, so the accrual walk can
// retire each account's voting shares (`shr_`) at maturity without unbounded
// work in one call. Count is how many chunks exist; cursor (present only
// mid-drain) is the next chunk to process.
func explCountKey(day uint64) string {
	return "explc_" + strconv.FormatUint(day, 10)
}
func explChunkKey(day, n uint64) string {
	return "expl_" + strconv.FormatUint(day, 10) + "_" + strconv.FormatUint(n, 10)
}
func explCursorKey(day uint64) string {
	return "explp_" + strconv.FormatUint(day, 10)
}

// expKey holds the L-Shares scheduled to STOP earning at the end of a day.
//
// Maturity is known the moment a mint is created, so the schedule is built
// forward rather than discovered by scanning mints — which would be the
// unbounded iteration contract code cannot afford.
func expKey(day uint64) string { return "exp_" + strconv.FormatUint(day, 10) }

// migDoneKey marks an account as already credited by the migration, making a
// second credit impossible regardless of what the operator's tooling does.
func migDoneKey(account string) string { return "mig_" + account }

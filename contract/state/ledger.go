package state

import "github.com/lassecash/engine"

// The ledger: liquid balances, supply accounting, and the three reward pools.

// --- initialisation -------------------------------------------------------

// IsInit reports whether genesis has run.
func IsInit(s Store) bool { return get(s, keyInit) != nil }

// Init performs one-time genesis setup.
//
// genesisHeight is the Hive height at which emission begins — the migration
// snapshot height. It can never be changed afterwards: the whole emission
// schedule is denominated from it, so moving it would retroactively rewrite
// every reward ever paid.
func Init(s Store, genesisHeight uint64) Result {
	if IsInit(s) {
		return fail("already initialised")
	}
	if genesisHeight == 0 {
		return fail("genesis height must be set")
	}
	setU64(s, keyGenesis, genesisHeight)
	setU64(s, keySettled, genesisHeight)
	s.Set(keyInit, "1")
	return ok("initialised at height " + encU64(genesisHeight) + engine.BuildVariant)
}

// GenesisHeight returns the configured genesis height.
func GenesisHeight(s Store) uint64 { return getU64(s, keyGenesis) }

// Schedule returns the emission schedule bound to this contract's genesis.
func Schedule(s Store) engine.EmissionSchedule {
	sc := engine.DefaultSchedule
	sc.GenesisHeight = GenesisHeight(s)
	return sc
}

// --- balances -------------------------------------------------------------

// Balance returns an account's liquid balance.
func Balance(s Store, account string) engine.Amount { return getAmount(s, balKey(account)) }

// credit adds to a liquid balance. Callers must have sourced the amount from
// somewhere that was debited, or from emission.
func credit(s Store, account string, amt engine.Amount) bool {
	if amt < 0 {
		return false
	}
	if amt == 0 {
		return true
	}
	cur := Balance(s, account)
	next, okAdd := cur.Add(amt)
	if !okAdd {
		return false
	}
	setAmount(s, balKey(account), next)
	return true
}

// debit removes from a liquid balance, refusing to overdraw.
func debit(s Store, account string, amt engine.Amount) bool {
	if amt < 0 {
		return false
	}
	cur := Balance(s, account)
	if cur < amt {
		return false
	}
	setAmount(s, balKey(account), cur-amt)
	return true
}

// Transfer moves liquid LASSECASH between accounts.
func Transfer(s Store, ctx Ctx, to string, amt engine.Amount) Result {
	if amt <= 0 {
		return fail("amount must be positive")
	}
	if to == "" || to == ctx.Sender {
		return fail("invalid recipient")
	}
	if !debit(s, ctx.Sender, amt) {
		return fail("insufficient balance")
	}
	if !credit(s, to, amt) {
		// Put it back rather than leaving the sender short. Reaching here means
		// the recipient balance would overflow, which the cap makes impossible,
		// but a silent loss would be far worse than a refusal.
		credit(s, ctx.Sender, amt)
		return fail("credit failed")
	}
	return ok("transferred")
}

// BurnAccount is where burned value lives: the Hive `null` account has no
// keys, so `hive:null` on MAGI is provably unspendable.
//
// DECIDED by Lasse 2026-08-21: burning CREDITS null rather than destroying —
// "the null account should keep the tokens so we always can see how much is
// burned in the future." One address answers "how much was ever burned",
// forever, for anyone, including everything burned at migration. Burned value
// therefore stays inside total supply, visibly quarantined; it must NEVER
// earn, vote, or enter a mint — which is guaranteed by it being a plain
// liquid balance nobody can sign for.
const BurnAccount = "hive:null"

// Burn moves liquid balance to the null account, permanently.
func Burn(s Store, ctx Ctx, amt engine.Amount) Result {
	if amt <= 0 {
		return fail("amount must be positive")
	}
	if ctx.Sender == BurnAccount {
		return fail("null cannot act") // no keys exist, but fail closed anyway
	}
	if !debit(s, ctx.Sender, amt) {
		return fail("insufficient balance")
	}
	burn(s, amt)
	return ok("burned")
}

// burn credits the null account. The ONE way value is ever burned.
func burn(s Store, amt engine.Amount) {
	if amt > 0 {
		credit(s, BurnAccount, amt)
	}
}

// --- migration ------------------------------------------------------------

// CreditMigration credits one account's snapshot position at genesis.
//
// Two figures per account, from the Hive-Engine snapshot: the LIQUID balance
// becomes a liquid balance, and the STAKED power (LASSECASH POWER) becomes a
// 6-month migration mint whose L-Shares are the staked amount 1:1 — see
// engine.NewMigrationMint. Both count toward the migrated supply.
//
// Restricted to the pre-emission phase deliberately: once emission has been
// settled past genesis, the migrated supply is fixed and the hardcap arithmetic
// depends on it. Allowing a late credit would let supply appear from nowhere.
func CreditMigration(s Store, account string, liquid, staked engine.Amount) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	if getU64(s, keySettled) > GenesisHeight(s) {
		return fail("migration closed: emission already started")
	}
	if liquid < 0 || staked < 0 || liquid+staked <= 0 {
		return fail("amount must be positive")
	}
	// The null account receives the aggregate migration burn as LIQUID only.
	// A null mint would vote until maturity and then recycle into the reward
	// pool — redistribution, not burning. Never.
	if account == BurnAccount && staked > 0 {
		return fail("null cannot stake")
	}
	// ONE CREDIT PER ACCOUNT, ENFORCED HERE. The migration executor keeps a
	// resume file, but an operator file must never be the only thing standing
	// between a crash-and-restart and paying an account twice. Found in
	// rehearsal 2026-08-21: a deleted progress file re-credited 8 accounts and
	// the chain accepted every one of them. Each account's snapshot position is
	// a single record, so a second credit is never legitimate.
	if get(s, migDoneKey(account)) != nil {
		return fail("account already migrated")
	}

	migrated := getAmount(s, keyMigrated)
	next, okAdd := migrated.Add(liquid + staked)
	if !okAdd {
		return fail("overflow")
	}
	// The hardcap is enforced here, at the only point where supply enters the
	// chain from outside. migrated + the full future emission must fit.
	if next+engine.EmissionCap > engine.HistoricHardCap {
		return fail("would breach 51M hardcap")
	}
	if liquid > 0 && !credit(s, account, liquid) {
		return fail("credit failed")
	}
	if staked > 0 && !creditMigrationMint(s, account, staked) {
		return fail("migration mint failed")
	}
	setAmount(s, keyMigrated, next)
	s.Set(migDoneKey(account), migrationRecord(liquid, staked))
	return ok("migrated")
}

// migrationRecord is the permanent per-account receipt written at migration:
// what the account held on Hive-Engine, as LIQUID|STAKED base units. The same
// key doubles as the one-credit guard. Burned accounts get "burned|..." via
// burnRecord. Decided by Lasse 2026-08-21: the history of who held what must
// be readable on MAGI forever, not just implied by a lump sum at null.
func migrationRecord(liquid, staked engine.Amount) string {
	return encI64(int64(liquid)) + sep + encI64(int64(staked))
}

func burnRecord(liquid, staked engine.Amount) string {
	return "burned" + sep + migrationRecord(liquid, staked)
}

// creditMigrationMint turns snapshot staked power into the 6-month migration
// mint. It goes through registerMint — the ONE way a mint enters state — with
// the GENESIS height, not the broadcast height: batches land over hours, and
// every snapshot position must mature on the same day regardless of which
// batch carried it. Pre-emission the accrual walk is trivially current, so
// registerMint stamps AccStart at the genesis accumulator.
func creditMigrationMint(s Store, account string, staked engine.Amount) bool {
	genesis := GenesisHeight(s)
	m, made := engine.NewMigrationMint(account, staked, genesis)
	if !made {
		return false
	}
	_, ready := registerMint(s, Ctx{Sender: account, Height: genesis}, m)
	return ready
}

// MigratedSupply returns the total credited by the snapshot.
func MigratedSupply(s Store) engine.Amount { return getAmount(s, keyMigrated) }

// TotalEmitted returns the block rewards credited so far.
func TotalEmitted(s Store) engine.Amount { return getAmount(s, keyEmitted) }

// TotalBurned is the null account's balance — burned value is not destroyed,
// it is quarantined where everyone can count it (see BurnAccount).
func TotalBurned(s Store) engine.Amount { return Balance(s, BurnAccount) }

// --- pools ----------------------------------------------------------------

// PoolLShare returns the L-Share yield pool: the 25% emission slice plus every
// recycled penalty, bleed, and liquidation.
func PoolLShare(s Store) engine.Amount { return getAmount(s, keyPoolLShare) }

// PoolViral and PoolDeep return the two Proof-of-Brain pools.
func PoolViral(s Store) engine.Amount { return getAmount(s, keyPoolViral) }
func PoolDeep(s Store) engine.Amount  { return getAmount(s, keyPoolDeep) }

// addPool credits a reward pool.
func addPool(s Store, key string, amt engine.Amount) {
	if amt > 0 {
		setAmount(s, key, getAmount(s, key)+amt)
	}
}

// Recycle sweeps a slashed or bled amount into the L-Share reward pool.
//
// This is the single named destination for ALL recycled value. It is one
// function on purpose: after emission ends in year 75, recycling is the only
// thing funding rewards, and a future hardfork that wants to redirect it (for
// example through engine.Split, to also feed Proof-of-Brain and liquidity)
// changes this one call site and nothing else.
func Recycle(s Store, amt engine.Amount) {
	// Routed through the accumulator: the pool balance alone grants nobody a
	// claim, so value added without raising the accumulator would sit there
	// forever. See accrual.go.
	RecycleThroughAccumulator(s, amt)
}

// --- emission -------------------------------------------------------------

// Settle credits block rewards for every height between the settlement
// watermark and the current height, then advances the watermark.
//
// Anyone may call this and it is also called internally before any operation
// that reads a pool, so an idle chain cannot fall behind. It is O(eras), not
// O(heights): the engine computes emission in closed form, so settling one
// height and settling a year cost the same.
func Settle(s Store, ctx Ctx) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	// Emission is distributed by the accrual walk, which steps whole days so
	// that each day's emission is divided among the shares that were actually
	// live that day. See accrual.go — this is what stops a mint created today
	// from claiming a share of last year's rewards.
	if Accrue(s, ctx.Height) {
		return ok("settled")
	}
	return ok("settled partially; call advance to catch up")
}

func SettledHeight(s Store) uint64 { return getU64(s, keySettled) }

// MaxMigrateBatch bounds one migrate_batch call.
//
// Chosen for the real migration's economics: MAGI freezes a call's FULL
// rc_limit for its 5-day thaw, so 6,039 single `migrate` calls would park
// ~1,800 HBD of RC. At 50 accounts per call the whole snapshot fits in ~121
// calls. The bound itself exists because unbounded iteration is forbidden in
// contract code; whether 50 fits comfortably in gas must be measured with
// simulateContractCalls before the production freeze, like every other cap.
const MaxMigrateBatch = 50

// CreditMigrationBatch credits up to MaxMigrateBatch snapshot balances.
//
// Entries whose account is ALREADY migrated are skipped rather than failed:
// the executor resumes by rerunning batches, and a batch that straddles the
// crash point must be safe to send twice. Every other failure aborts the
// whole batch — a partially-applied batch would leave the executor unsure
// what to record, and with per-account markers a clean retry costs nothing.
func CreditMigrationBatch(s Store, entries []MigrationEntry) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	if getU64(s, keySettled) > GenesisHeight(s) {
		return fail("migration closed: emission already started")
	}
	if len(entries) == 0 {
		return fail("empty batch")
	}
	if len(entries) > MaxMigrateBatch {
		return fail("batch exceeds " + encU64(MaxMigrateBatch) + " accounts")
	}

	// VALIDATE EVERYTHING BEFORE WRITING ANYTHING. On-chain an abort discards
	// the call's writes anyway, but the state layer must not depend on that:
	// a half-applied batch in any environment would leave the executor unable
	// to tell what was recorded.
	var toAdd engine.Amount
	fresh := make([]MigrationEntry, 0, len(entries))
	inBatch := map[string]bool{}
	for _, e := range entries {
		if e.Liquid < 0 || e.Staked < 0 || e.Liquid+e.Staked <= 0 {
			return fail(e.Account + ": amount must be positive")
		}
		if e.Account == BurnAccount && e.Staked > 0 {
			return fail("null cannot stake")
		}
		if inBatch[e.Account] {
			return fail(e.Account + ": duplicated within the batch")
		}
		inBatch[e.Account] = true
		if get(s, migDoneKey(e.Account)) != nil {
			continue // idempotent resume: this account is already done
		}
		next, okAdd := toAdd.Add(e.Liquid + e.Staked)
		if !okAdd {
			return fail("overflow")
		}
		toAdd = next
		fresh = append(fresh, e)
	}

	migrated := getAmount(s, keyMigrated)
	total, okAdd := migrated.Add(toAdd)
	if !okAdd {
		return fail("overflow")
	}
	if total+engine.EmissionCap > engine.HistoricHardCap {
		return fail("would breach 51M hardcap")
	}

	genesis := GenesisHeight(s)
	mints := make([]engine.Mint, 0, len(fresh))
	for _, e := range fresh {
		if e.Liquid > 0 && !credit(s, e.Account, e.Liquid) {
			return fail("credit failed") // unreachable after validation
		}
		if e.Staked > 0 {
			m, made := engine.NewMigrationMint(e.Account, e.Staked, genesis)
			if !made {
				return fail("migration mint failed") // unreachable after validation
			}
			mints = append(mints, m)
		}
		s.Set(migDoneKey(e.Account), migrationRecord(e.Liquid, e.Staked))
	}
	// All migration mints share one maturity day, so they are registered in
	// bulk: the shared schedule rows are written once per batch, not once per
	// mint. Same stamping as registerMint; see registerMints.
	if len(mints) > 0 {
		if _, ready := registerMints(s, Ctx{Height: genesis}, mints); !ready {
			return fail("migration mint failed")
		}
	}
	setAmount(s, keyMigrated, total)
	return ok("migrated " + encU64(uint64(len(fresh))) + " of " + encU64(uint64(len(entries))))
}

// BurnMigrationBatch records up to MaxMigrateBatch NON-qualifying snapshot
// accounts: each one's LASSECASH and LASSECASH POWER are credited to the null
// account as liquid, and a per-account receipt is written so the history of
// who held what is readable on MAGI forever. Lasse, 2026-08-21: the burn must
// be "written in history that they had these lassecash and lassecash power",
// not an anonymous lump at null.
//
// Same discipline as CreditMigrationBatch: owner-only genesis phase, validate
// everything before writing anything, idempotent on resend (already-recorded
// accounts are skipped), and the hardcap is checked because null's balance is
// real supply — the identity `sum of holdings = migrated + emitted` holds.
func BurnMigrationBatch(s Store, entries []MigrationEntry) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	if getU64(s, keySettled) > GenesisHeight(s) {
		return fail("migration closed: emission already started")
	}
	if len(entries) == 0 {
		return fail("empty batch")
	}
	if len(entries) > MaxMigrateBatch {
		return fail("batch exceeds " + encU64(MaxMigrateBatch) + " accounts")
	}

	var toAdd engine.Amount
	fresh := make([]MigrationEntry, 0, len(entries))
	inBatch := map[string]bool{}
	for _, e := range entries {
		if e.Liquid < 0 || e.Staked < 0 || e.Liquid+e.Staked <= 0 {
			return fail(e.Account + ": amount must be positive")
		}
		if inBatch[e.Account] {
			return fail(e.Account + ": duplicated within the batch")
		}
		inBatch[e.Account] = true
		if get(s, migDoneKey(e.Account)) != nil {
			continue // already migrated OR already burned: never twice
		}
		next, okAdd := toAdd.Add(e.Liquid + e.Staked)
		if !okAdd {
			return fail("overflow")
		}
		toAdd = next
		fresh = append(fresh, e)
	}

	migrated := getAmount(s, keyMigrated)
	total, okAdd := migrated.Add(toAdd)
	if !okAdd {
		return fail("overflow")
	}
	if total+engine.EmissionCap > engine.HistoricHardCap {
		return fail("would breach 51M hardcap")
	}

	// One null credit per batch — the per-account read-modify-write of the
	// same balance was pure gas.
	var toNull engine.Amount
	for _, e := range fresh {
		toNull += e.Liquid + e.Staked
		s.Set(migDoneKey(e.Account), burnRecord(e.Liquid, e.Staked))
	}
	burn(s, toNull)
	setAmount(s, keyMigrated, total)
	return ok("burned " + encU64(uint64(len(fresh))) + " of " + encU64(uint64(len(entries))) + " to null")
}

// MigrationRecord reads an account's permanent migration receipt: whether it
// was burned, and the liquid / staked LASSECASH it held on Hive-Engine.
// found=false means the account was not in the snapshot at all.
func MigrationRecord(s Store, account string) (burned bool, liquid, staked engine.Amount, found bool) {
	raw := get(s, migDoneKey(account))
	if raw == nil {
		return false, 0, 0, false
	}
	f := ParseArgs(*raw)
	if len(f) == 3 && f[0] == "burned" {
		return true, engine.Amount(decI64(f[1])), engine.Amount(decI64(f[2])), true
	}
	if len(f) == 2 {
		return false, engine.Amount(decI64(f[0])), engine.Amount(decI64(f[1])), true
	}
	return false, 0, 0, true // legacy "1" marker from the first rehearsals
}

// MigrationEntry is one account's snapshot position: the liquid balance and
// the staked LASSECASH POWER, migrated as balance and 6-month mint.
type MigrationEntry struct {
	Account string
	Liquid  engine.Amount
	Staked  engine.Amount
}

package state

import (
	"strings"

	"github.com/lassecash/engine"
)

// CLAIM-BASED MIGRATION — decided by Lasse 2026-08-21.
//
// The push model (owner credits every account) needs ~8.8M RC ≈ thousands of
// HBD parked on MAGI. So instead the owner commits ONE Merkle root at genesis
// and every holder claims their own leaf with a proof, paying their own free
// RC. The tree — every account, qualifying and burned — is published in
// full, so the root is a permanent, verifiable record of who held what.
//
// THE CLAIM IS THE MINT. Every migration mint runs on the shared clock from
// genesis: matures day 30, grace to day 60, bleeds to zero at day 150 —
// exactly the push economics. Claiming merely collects it:
//
//	day   0–30   liquid + a mint maturing on day 30 (earns/votes from claim on)
//	day  30–60   liquid + the full minted amount, straight to liquid
//	day 60–150   liquid + the surviving fraction; the bled part recycles
//	after 150    nothing — sweep_unclaimed recycles the remainder
//
// Burned leaves cannot be claimed; anyone may RECORD them (the receipt) at
// their own RC. Null is credited with the burn total at genesis in one call.

const (
	keyMigRoot    = "cfg_migroot"  // hex Merkle root of the snapshot tree
	keyMigTotal   = "cfg_migtotal" // committed total of all QUALIFYING leaves
	keyMigClaimed = "sup_claimed"  // how much of that has been claimed
	keyMigSwept   = "cfg_migswept" // "1" once the unclaimed remainder recycled
	keyMigBurn    = "cfg_migburn"  // the burn total credited to null at commit
)

// ClaimDeadlineHeight is when claiming closes: the end of the migration
// mints' bleed. Derived, not a new constant — one timeline for everything.
func ClaimDeadlineHeight(s Store) uint64 {
	days := uint64(engine.MigrationMintDays + engine.GraceDays + engine.BleedDays)
	return GenesisHeight(s) + days*uint64(engine.HeightsPerDay)
}

// SetSnapshot commits the migration tree. Owner only, genesis phase, ONCE.
//
// qualifierTotal is the sum of every claimable leaf (liquid + staked);
// burnTotal is everything else, credited to null right here. The hardcap is
// checked against the whole snapshot now, so no later claim can breach it.
func SetSnapshot(s Store, rootHex string, qualifierTotal, burnTotal engine.Amount) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	if getU64(s, keySettled) > GenesisHeight(s) {
		return fail("migration closed: emission already started")
	}
	if get(s, keyMigRoot) != nil {
		return fail("snapshot already committed")
	}
	if _, ok := engine.HexToHash(rootHex); !ok {
		return fail("root must be 64 hex characters")
	}
	if qualifierTotal < 0 || burnTotal < 0 || qualifierTotal+burnTotal <= 0 {
		return fail("totals must be positive")
	}
	whole := qualifierTotal + burnTotal
	if MigratedSupply(s)+whole+engine.EmissionCap > engine.HistoricHardCap {
		return fail("would breach 51M hardcap")
	}
	s.Set(keyMigRoot, rootHex)
	setAmount(s, keyMigTotal, qualifierTotal)
	setAmount(s, keyMigBurn, burnTotal)
	if burnTotal > 0 {
		burn(s, burnTotal)
		setAmount(s, keyMigrated, MigratedSupply(s)+burnTotal)
	}
	return ok("snapshot committed")
}

// SnapshotTotal is the whole committed snapshot — burned + claimable — fixed
// at genesis. This, not MigratedSupply (which only counts what has been
// CLAIMED so far), is the figure the hardcap picture must use: the claims
// are coming whether or not they have landed yet.
func SnapshotTotal(s Store) engine.Amount {
	return getAmount(s, keyMigTotal) + getAmount(s, keyMigBurn)
}

// SnapshotBurn is the burn half of the committed snapshot, fixed at genesis.
// NOT the same as Balance(hive:null), which also carries every burn since
// (user burn, PoB burn payout mode, promote_post).
func SnapshotBurn(s Store) engine.Amount {
	return getAmount(s, keyMigBurn)
}

// MigrationRoot reports the committed root, if any.
func MigrationRoot(s Store) (string, bool) {
	r := get(s, keyMigRoot)
	if r == nil {
		return "", false
	}
	return *r, true
}

// ClaimMigration collects the sender's snapshot position.
func ClaimMigration(s Store, ctx Ctx, liquid, staked engine.Amount, proofHex []string) Result {
	if !IsInit(s) {
		return fail("not initialised")
	}
	rootHex := get(s, keyMigRoot)
	if rootHex == nil {
		return fail("snapshot not committed yet")
	}
	if ctx.Height >= ClaimDeadlineHeight(s) {
		return fail("claim window closed")
	}
	if ctx.Sender == BurnAccount {
		return fail("null cannot act")
	}
	if liquid < 0 || staked < 0 || liquid+staked <= 0 {
		return fail("amount must be positive")
	}
	if get(s, migDoneKey(ctx.Sender)) != nil {
		return fail("already claimed")
	}
	if !verifyLeaf(*rootHex, ctx.Sender, liquid, staked, false, proofHex) {
		return fail("proof does not match the snapshot")
	}
	// The committed total bounds every claim: a forged leaf cannot exist, but
	// this makes "sum of claims <= what was committed" a checked invariant.
	claimed := getAmount(s, keyMigClaimed)
	next, okAdd := claimed.Add(liquid + staked)
	if !okAdd || next > getAmount(s, keyMigTotal) {
		return fail("claim exceeds the committed snapshot")
	}

	// The mint exists on the shared clock whether or not it was claimed.
	m, _ := engine.NewMigrationMint(ctx.Sender, staked, GenesisHeight(s))
	var toOwner, recycled engine.Amount
	if staked > 0 {
		if !m.IsMature(ctx.Height) {
			// Before maturity: a real mint, earning and voting from now on.
			if !Accrue(s, ctx.Height) {
				return fail("accrual is behind; call advance then claim again")
			}
			if _, ready := registerMints(s, ctx, []engine.Mint{m}); !ready {
				return fail("accrual is behind; call advance then claim again")
			}
		} else {
			// Matured: collect what a claim of that mint would pay today.
			// No yield — it never earned — and the bled part recycles.
			st := m.Settle(ctx.Height, 0)
			toOwner, recycled = st.ToOwner, st.ToRewardPool
		}
	}

	if liquid+toOwner > 0 && !credit(s, ctx.Sender, liquid+toOwner) {
		return fail("credit failed")
	}
	Recycle(s, recycled)
	setAmount(s, keyMigClaimed, next)
	setAmount(s, keyMigrated, MigratedSupply(s)+liquid+staked)
	s.Set(migDoneKey(ctx.Sender), migrationRecord(liquid, staked))
	return ok("claimed " + encI64(int64(liquid+toOwner)) + " liquid")
}

// RecordBurn writes the permanent receipt for a BURNED leaf. Permissionless,
// pays nothing, moves nothing — null was credited with the total at genesis.
// It exists so anyone who cares can put "this account held this and was
// burned" on-chain at their own RC; the tree already proves it regardless.
func RecordBurn(s Store, account string, liquid, staked engine.Amount, proofHex []string) Result {
	rootHex := get(s, keyMigRoot)
	if rootHex == nil {
		return fail("snapshot not committed yet")
	}
	if account == "" || liquid < 0 || staked < 0 || liquid+staked <= 0 {
		return fail("bad entry")
	}
	if get(s, migDoneKey(account)) != nil {
		return fail("already recorded")
	}
	if !verifyLeaf(*rootHex, account, liquid, staked, true, proofHex) {
		return fail("proof does not match the snapshot")
	}
	s.Set(migDoneKey(account), burnRecord(liquid, staked))
	return ok("burn recorded")
}

// SweepUnclaimed recycles everything committed but never claimed into the
// L-Share reward pool, once the window has closed. Permissionless, no
// bounty, once. Lasse chose the pool over null: it is the tail of the same
// bleed the late claims ran on, and it funds the recycling engine.
func SweepUnclaimed(s Store, ctx Ctx) Result {
	if get(s, keyMigRoot) == nil {
		return fail("snapshot not committed yet")
	}
	if ctx.Height < ClaimDeadlineHeight(s) {
		return fail("claim window still open")
	}
	if get(s, keyMigSwept) != nil {
		return fail("already swept")
	}
	if !Accrue(s, ctx.Height) {
		return fail("accrual is behind; call advance then sweep again")
	}
	remainder := getAmount(s, keyMigTotal) - getAmount(s, keyMigClaimed)
	if remainder > 0 {
		setAmount(s, keyMigrated, MigratedSupply(s)+remainder)
		Recycle(s, remainder)
	}
	s.Set(keyMigSwept, "1")
	return ok("swept " + encI64(int64(remainder)) + " unclaimed to the reward pool")
}

// verifyLeaf checks one leaf + proof against the committed root.
func verifyLeaf(rootHex, account string, liquid, staked engine.Amount, burned bool, proofHex []string) bool {
	root, ok := engine.HexToHash(rootHex)
	if !ok || len(proofHex) > engine.MaxProofLen {
		return false
	}
	proof := make([]engine.Hash, 0, len(proofHex))
	for _, p := range proofHex {
		h, ok := engine.HexToHash(strings.TrimSpace(p))
		if !ok {
			return false
		}
		proof = append(proof, h)
	}
	return engine.VerifyProof(engine.LeafHash(account, liquid, staked, burned), proof, root)
}

// ParseProof splits the comma-separated hex proof argument.
func ParseProof(arg string) []string {
	if arg == "" {
		return nil
	}
	return strings.Split(arg, ",")
}

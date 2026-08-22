package state

import (
	"testing"

	"github.com/lassecash/engine"
)

type leaf struct {
	account        string
	liquid, staked engine.Amount
	burned         bool
}

// snapshotTree builds the tree the tools would publish and returns root +
// per-account proofs (as hex), exactly what a claimer hands the contract.
func snapshotTree(leaves []leaf) (string, map[string][]string) {
	hashes := make([]engine.Hash, len(leaves))
	for i, l := range leaves {
		hashes[i] = engine.LeafHash(l.account, l.liquid, l.staked, l.burned)
	}
	root, proofs := engine.BuildTree(hashes)
	out := map[string][]string{}
	for i, l := range leaves {
		hex := make([]string, len(proofs[i]))
		for j, h := range proofs[i] {
			hex[j] = engine.HashToHex(h)
		}
		out[l.account] = hex
	}
	return engine.HashToHex(root), out
}

var claimLeaves = []leaf{
	{"hive:alice", lc(1_000), lc(9_000), false},
	{"hive:bob", lc(500), 0, false},
	{"hive:carol", 0, lc(4_000), false},
	{"hive:dead", lc(300), lc(700), true},
	{"hive:lassecash", lc(7_000), 0, true},
}

func committedChain(t *testing.T) (*MemStore, Ctx, map[string][]string) {
	t.Helper()
	s, ctx := newChain(t)
	root, proofs := snapshotTree(claimLeaves)
	if r := SetSnapshot(s, root, lc(1_000+9_000+500+4_000), lc(300+700+7_000)); !r.OK {
		t.Fatal(r.Msg)
	}
	return s, ctx, proofs
}

func TestSnapshotCommitCreditsNullAndIsOnce(t *testing.T) {
	s, _, _ := committedChain(t)
	if TotalBurned(s) != lc(8_000) {
		t.Fatalf("null holds %s, want 8,000", fmtA(TotalBurned(s)))
	}
	if MigratedSupply(s) != lc(8_000) {
		t.Fatal("burn total must count as migrated supply at commit")
	}
	root, _ := snapshotTree(claimLeaves)
	if r := SetSnapshot(s, root, lc(1), 0); r.OK {
		t.Fatal("second commit accepted")
	}
	auditSupply(t, s)
}

func TestClaimBeforeMaturityIsAMint(t *testing.T) {
	s, ctx, proofs := committedChain(t)
	r := ClaimMigration(s, at(ctx, "hive:alice", genesis+5*engine.HeightsPerDay),
		lc(1_000), lc(9_000), proofs["hive:alice"])
	if !r.OK {
		t.Fatalf("claim: %s", r.Msg)
	}
	if Balance(s, "hive:alice") != lc(1_000) {
		t.Fatalf("liquid %s, want 1,000", fmtA(Balance(s, "hive:alice")))
	}
	if SharesOf(s, "hive:alice") != engine.Shares(lc(9_000)) {
		t.Fatalf("shares %d, want staked 1:1", SharesOf(s, "hive:alice"))
	}
	m, found := GetMint(s, "hive:alice", 1)
	if !found || m.StartHeight != genesis || m.Days != engine.MigrationMintDays {
		t.Fatal("migration mint must run on the shared clock from genesis")
	}
	// Twice is refused; a tampered amount is refused; a wrong proof is refused.
	if r := ClaimMigration(s, at(ctx, "hive:alice", genesis+6*engine.HeightsPerDay), lc(1_000), lc(9_000), proofs["hive:alice"]); r.OK {
		t.Fatal("double claim accepted")
	}
	if r := ClaimMigration(s, at(ctx, "hive:bob", genesis), lc(501), 0, proofs["hive:bob"]); r.OK {
		t.Fatal("tampered amount accepted")
	}
	if r := ClaimMigration(s, at(ctx, "hive:bob", genesis), lc(500), 0, proofs["hive:carol"]); r.OK {
		t.Fatal("wrong proof accepted")
	}
	// A burned leaf can never be claimed — not even with its own valid proof.
	if r := ClaimMigration(s, at(ctx, "hive:dead", genesis), lc(300), lc(700), proofs["hive:dead"]); r.OK {
		t.Fatal("burned account claimed")
	}
	auditSupply(t, s)
}

func TestClaimTimelineMatchesTheMintLifecycle(t *testing.T) {
	day := uint64(engine.HeightsPerDay)
	cases := []struct {
		day        uint64
		wantLiquid engine.Amount // what carol (0 liquid, 4,000 staked) receives
		wantPool   bool          // whether anything was recycled
	}{
		// Offsets are MigrationMintDays(30) + GraceDays(90) + days into the
		// bleed. Grace widened 30 -> 90 on 2026-08-22, so the bleed now starts
		// at day 120 and reaches zero at day 210.
		{45, lc(4_000), false},                   // grace: full minted amount, as liquid
		{30 + 90 + 45, lc(2_000), true},          // mid-bleed: half, rest to the pool
		{30 + 90 + 89, lc(4_000) * 1 / 90, true}, // one day from zero
	}
	for _, c := range cases {
		s, ctx, proofs := committedChain(t)
		h := genesis + c.day*day
		AccrueFully(s, h)
		poolBefore := PoolLShare(s)
		r := ClaimMigration(s, at(ctx, "hive:carol", h), 0, lc(4_000), proofs["hive:carol"])
		if !r.OK {
			t.Fatalf("day %d: %s", c.day, r.Msg)
		}
		got := Balance(s, "hive:carol")
		if got < c.wantLiquid-lc(1) || got > c.wantLiquid+lc(1) {
			t.Fatalf("day %d: received %s, want ~%s", c.day, fmtA(got), fmtA(c.wantLiquid))
		}
		if SharesOf(s, "hive:carol") != 0 {
			t.Fatalf("day %d: a matured claim must not create voting shares", c.day)
		}
		if (PoolLShare(s) > poolBefore) != c.wantPool {
			t.Fatalf("day %d: pool recycling mismatch", c.day)
		}
		auditSupply(t, s)
	}
	// After the deadline: refused.
	s, ctx, proofs := committedChain(t)
	h := ClaimDeadlineHeight(s)
	AccrueFully(s, h)
	if r := ClaimMigration(s, at(ctx, "hive:carol", h), 0, lc(4_000), proofs["hive:carol"]); r.OK {
		t.Fatal("claim accepted after the window closed")
	}
}

func TestSweepUnclaimedRecyclesTheRemainderOnce(t *testing.T) {
	s, ctx, proofs := committedChain(t)
	// bob claims; alice and carol never do.
	if r := ClaimMigration(s, at(ctx, "hive:bob", genesis), lc(500), 0, proofs["hive:bob"]); !r.OK {
		t.Fatal(r.Msg)
	}
	if r := SweepUnclaimed(s, at(ctx, "hive:x", genesis+day)); r.OK {
		t.Fatal("swept while the window was open")
	}
	h := ClaimDeadlineHeight(s)
	AccrueFully(s, h)
	poolBefore := PoolLShare(s)
	if r := SweepUnclaimed(s, at(ctx, "hive:x", h)); !r.OK {
		t.Fatal(r.Msg)
	}
	unclaimed := lc(1_000 + 9_000 + 4_000)
	if PoolLShare(s)-poolBefore != unclaimed {
		t.Fatalf("pool grew %s, want the unclaimed %s", fmtA(PoolLShare(s)-poolBefore), fmtA(unclaimed))
	}
	if MigratedSupply(s) != lc(8_000+500)+unclaimed {
		t.Fatal("migrated supply must now equal the whole committed snapshot")
	}
	if r := SweepUnclaimed(s, at(ctx, "hive:x", h+1)); r.OK {
		t.Fatal("second sweep accepted")
	}
	auditSupply(t, s)
}

func TestRecordBurnWritesTheReceiptOnly(t *testing.T) {
	s, _, proofs := committedChain(t)
	before := TotalBurned(s)
	if r := RecordBurn(s, "hive:dead", lc(300), lc(700), proofs["hive:dead"]); !r.OK {
		t.Fatal(r.Msg)
	}
	burned, liq, stk, found := MigrationRecord(s, "hive:dead")
	if !found || !burned || liq != lc(300) || stk != lc(700) {
		t.Fatal("burn receipt wrong")
	}
	if TotalBurned(s) != before {
		t.Fatal("recording a burn must move no value")
	}
	if r := RecordBurn(s, "hive:dead", lc(300), lc(700), proofs["hive:dead"]); r.OK {
		t.Fatal("recorded twice")
	}
	// A qualifying leaf cannot be "recorded as burned".
	if r := RecordBurn(s, "hive:bob", lc(500), 0, proofs["hive:bob"]); r.OK {
		t.Fatal("a live account was recorded as burned")
	}
	auditSupply(t, s)
}

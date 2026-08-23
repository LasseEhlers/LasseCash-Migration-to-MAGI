package migtree

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/lassecash/engine"
)

// staticDir is where ./cmd/merkletree publishes, relative to this package.
const staticDir = "../../web/static/migration"

// TestPublishedTreeRebuildsToTheCommittedRoot is the check that matters after
// a snapshot is regenerated: take ONLY the public files — leaves.json and the
// shard proofs, exactly what a visitor's browser downloads — and reproduce the
// root the contract will verify against.
//
// If this fails, either the published files are stale or the root is wrong,
// and every claim on the chain would be rejected with nothing on the page to
// explain it.
func TestPublishedTreeRebuildsToTheCommittedRoot(t *testing.T) {
	root, entries := readPublished(t)

	leaves := make([]engine.Hash, len(entries))
	for i, e := range entries {
		leaves[i] = engine.LeafHash(e.account, engine.Amount(e.liquid), engine.Amount(e.staked), e.burned)
	}
	got, proofs := engine.BuildTree(leaves)
	if engine.HashToHex(got) != root.Root {
		t.Fatalf("rebuilt root %s != published %s", engine.HashToHex(got), root.Root)
	}
	if root.LeafCount != len(entries) {
		t.Fatalf("root.json says %d leaves, leaves.json has %d", root.LeafCount, len(entries))
	}

	// The committed totals must be the sum of the leaves, or the contract's
	// "claim exceeds the committed snapshot" bound is set to the wrong number.
	var qual, burn int64
	for _, e := range entries {
		if e.burned {
			burn += e.liquid + e.staked
		} else {
			qual += e.liquid + e.staked
		}
	}
	if strconv.FormatInt(qual, 10) != root.QualifierUnit {
		t.Fatalf("qualifier total %d != published %s", qual, root.QualifierUnit)
	}
	if strconv.FormatInt(burn, 10) != root.BurnUnit {
		t.Fatalf("burn total %d != published %s", burn, root.BurnUnit)
	}

	// EVERY account, verified the way the CONTRACT verifies: the shard file's
	// proof, the shard file's amounts, against the published root.
	//
	// This used to sample 50 accounts with rand.NewSource(1) — the SAME 50 on
	// every run, so 99.5% of holders' shard rows were never checked by any
	// number of re-runs. Write() emits root.json first and the shards last; a
	// crash in between leaves a fresh root over stale shards, and the old test
	// passed unless one of its fixed 50 happened to land in a bad one. Two
	// independent reviews flagged it on 2026-08-23. The full check takes a
	// quarter of a second for 12,550 leaves. There was never a reason to sample.
	rootHash, ok := engine.HexToHash(root.Root)
	if !ok {
		t.Fatalf("published root is not 64 hex characters: %q", root.Root)
	}
	shards := map[string]map[string]ProofEntry{}
	rows := 0
	for i, e := range entries {
		key := Shard(bare(e.account))
		shard, cached := shards[key]
		if !cached {
			shard = readShard(t, key)
			shards[key] = shard
			rows += len(shard)
		}
		pe, found := shard[e.account]
		if !found {
			t.Fatalf("%s missing from shard %s", e.account, Shard(bare(e.account)))
		}
		if pe.Liquid != strconv.FormatInt(e.liquid, 10) || pe.Staked != strconv.FormatInt(e.staked, 10) ||
			pe.Burned != e.burned {
			t.Fatalf("%s: shard row disagrees with leaves.json", e.account)
		}
		proof := make([]engine.Hash, len(pe.Proof))
		for j, hx := range pe.Proof {
			h, ok := engine.HexToHash(hx)
			if !ok {
				t.Fatalf("%s: proof element %d is not hex", e.account, j)
			}
			proof[j] = h
		}
		if !engine.VerifyProof(leaves[i], proof, rootHash) {
			t.Fatalf("%s: published proof does not verify", e.account)
		}
		// And the proof the shard serves must be the proof the tree built —
		// element for element, not just the same length.
		if len(proof) != len(proofs[i]) {
			t.Fatalf("%s: proof length %d != rebuilt %d", e.account, len(proof), len(proofs[i]))
		}
		for j := range proof {
			if proof[j] != proofs[i][j] {
				t.Fatalf("%s: proof element %d differs from the rebuilt tree", e.account, j)
			}
		}
	}
	// Every shard row must be a leaf, and every leaf a shard row. A shard that
	// kept rows from an older build would otherwise offer a proof for an
	// account the committed root has never heard of.
	if rows != len(entries) {
		t.Fatalf("shard files hold %d rows but the tree has %d leaves — stale shard on disk", rows, len(entries))
	}
}

// TestPublishedTreeMatchesTheSnapshotItClaimsToDescribe catches the other
// staleness direction: the files are self-consistent but were built from an
// older migration_set.json.
func TestPublishedTreeMatchesTheSnapshotItClaimsToDescribe(t *testing.T) {
	const setPath = "../../tools/snapshot/data/migration_set.json"
	if _, err := os.Stat(setPath); err != nil {
		// Was t.Skip. A checkout without the snapshot reported GREEN, which is a
		// guard that silently stops guarding. The published tree exists only to
		// describe this file; its absence is a failure, not an exemption.
		t.Fatalf("no snapshot at %s — the published tree cannot be checked against what it claims to describe", setPath)
	}
	tree, err := BuildFromFile(setPath)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	root, _ := readPublished(t)
	if tree.RootHex() != root.Root {
		t.Fatalf("migration_set.json builds %s but web/static/migration/root.json says %s — "+
			"re-run ./build.sh tree", tree.RootHex(), root.Root)
	}
}

// TestShardNamesStayInsideTheSafeAlphabet keeps a snapshot account name from
// ever naming a file outside the proofs directory.
func TestShardNamesStayInsideTheSafeAlphabet(t *testing.T) {
	for _, name := range []string{"", "a", "ab", "a.b", "a-b", "../etc", "AB", "z9"} {
		s := Shard(name)
		if len(s) != 2 {
			t.Fatalf("%q -> %q: shard must be two characters", name, s)
		}
		for i := 0; i < 2; i++ {
			c := s[i]
			okc := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_'
			if !okc {
				t.Fatalf("%q -> %q: unsafe character %q", name, s, string(c))
			}
		}
	}
	if Shard("../etc") == ".." {
		t.Fatal("path traversal survived sharding")
	}
}

// --- reading the published files -----------------------------------------

type pubLeaf struct {
	account        string
	liquid, staked int64
	burned         bool
}

func readPublished(t *testing.T) (RootFile, []pubLeaf) {
	t.Helper()
	var root RootFile
	raw, err := os.ReadFile(filepath.Join(staticDir, "root.json"))
	if err != nil {
		// Was t.Skip — deleting root.json turned both migration tests green.
		t.Fatalf("no published tree (%v) — run ./build.sh tree", err)
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("root.json: %v", err)
	}

	raw, err = os.ReadFile(filepath.Join(staticDir, "leaves.json"))
	if err != nil {
		t.Fatalf("leaves.json: %v", err)
	}
	var rows [][]json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("leaves.json: %v", err)
	}
	entries := make([]pubLeaf, len(rows))
	for i, r := range rows {
		if len(r) != 4 {
			t.Fatalf("leaves.json row %d has %d fields, want 4", i, len(r))
		}
		var account, liquid, staked string
		var burned bool
		mustJSON(t, r[0], &account)
		mustJSON(t, r[1], &liquid)
		mustJSON(t, r[2], &staked)
		mustJSON(t, r[3], &burned)
		entries[i] = pubLeaf{account, atoi(t, liquid), atoi(t, staked), burned}
	}
	return root, entries
}

func readShard(t *testing.T, shard string) map[string]ProofEntry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(staticDir, "proofs", shard+".json"))
	if err != nil {
		t.Fatalf("shard %s: %v", shard, err)
	}
	var out map[string]ProofEntry
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("shard %s: %v", shard, err)
	}
	return out
}

func mustJSON(t *testing.T, raw json.RawMessage, into any) {
	t.Helper()
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("leaves.json field: %v", err)
	}
}

func atoi(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("amount %q: %v", s, err)
	}
	return n
}

func bare(account string) string {
	for i := 0; i < len(account); i++ {
		if account[i] == ':' {
			return account[i+1:]
		}
	}
	return account
}

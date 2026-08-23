// Package migtree turns the migration snapshot into the Merkle tree the
// claim-based migration commits to, and into the static files a browser needs
// to build one proof.
//
// # WHY THIS IS GO AND NOT PYTHON
//
// The leaf hash, the sorted-pair parent hash and the odd-node promotion are
// ONE implementation — engine/merkle.go — shared by the contract that verifies
// and the tool that builds. A second implementation in another language would
// be the golden rule's forbidden drift, except worse: the failure mode is not
// a wrong preview, it is every claim on the chain being rejected by a root
// nobody can reproduce. So the tool imports the engine and hashes with the
// contract's own code.
//
// # WHAT IT PRODUCES
//
//	root.json     the committed root, the two totals, the leaf count
//	leaves.json   every leaf in tree order — the public record of who held what
//	proofs/xx.json  one shard per two-character account prefix
//
// The shards exist so a claim page fetches ~20 KB rather than the whole 10 MB
// proof set. Sharding by prefix (not by hash) means the browser can name the
// file it needs from the account name alone, with no index to download first.
package migtree

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/lassecash/engine"
)

// Entry is one account's position in the snapshot.
type Entry struct {
	// Account is FULLY QUALIFIED ("hive:alice"), exactly as the SDK renders a
	// sender — the leaf hash commits this string, so it must match what the
	// contract sees at claim time or the proof fails.
	Account string
	// Name is the bare Hive name, used only to pick the shard file.
	Name   string
	Liquid int64
	Staked int64
	// Burned leaves cannot be claimed, only recorded. The flag is inside the
	// hash, so a burned holder cannot re-present their leaf as a qualifying one.
	Burned bool
}

// Snapshot is the parsed migration_set.json.
type Snapshot struct {
	Generated    string
	WindowMonths int
	Entries      []Entry
}

// Tree is a built snapshot: leaves in canonical order, their proofs, and the
// totals the owner commits alongside the root.
type Tree struct {
	Snapshot
	Root           engine.Hash
	Proofs         [][]engine.Hash
	QualifierTotal int64
	BurnTotal      int64
}

// RootHex is the 64-character root the contract stores in cfg_migroot.
func (t *Tree) RootHex() string { return engine.HashToHex(t.Root) }

// setEntry is one account row in migration_set.json.
type setEntry struct {
	Liquid int64 `json:"liquid"`
	Staked int64 `json:"staked"`
	Total  int64 `json:"total"`
}

type setDoc struct {
	Generated    string              `json:"generated"`
	WindowMonths int                 `json:"window_months"`
	Migrate      map[string]setEntry `json:"migrate"`
	BurnInactive map[string]setEntry `json:"burn_inactive"`
	BurnProtocol map[string]setEntry `json:"burn_protocol"`
}

// Load reads migration_set.json into the canonical leaf order.
//
// Accounts holding NOTHING are left out entirely rather than given a zero
// leaf: there is nothing to claim, the contract refuses a zero claim anyway,
// and a leaf per empty account would inflate the tree by thousands of rows
// that can never be used.
func Load(path string) (*Snapshot, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc setDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}

	snap := &Snapshot{Generated: doc.Generated, WindowMonths: doc.WindowMonths}
	seen := map[string]bool{}

	add := func(name string, e setEntry, burned bool) error {
		// REFUSE rather than build a dead leaf. Two independent reviews on
		// 2026-08-23 showed this loader accepted everything: a negative field
		// (liquid -5, staked 10 sums to 5 and passes), a key already carrying
		// "hive:" (becomes hive:hive:bob), uppercase (ctx.Sender is never
		// uppercase), a pipe (shifts the leaf's field count). Each of those
		// builds a leaf with a valid proof that the contract can NEVER honour —
		// the holder is told "amount must be positive" or "no leaf" and their
		// tokens sweep at day 210. This is the last gate before an immutable
		// commit and it is re-run on freshly fetched data at the announced
		// block, so it gets its own defence instead of trusting upstream.
		if e.Liquid < 0 || e.Staked < 0 {
			return fmt.Errorf("account %q has a negative field (liquid %d, staked %d)", name, e.Liquid, e.Staked)
		}
		if !validHiveName(name) {
			return fmt.Errorf("account %q is not a bare lowercase Hive name", name)
		}
		if e.Liquid+e.Staked <= 0 {
			return nil
		}
		if seen[name] {
			// The same account qualifying AND burning is a snapshot bug that
			// would put two claimable leaves under one name. Refuse to build.
			return fmt.Errorf("account %q appears twice in the snapshot", name)
		}
		seen[name] = true
		snap.Entries = append(snap.Entries, Entry{
			Account: "hive:" + name, Name: name,
			Liquid: e.Liquid, Staked: e.Staked, Burned: burned,
		})
		return nil
	}

	for _, src := range []struct {
		rows   map[string]setEntry
		burned bool
	}{
		{doc.Migrate, false},
		{doc.BurnInactive, true},
		{doc.BurnProtocol, true},
	} {
		names := make([]string, 0, len(src.rows))
		for n := range src.rows {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			if err := add(n, src.rows[n], src.burned); err != nil {
				return nil, err
			}
		}
	}
	if len(snap.Entries) == 0 {
		return nil, errors.New("snapshot has no non-zero accounts")
	}

	// ONE canonical order — sorted by the qualified account — so the same
	// snapshot always produces the same root, whoever builds it.
	sort.Slice(snap.Entries, func(i, j int) bool {
		return snap.Entries[i].Account < snap.Entries[j].Account
	})
	return snap, nil
}

// Build hashes the leaves and assembles the tree.
func Build(snap *Snapshot) *Tree {
	leaves := make([]engine.Hash, len(snap.Entries))
	t := &Tree{Snapshot: *snap}
	for i, e := range snap.Entries {
		leaves[i] = engine.LeafHash(e.Account,
			engine.Amount(e.Liquid), engine.Amount(e.Staked), e.Burned)
		if e.Burned {
			t.BurnTotal += e.Liquid + e.Staked
		} else {
			t.QualifierTotal += e.Liquid + e.Staked
		}
	}
	t.Root, t.Proofs = engine.BuildTree(leaves)
	return t
}

// BuildFromFile is Load + Build, which is what every caller wants.
func BuildFromFile(path string) (*Tree, error) {
	snap, err := Load(path)
	if err != nil {
		return nil, err
	}
	return Build(snap), nil
}

// --- static output --------------------------------------------------------

// RootFile is web/static/migration/root.json.
type RootFile struct {
	Root          string `json:"root"`
	QualifierUnit string `json:"qualifier_total"`
	BurnUnit      string `json:"burn_total"`
	LeafCount     int    `json:"leaf_count"`
	Generated     string `json:"generated"`
	WindowMonths  int    `json:"window_months"`
}

// ProofEntry is one account's row in a shard file.
type ProofEntry struct {
	Liquid string   `json:"liquid"`
	Staked string   `json:"staked"`
	Burned bool     `json:"burned"`
	Proof  []string `json:"proof"`
}

// Shard names the file an account's proof lives in: the first two characters
// of its BARE name. Hive names are [a-z0-9.-], start with a letter and are at
// least three characters, so two characters always exist.
//
// Anything outside that alphabet is folded to "_" BEFORE it can reach the
// filesystem, and the first character additionally refuses "." and "-" — the
// account name is attacker-chosen data as far as this function is concerned,
// and a shard name is both a file path here and a URL path in the browser.
// validHiveName is the Hive account-name grammar as the contract will see it
// in ctx.Sender after "hive:" is prepended: 3-16 chars, lowercase, starting
// with a letter, dots and dashes allowed inside. Anything else can never be a
// sender and so can never claim.
func validHiveName(n string) bool {
	if len(n) < 3 || len(n) > 16 {
		return false
	}
	for i := 0; i < len(n); i++ {
		c := n[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case (c == '.' || c == '-') && i > 0 && i < len(n)-1:
		default:
			return false
		}
	}
	return n[0] >= 'a' && n[0] <= 'z'
}

func Shard(name string) string {
	const alnum = "abcdefghijklmnopqrstuvwxyz0123456789"
	out := []byte("__")
	for i := 0; i < 2 && i < len(name); i++ {
		safe := alnum
		if i == 1 {
			safe = alnum + ".-"
		}
		if strings.IndexByte(safe, name[i]) >= 0 {
			out[i] = name[i]
		}
	}
	return string(out)
}

// Write emits root.json, leaves.json and proofs/<shard>.json under dir.
//
// Amounts are written as STRINGS, never JSON numbers. They fit a float64 today
// (7e14 against a 9e15 safe range) but the margin is one order of magnitude
// and these figures are hashed: a value that survives a round trip through
// JavaScript's Number by luck is not a value to build a Merkle proof on.
func (t *Tree) Write(dir string) error {
	if err := os.MkdirAll(filepath.Join(dir, "proofs"), 0o755); err != nil {
		return err
	}

	root := RootFile{
		Root:          t.RootHex(),
		QualifierUnit: strconv.FormatInt(t.QualifierTotal, 10),
		BurnUnit:      strconv.FormatInt(t.BurnTotal, 10),
		LeafCount:     len(t.Entries),
		Generated:     t.Generated,
		WindowMonths:  t.WindowMonths,
	}
	if err := writeJSON(filepath.Join(dir, "root.json"), root, true); err != nil {
		return err
	}

	// leaves.json is the PUBLIC RECORD: every leaf, in tree order, so anyone
	// can rebuild the root from scratch and check it against the chain.
	rows := make([][]any, len(t.Entries))
	for i, e := range t.Entries {
		rows[i] = []any{e.Account,
			strconv.FormatInt(e.Liquid, 10), strconv.FormatInt(e.Staked, 10), e.Burned}
	}
	if err := writeJSON(filepath.Join(dir, "leaves.json"), rows, false); err != nil {
		return err
	}

	shards := map[string]map[string]ProofEntry{}
	for i, e := range t.Entries {
		sh := Shard(e.Name)
		if shards[sh] == nil {
			shards[sh] = map[string]ProofEntry{}
		}
		proof := make([]string, len(t.Proofs[i]))
		for j, h := range t.Proofs[i] {
			proof[j] = engine.HashToHex(h)
		}
		shards[sh][e.Account] = ProofEntry{
			Liquid: strconv.FormatInt(e.Liquid, 10),
			Staked: strconv.FormatInt(e.Staked, 10),
			Burned: e.Burned,
			Proof:  proof,
		}
	}
	// Remove shard files from a previous, larger snapshot: a stale shard would
	// serve a proof against a root that no longer exists, and the claim would
	// fail on-chain with nothing on the page to explain why.
	old, _ := filepath.Glob(filepath.Join(dir, "proofs", "*.json"))
	for _, f := range old {
		if _, keep := shards[strings.TrimSuffix(filepath.Base(f), ".json")]; !keep {
			if err := os.Remove(f); err != nil {
				return err
			}
		}
	}
	for sh, rows := range shards {
		if err := writeJSON(filepath.Join(dir, "proofs", sh+".json"), rows, false); err != nil {
			return err
		}
	}
	return nil
}

// ShardCount reports how many shard files Write would emit.
func (t *Tree) ShardCount() int {
	seen := map[string]bool{}
	for _, e := range t.Entries {
		seen[Shard(e.Name)] = true
	}
	return len(seen)
}

func writeJSON(path string, v any, indent bool) error {
	var (
		raw []byte
		err error
	)
	if indent {
		raw, err = json.MarshalIndent(v, "", " ")
	} else {
		raw, err = json.Marshal(v)
	}
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o644)
}

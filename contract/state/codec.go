package state

import (
	"strconv"
	"strings"

	"github.com/lassecash/engine"
)

// Encoding for contract state.
//
// Records are pipe-delimited decimal fields — NOT JSON. Reasons:
//
//   - encoding/json needs reflect, which bloats the WASM binary and costs gas
//     that is charged to the caller's RC.
//   - tinyjson would work but needs a code-generation step in the build.
//   - State diffs show up in `simulateContractCalls` output; decimal text is
//     readable there, packed binary is not.
//
// Every field is a base-10 integer. Order is fixed and append-only: NEVER
// reorder or remove a field, only append, or previously written state becomes
// unreadable.

const sep = "|"

// --- primitives -----------------------------------------------------------

func encU64(v uint64) string { return strconv.FormatUint(v, 10) }
func encI64(v int64) string  { return strconv.FormatInt(v, 10) }

func decU64(s string) uint64 {
	v, err := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func decI64(s string) int64 {
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func decBool(s string) bool { return strings.TrimSpace(s) == "1" }

func encBool(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// --- store helpers --------------------------------------------------------

func getU64(s Store, key string) uint64 {
	v := get(s, key)
	if v == nil {
		return 0
	}
	return decU64(*v)
}

func setU64(s Store, key string, v uint64) { s.Set(key, encU64(v)) }

func getAmount(s Store, key string) engine.Amount {
	v := get(s, key)
	if v == nil {
		return 0
	}
	return engine.Amount(decI64(*v))
}

func setAmount(s Store, key string, v engine.Amount) { s.Set(key, encI64(int64(v))) }

func getShares(s Store, key string) engine.Shares {
	v := get(s, key)
	if v == nil {
		return 0
	}
	return engine.Shares(decI64(*v))
}

func setShares(s Store, key string, v engine.Shares) { s.Set(key, encI64(int64(v))) }

// --- mint records ---------------------------------------------------------

// encodeMint serialises a mint. Field order is frozen:
//
//	principal | shares | startHeight | days | goodAccounting | ended | accStart | expChunk
//
// APPEND-ONLY. accStart was added 2026-08-21 with the yield-accrual rewrite;
// expChunk the same day with maturity share-retirement. Decode tolerates
// shorter records so nothing already written is orphaned.
func encodeMint(m engine.Mint) string {
	return encI64(int64(m.Principal)) + sep +
		encI64(int64(m.Shares)) + sep +
		encU64(m.StartHeight) + sep +
		encI64(m.Days) + sep +
		encBool(m.GoodAccounting) + sep +
		encBool(m.Ended) + sep +
		encI64(m.AccStart) + sep +
		encU64(m.ExpChunk)
}

// decodeMint parses a mint record. Owner is not stored — it is implied by the
// key the record was read from, so it cannot disagree with its location.
func decodeMint(owner, raw string) (engine.Mint, bool) {
	f := strings.Split(raw, sep)
	if len(f) < 6 {
		return engine.Mint{}, false
	}
	m := engine.Mint{
		Owner:          owner,
		Principal:      engine.Amount(decI64(f[0])),
		Shares:         engine.Shares(decI64(f[1])),
		StartHeight:    decU64(f[2]),
		Days:           decI64(f[3]),
		GoodAccounting: decBool(f[4]),
		Ended:          decBool(f[5]),
	}
	if len(f) > 6 {
		m.AccStart = decI64(f[6])
	}
	if len(f) > 7 {
		m.ExpChunk = decU64(f[7])
	}
	return m, true
}

// --- pending records ------------------------------------------------------

// encodePending serialises a pending PoB accrual: balance | lastEpoch
func encodePending(p engine.PendingAccount) string {
	return encI64(int64(p.Balance)) + sep + encU64(p.LastEpoch)
}

func decodePending(raw string) engine.PendingAccount {
	f := strings.Split(raw, sep)
	if len(f) < 2 {
		return engine.PendingAccount{}
	}
	return engine.PendingAccount{
		Balance:   engine.Amount(decI64(f[0])),
		LastEpoch: decU64(f[1]),
	}
}

// --- argument parsing -----------------------------------------------------

// Args is a parsed entrypoint argument list.
//
// Entrypoints take pipe-delimited positional arguments, e.g. "1000000000|1095".
// Same reasoning as state encoding: no reflect, no JSON parser in the binary.
type Args []string

// ParseArgs splits an entrypoint payload.
func ParseArgs(payload string) Args {
	if payload == "" {
		return Args{}
	}
	return Args(strings.Split(payload, sep))
}

// Len reports how many arguments were supplied.
func (a Args) Len() int { return len(a) }

// Str returns argument i, or "" if absent.
func (a Args) Str(i int) string {
	if i < 0 || i >= len(a) {
		return ""
	}
	return strings.TrimSpace(a[i])
}

// I64 returns argument i as an int64, and whether it parsed.
func (a Args) I64(i int) (int64, bool) {
	s := a.Str(i)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// U64 returns argument i as a uint64, and whether it parsed.
func (a Args) U64(i int) (uint64, bool) {
	s := a.Str(i)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// Amount returns argument i as an engine.Amount, rejecting negatives — no
// entrypoint has a legitimate use for a negative amount, and allowing one would
// turn a transfer into a theft.
func (a Args) Amount(i int) (engine.Amount, bool) {
	v, ok := a.I64(i)
	if !ok || v < 0 {
		return 0, false
	}
	return engine.Amount(v), true
}

// get reads a key, treating an EMPTY value as ABSENT.
//
// ⚠️ Always use this instead of calling Store.Get directly.
//
// MAGI's `sdk.StateGetObject` returns a non-nil pointer to an empty string for
// a key that was never written — it does not return nil. The SDK's own
// `StateGetU64` is written as `if val == nil || *val == ""`, which is the tell.
// Code that tests only `!= nil` therefore behaves one way in tests and another
// on-chain.
//
// That is not hypothetical. `IsInit` tested only `!= nil`, so the first live
// test deploy reported "already initialised" on a virgin contract: `init`
// could never be called and the contract was permanently unusable. Found
// 2026-08-20 by simulating against the real chain. Had the owner keys been
// burned first (see CLAUDE.md, Immutability) it would have been unfixable.
//
// Collapsing both cases to nil here is exact, not a heuristic: nothing in this
// contract ever deliberately stores an empty value, so empty genuinely means
// absent. `MemStore` mimics the same awkward behaviour so tests cannot pass on
// a kindness the chain does not offer.
func get(s Store, key string) *string {
	v := s.Get(key)
	if v == nil || *v == "" {
		return nil
	}
	return v
}

// Package state holds the LasseCash contract's storage layer and every
// operation the contract can perform.
//
// WHY THIS PACKAGE EXISTS SEPARATELY FROM app/:
//
// The MAGI SDK declares its host calls with //go:wasmimport and no build tags,
// so the sdk package compiles ONLY for a wasm target. Anything importing it is
// untestable with `go test`. So all real logic lives here, behind the Store
// interface, and app/ is a thin shim that implements Store over the SDK.
//
// The result: contract behaviour is unit-tested natively, and the WASM build is
// only responsible for wiring. Nothing in this package may import sdk.
package state

import "github.com/lassecash/engine"

// Store is the contract's key/value state.
//
// Get returns nil for a missing key — that is how "unset" is distinguished from
// "set to empty string", which matters for initialisation checks.
type Store interface {
	Get(key string) *string
	Set(key, value string)
	Delete(key string)
}

// MemStore is an in-memory Store for tests and the dev simulator.
type MemStore struct {
	m map[string]string
}

// NewMemStore returns an empty in-memory store.
func NewMemStore() *MemStore { return &MemStore{m: map[string]string{}} }

// Get mimics MAGI EXACTLY, including its sharp edge.
//
// ⚠️ A MISSING KEY RETURNS A NON-NIL POINTER TO AN EMPTY STRING, not nil.
// That is what `sdk.StateGetObject` does on-chain — the SDK's own
// `StateGetU64` guards with `val == nil || *val == ""`, which is the tell.
//
// This used to return nil, and the divergence was not theoretical: `IsInit`
// tested only `!= nil`, so on MemStore a virgin contract looked uninitialised
// and 40 tests passed, while on MAGI it looked ALREADY INITIALISED and `init`
// could never be called. The first live test deploy (2026-08-20) was bricked
// from birth. Had the owner keys been burned first, LasseCash would have been
// unrecoverable.
//
// So the fake is deliberately as awkward as the real thing. A test double that
// is kinder than production is not a test double, it is a way of not finding
// out. Use `get()` in codec.go rather than calling this directly.
func (s *MemStore) Get(key string) *string {
	v, ok := s.m[key]
	if !ok {
		empty := ""
		return &empty
	}
	return &v
}

func (s *MemStore) Set(key, value string) { s.m[key] = value }
func (s *MemStore) Delete(key string)     { delete(s.m, key) }

// Len reports how many keys are set. Tests use it to catch state bloat.
func (s *MemStore) Len() int { return len(s.m) }

// Keys returns every key currently set, unsorted. Test/debug only.
func (s *MemStore) Keys() []string {
	out := make([]string, 0, len(s.m))
	for k := range s.m {
		out = append(out, k)
	}
	return out
}

// Ctx is everything an operation needs from the chain besides storage.
//
// It is passed in rather than read from the SDK so that operations stay pure
// and testable. app/ fills this from sdk.GetEnv().
type Ctx struct {
	// Sender is the account that signed the transaction.
	Sender string
	// Height is the current Hive block height (3s granularity).
	Height uint64
	// Epoch is the calendar month index, derived by the caller from
	// block.timestamp. Used only for the monthly PoB mint.
	Epoch uint64
}

// Result is what an operation reports back to the caller.
type Result struct {
	OK  bool
	Msg string
}

func ok(msg string) Result   { return Result{OK: true, Msg: msg} }
func fail(msg string) Result { return Result{OK: false, Msg: msg} }

// Amount is re-exported so callers need not import engine directly.
type Amount = engine.Amount

// OK builds a successful Result. Exported for app/, which cannot use the
// unexported helper but must still report a result the same way.
func OK(msg string) Result { return Result{OK: true, Msg: msg} }

package state

import "github.com/lassecash/engine"

// LASSECASH's ledger, when it lives in a standard MAGI `magi_token`.
//
// WHY: a balance in our own format is invisible to every tool MAGI has —
// their indexer, their wallets, their DEX. In their standard format all three
// see it for free, and BTC -> LASSECASH becomes possible inside Altera.
// TibFox's point, 2026-09-06, and he was right. See docs/TOKEN-LEDGER-PLAN.md.
//
// WHAT DOES NOT CHANGE: everything else. Mints, L-Shares, Proof-of-Brain, the
// pool with its 0% fee and loyalty curve, thresholds, the claim tree. Only
// where the number is stored moves.
//
// THE INJECTION POINT IS THE STORE, deliberately. `credit`/`debit` are called
// from deep inside accrual and payout paths that have no business knowing
// about token contracts, and threading a parameter through all of them would
// touch code the economics live in. A Store that ALSO speaks Tokens carries
// it instead — so the call sites are unchanged, `MemStore` keeps exercising
// the legacy path, and `MemTokenStore` exercises the new one.
//
// state/ still never imports sdk: the real implementation is injected from
// app/, exactly like Assets does for HBD.

// Tokens is the external magi_token that holds LASSECASH.
//
// The CORE owns this token, so it is the only thing that can mint, and after
// the key burn no human can. Its `maxSupply` is the 51M hardcap, which makes
// the cap enforced twice and independently: by our emission code, and by the
// token refusing to exceed it even if we asked.
type Tokens interface {
	// TokenBalance reads an account's balance straight out of the token's
	// state. Measured at 17 RC on the devnet — CHEAPER than a local write
	// (97), because a read is not weighted 19x the way a write is.
	TokenBalance(account string) engine.Amount
	// TokenMint creates tokens into the CORE's own balance. The standard
	// credits the owner, never an address, so paying a user is mint-to-self
	// (in bulk, rarely) plus a transfer.
	TokenMint(amount engine.Amount) bool
	// TokenTransfer sends from the core to an account. ~301 RC.
	TokenTransfer(to string, amount engine.Amount) bool
	// TokenTransferFrom pulls from an account into the core, spending the
	// allowance the user granted in the same signed transaction.
	TokenTransferFrom(from string, amount engine.Amount) bool
	// TokenSelf is the core's own address as the token sees it,
	// `contract:vsc1...`.
	TokenSelf() string
}

// TokenStore is a Store whose LASSECASH lives in a magi_token.
//
// A plain Store keeps the legacy `bal_` ledger. That is not a permanent
// fallback — it is what makes the migration safe, because both shapes are
// live at once while the rows move across.
type TokenStore interface {
	Store
	Tokens
}

// tokensOf returns the token ledger if this Store has one.
func tokensOf(s Store) (Tokens, bool) {
	t, has := s.(TokenStore)
	return t, has
}

// DecodeTokenAmount reads a magi_token balance: big-endian unsigned bytes,
// exactly as the standard writes them (`bigIntToBytes` -> `big.Int.Bytes()`).
//
// Refuses anything that would not fit an engine.Amount rather than wrapping:
// the 51M cap is 5.1e15 base units against int64's 9.2e18, so a value too
// large to fit is corruption or a token we should not be reading, and
// silently truncating it would invent money.
func DecodeTokenAmount(raw string) (engine.Amount, bool) {
	if raw == "" {
		return 0, true // absent reads as zero, the empty-vs-nil rule
	}
	if len(raw) > 8 {
		return 0, false
	}
	var n int64
	for i := 0; i < len(raw); i++ {
		if n > (1<<62)/256 {
			return 0, false
		}
		n = n<<8 | int64(raw[i])
	}
	if n < 0 {
		return 0, false
	}
	return engine.Amount(n), true
}

// EncodeTokenAmount writes the standard's big-endian unsigned form. Zero is a
// single zero byte, matching `bigIntToBytes`.
func EncodeTokenAmount(a engine.Amount) string {
	if a <= 0 {
		return "\x00"
	}
	var buf [8]byte
	n := uint64(a)
	i := 8
	for n > 0 {
		i--
		buf[i] = byte(n)
		n >>= 8
	}
	return string(buf[i:])
}

// --- the migration --------------------------------------------------------

// ensureMigrated moves one account's legacy `bal_` row into the token, once.
//
// SELF-MARKING, and that is the whole safety of the migration: a deleted key
// reads as empty, i.e. absent, so "has a non-zero bal_" MEANS "not yet
// migrated". There is no flag to get wrong and no double-count possible. An
// account that transacts while the owner's sweep is still running migrates
// itself first, then the action proceeds against the token.
//
// Runs at the top of every credit and debit. After the sweep finishes it is
// one cheap read that finds nothing.
func ensureMigrated(s Store, t Tokens, account string) bool {
	legacy := getAmount(s, balKey(account))
	if legacy <= 0 {
		return true
	}
	// Mint into the core, then hand it to the owner: the standard's mint
	// credits the owner only.
	if !t.TokenMint(legacy) {
		return false
	}
	if !t.TokenTransfer(account, legacy) {
		return false
	}
	s.Delete(balKey(account))
	return true
}

// MigrateLedger moves a batch of accounts' balances into the token.
//
// Owner-only at the entrypoint. ATOMIC per batch and IDEMPOTENT: an account
// already migrated has no `bal_` row and is skipped, so a resend after a
// crash is safe — the same discipline `CreditMigrationBatch` was rehearsed
// with in August, and for the same reason: an operator's progress file must
// never be the last line of defence.
func MigrateLedger(s Store, accounts []string) Result {
	t, has := tokensOf(s)
	if !has {
		return fail("no token ledger configured")
	}
	moved := 0
	for _, a := range accounts {
		if a == "" {
			continue
		}
		if getAmount(s, balKey(a)) <= 0 {
			continue
		}
		if !ensureMigrated(s, t, a) {
			return fail("migration failed for " + a)
		}
		moved++
	}
	return ok("migrated " + encU64(uint64(moved)))
}

// --- supply ---------------------------------------------------------------

// mintSupply raises a supply counter AND mints the same amount into the core.
//
// THE INVARIANT THIS EXISTS FOR: the token's totalSupply must always equal
// `sup_migrated + sup_emitted`. Every place supply grows goes through here, so
// the two can never drift — not by a rounding error, not by a missed call
// site. The token's own `maxSupply` (51M) is the backstop underneath it, which
// makes the hardcap enforced twice and independently.
//
// The core mints to ITSELF. `credit` then hands tokens out of that float; it
// never mints, so a credit can only ever move money that already exists.
func mintSupply(s Store, key string, delta engine.Amount) bool {
	if delta < 0 {
		return false
	}
	if delta == 0 {
		return true
	}
	cur := getAmount(s, key)
	next, okAdd := cur.Add(delta)
	if !okAdd {
		return false
	}
	if t, has := tokensOf(s); has {
		if !t.TokenMint(delta) {
			return false
		}
	}
	setAmount(s, key, next)
	return true
}

// --- test double ----------------------------------------------------------

// MemTokenStore is a MemStore whose LASSECASH lives in an in-memory token.
//
// Deliberately as awkward as the real thing: mint credits the CORE, transfers
// move between real balances, and transferFrom refuses an overdraw. A test
// double kinder than production is a way of not finding out.
type MemTokenStore struct {
	*MemStore
	Bal  map[string]engine.Amount
	Sup  engine.Amount
	Self string
	Fail bool
}

func NewMemTokenStore() *MemTokenStore {
	return &MemTokenStore{
		MemStore: NewMemStore(),
		Bal:      map[string]engine.Amount{},
		Self:     "contract:vsc1test",
	}
}

func (m *MemTokenStore) TokenSelf() string { return m.Self }

func (m *MemTokenStore) TokenBalance(account string) engine.Amount { return m.Bal[account] }

func (m *MemTokenStore) TokenMint(amount engine.Amount) bool {
	if m.Fail || amount <= 0 {
		return false
	}
	m.Bal[m.Self] += amount
	m.Sup += amount
	return true
}

func (m *MemTokenStore) TokenTransfer(to string, amount engine.Amount) bool {
	if m.Fail || amount <= 0 || to == "" || m.Bal[m.Self] < amount {
		return false
	}
	m.Bal[m.Self] -= amount
	m.Bal[to] += amount
	return true
}

func (m *MemTokenStore) TokenTransferFrom(from string, amount engine.Amount) bool {
	if m.Fail || amount <= 0 || from == "" || m.Bal[from] < amount {
		return false
	}
	m.Bal[from] -= amount
	m.Bal[m.Self] += amount
	return true
}

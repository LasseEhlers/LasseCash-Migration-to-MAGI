package state

import (
	"testing"

	"github.com/lassecash/engine"
)

// newTokenChain is newChain with the ledger in a magi_token.
func newTokenChain(t *testing.T) (*MemTokenStore, Ctx) {
	t.Helper()
	s := NewMemTokenStore()
	if r := Init(s, genesis); !r.OK {
		t.Fatalf("init failed: %s", r.Msg)
	}
	return s, Ctx{Height: genesis, Epoch: 1}
}

// THE TEST THAT JUSTIFIES THE WHOLE CHANGE.
//
// The same operations, in the same order, against the legacy `bal_` ledger and
// against a magi_token, must produce byte-identical economics. If these ever
// diverge, the contract is paying different money depending on where the
// number happens to be stored — which is exactly the second-implementation
// drift the golden rule exists to prevent.
func TestTokenLedgerMatchesLegacyExactly(t *testing.T) {
	legacy, lctx := newChain(t)
	token, tctx := newTokenChain(t)

	run := func(s Store, ctx Ctx) (bal, sup engine.Amount) {
		if r := CreditMigration(s, "hive:alice", lc(1_000), 0); !r.OK {
			t.Fatalf("migrate alice: %s", r.Msg)
		}
		if r := CreditMigration(s, "hive:bob", lc(250), 0); !r.OK {
			t.Fatalf("migrate bob: %s", r.Msg)
		}
		ctx.Sender = "hive:alice"
		if r := Transfer(s, ctx, "hive:bob", lc(100)); !r.OK {
			t.Fatalf("transfer: %s", r.Msg)
		}
		if r := Burn(s, ctx, lc(50)); !r.OK {
			t.Fatalf("burn: %s", r.Msg)
		}
		return Balance(s, "hive:alice"), MigratedSupply(s)
	}

	lBal, lSup := run(legacy, lctx)
	tBal, tSup := run(token, tctx)

	if lBal != tBal {
		t.Fatalf("alice differs: legacy %s, token %s", fmtA(lBal), fmtA(tBal))
	}
	if lSup != tSup {
		t.Fatalf("supply differs: legacy %s, token %s", fmtA(lSup), fmtA(tSup))
	}
	for _, who := range []string{"hive:alice", "hive:bob", BurnAccount} {
		if a, b := Balance(legacy, who), Balance(token, who); a != b {
			t.Fatalf("%s differs: legacy %s, token %s", who, fmtA(a), fmtA(b))
		}
	}
}

// The token's totalSupply must equal migrated+emitted at every moment. If it
// can drift, every outside tool reading the token disagrees with /api/supply,
// and the 51M cap stops meaning anything.
func TestTokenSupplyNeverDriftsFromAccounting(t *testing.T) {
	s, ctx := newTokenChain(t)
	check := func(stage string) {
		t.Helper()
		want := MigratedSupply(s) + TotalEmitted(s)
		if s.Sup != want {
			t.Fatalf("%s: token supply %s, accounting %s", stage, fmtA(s.Sup), fmtA(want))
		}
	}
	check("genesis")
	if r := CreditMigration(s, "hive:alice", lc(5_000), 0); !r.OK {
		t.Fatalf("migrate: %s", r.Msg)
	}
	check("after migration")
	ctx.Sender = "hive:alice"
	if r := Transfer(s, ctx, "hive:bob", lc(1_000)); !r.OK {
		t.Fatalf("transfer: %s", r.Msg)
	}
	check("after a transfer (supply must NOT move)")
	if r := Burn(s, ctx, lc(500)); !r.OK {
		t.Fatalf("burn: %s", r.Msg)
	}
	// Burning credits hive:null; nothing is destroyed, so supply is unchanged.
	check("after a burn")
}

// A legacy row migrates itself the first time the account is touched, exactly
// once, and the key is gone afterwards. This is what makes the sweep safe to
// run while people are transacting: there is no window in which a balance
// reads zero, and no flag that can be wrong.
func TestLegacyRowMigratesItselfOnFirstTouch(t *testing.T) {
	s, ctx := newTokenChain(t)

	// A row as it exists TODAY, written before the token ledger arrived.
	setAmount(s, balKey("hive:carol"), lc(700))
	if got := Balance(s, "hive:carol"); got != lc(700) {
		t.Fatalf("legacy row unreadable: %s", fmtA(got))
	}
	if s.TokenBalance("hive:carol") != 0 {
		t.Fatal("token already holds it; nothing has migrated yet")
	}

	ctx.Sender = "hive:carol"
	if r := Transfer(s, ctx, "hive:dave", lc(200)); !r.OK {
		t.Fatalf("transfer: %s", r.Msg)
	}

	if got := getAmount(s, balKey("hive:carol")); got != 0 {
		t.Fatalf("legacy row survived: %s — it would be double-counted", fmtA(got))
	}
	if got := s.TokenBalance("hive:carol"); got != lc(500) {
		t.Fatalf("token balance %s, want 500", fmtA(got))
	}
	if got := Balance(s, "hive:carol"); got != lc(500) {
		t.Fatalf("Balance() %s, want 500", fmtA(got))
	}
}

// MigrateLedger is the owner's sweep. Idempotent, because an operator's
// progress file must never be the last line of defence — the same lesson the
// August migration rehearsal taught when a deleted progress file re-credited
// eight accounts.
func TestMigrateLedgerIsIdempotent(t *testing.T) {
	s, _ := newTokenChain(t)
	for _, who := range []string{"hive:a", "hive:b", "hive:c"} {
		setAmount(s, balKey(who), lc(100))
	}
	r := MigrateLedger(s, []string{"hive:a", "hive:b", "hive:c"})
	if !r.OK {
		t.Fatalf("sweep: %s", r.Msg)
	}
	before := s.Sup
	if r := MigrateLedger(s, []string{"hive:a", "hive:b", "hive:c"}); !r.OK {
		t.Fatalf("re-run: %s", r.Msg)
	}
	if s.Sup != before {
		t.Fatalf("re-running the sweep minted again: %s -> %s", fmtA(before), fmtA(s.Sup))
	}
	for _, who := range []string{"hive:a", "hive:b", "hive:c"} {
		if got := s.TokenBalance(who); got != lc(100) {
			t.Fatalf("%s holds %s, want 100", who, fmtA(got))
		}
	}
}

// The standard stores balances as big-endian unsigned bytes. Decoding must
// round-trip and must REFUSE anything too large for an engine.Amount rather
// than wrapping — a truncated read would invent money.
func TestTokenAmountEncoding(t *testing.T) {
	for _, v := range []engine.Amount{0, 1, lc(1), lc(51_000_000), engine.Amount(1<<62 - 1)} {
		got, ok := DecodeTokenAmount(EncodeTokenAmount(v))
		if !ok {
			t.Fatalf("%s did not round-trip", fmtA(v))
		}
		if v > 0 && got != v {
			t.Fatalf("round-trip %s -> %s", fmtA(v), fmtA(got))
		}
	}
	if _, ok := DecodeTokenAmount("\xff\xff\xff\xff\xff\xff\xff\xff\xff"); ok {
		t.Fatal("a 9-byte value was accepted; it cannot fit an Amount")
	}
	if got, ok := DecodeTokenAmount(""); !ok || got != 0 {
		t.Fatal("absent must read as zero, per the empty-vs-nil rule")
	}
}

// THE PATH THAT MATTERS MOST: a real migration claim, on a token ledger.
//
// 2,692,167 LASSECASH is still unclaimed by people who will claim it exactly
// this way, and a claim both credits liquid AND creates a mint — so it is the
// heaviest ordinary path in the contract. The legacy and token ledgers must
// pay the identical figure.
func TestClaimOnATokenLedgerPaysTheSameAsLegacy(t *testing.T) {
	root, proofs := snapshotTree(claimLeaves)
	commit := func(s Store) {
		if r := SetSnapshot(s, root, lc(1_000+9_000+500+4_000), lc(300+700+7_000)); !r.OK {
			t.Fatalf("commit: %s", r.Msg)
		}
	}

	legacy, lctx := newChain(t)
	commit(legacy)
	token, tctx := newTokenChain(t)
	commit(token)

	claim := func(s Store, ctx Ctx) (liquid engine.Amount, shares engine.Shares) {
		r := ClaimMigration(s, at(ctx, "hive:alice", genesis+5*engine.HeightsPerDay),
			lc(1_000), lc(9_000), proofs["hive:alice"])
		if !r.OK {
			t.Fatalf("claim: %s", r.Msg)
		}
		return Balance(s, "hive:alice"), SharesOf(s, "hive:alice")
	}

	lLiquid, lShares := claim(legacy, lctx)
	tLiquid, tShares := claim(token, tctx)

	if lLiquid != tLiquid {
		t.Fatalf("liquid differs: legacy %s, token %s", fmtA(lLiquid), fmtA(tLiquid))
	}
	if lShares != tShares {
		t.Fatalf("shares differ: legacy %d, token %d", lShares, tShares)
	}
	if tLiquid != lc(1_000) {
		t.Fatalf("token claim paid %s, want 1,000", fmtA(tLiquid))
	}
	// Everything counted must exist as real tokens: the burn total committed
	// at snapshot, this claim, AND the five days of emission the walk credited
	// to the reward pools on the way. The core holds the pools' share as float
	// until it is paid out, which is why supply exceeds what anyone can spend.
	if want := MigratedSupply(token) + TotalEmitted(token); token.Sup != want {
		t.Fatalf("token supply %s, accounting %s", fmtA(token.Sup), fmtA(want))
	}
	if TotalEmitted(token) != TotalEmitted(legacy) {
		t.Fatalf("emission differs: legacy %s, token %s",
			fmtA(TotalEmitted(legacy)), fmtA(TotalEmitted(token)))
	}
	// And null's burn is a real token balance, readable by any explorer.
	if got := token.TokenBalance(BurnAccount); got != lc(8_000) {
		t.Fatalf("null holds %s in the token, want 8,000", fmtA(got))
	}
}

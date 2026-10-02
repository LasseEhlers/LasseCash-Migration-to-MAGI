package state

import (
	"testing"

	"github.com/lassecash/engine"
)

// THE TEST THAT WOULD HAVE CAUGHT THE 8 SEPTEMBER HANDOVER.
//
// `auditSupply` has run in every contract test since the beginning and never
// saw this, because it runs where the token and the core are the same world.
// The real chain has them as two contracts, and one was adopted three weeks
// after the other. These tests are about the seam between them.
//
// The invariant: the token's total supply must equal
// `sup_migrated + sup_emitted`. If it is short, the contract owes money it
// does not hold, and `credit` refuses — correctly, but only when somebody
// finally asks for more than the float happens to contain. On production that
// was 2 October, three weeks after the leak, on a 7,005,065 claim.

// adoptTokenLate reproduces the handover: value exists on the legacy ledger,
// then a token is adopted and only ACCOUNT BALANCES are moved across.
//
// Everything the contract itself holds — mint principals, pools, the AMM —
// has no `bal_` row, so nothing moves it and nothing mints its backing. That
// is the whole bug, in six lines.
func adoptTokenLate(t *testing.T, legacy *MemStore, accounts ...string) *MemTokenStore {
	t.Helper()
	ts := NewMemTokenStore()
	ts.MemStore = legacy // same core state, now with a token attached
	for _, a := range accounts {
		if !ensureMigrated(ts, ts, a) {
			t.Fatalf("migrate %s", a)
		}
	}
	return ts
}

func TestAdoptingTheTokenLateLeavesTheFloatUnbacked(t *testing.T) {
	s, ctx := newChain(t)

	// Before the token: someone migrates and locks their stake, exactly as
	// the 35 holders did between 31 August and 8 September.
	if r := CreditMigration(s, "hive:alice", lc(1_000), lc(7_000_000)); !r.OK {
		t.Fatalf("migrate: %s", r.Msg)
	}

	ts := adoptTokenLate(t, s, "hive:alice")

	books := MigratedSupply(ts) + getAmount(ts, keyEmitted)
	if got := ts.TokenSupply(); got >= books {
		t.Fatalf("expected the handover to leave a shortfall; books %s, token %s",
			fmtA(books), fmtA(got))
	}
	// Alice's own balance came across — that part worked, and is why this went
	// unnoticed for three weeks. Her 7,000,000 of locked stake did not.
	//
	// The size matters: a small stake is covered by whatever emission has
	// minted into the float since, which is exactly why the small claims on
	// production (andy4475, cinqowy) succeeded and hid the problem.
	if got := Balance(ts, "hive:alice"); got != lc(1_000) {
		t.Fatalf("liquid balance should have migrated: %s", fmtA(got))
	}

	// And now the consequence, which is the bug as the user meets it: the
	// mint matures, the owner claims, and the contract cannot pay.
	ctx.Sender = "hive:alice"
	ctx.Height = genesis + engine.HeightsPerDay*uint64(engine.MigrationMintDays+1)
	if !Accrue(ts, ctx.Height) {
		t.Fatal("accrue")
	}
	if r := ClaimMint(ts, ctx, 1); r.OK {
		t.Fatal("the claim should have been refused: the float is empty")
	}
}

func TestReconcileFloatPaysTheClaimTheHandoverBroke(t *testing.T) {
	s, ctx := newChain(t)
	if r := CreditMigration(s, "hive:alice", lc(1_000), lc(7_000_000)); !r.OK {
		t.Fatalf("migrate: %s", r.Msg)
	}
	ts := adoptTokenLate(t, s, "hive:alice")

	if r := ReconcileFloat(ts); !r.OK {
		t.Fatalf("reconcile: %s", r.Msg)
	}

	// The invariant is restored exactly — not approximately, and not by
	// touching the counters, which were never wrong.
	books := MigratedSupply(ts) + getAmount(ts, keyEmitted)
	if got := ts.TokenSupply(); got != books {
		t.Fatalf("supply %s != books %s", fmtA(got), fmtA(books))
	}

	// Idempotent BY ARITHMETIC, not by a flag: a second run finds nothing to
	// mint. This matters because the real one will be run by hand, under
	// pressure, possibly twice.
	before := ts.TokenSupply()
	if r := ReconcileFloat(ts); !r.OK || r.Msg != "already backed" {
		t.Fatalf("second run should be a no-op: ok=%v msg=%q", r.OK, r.Msg)
	}
	if ts.TokenSupply() != before {
		t.Fatal("a second reconcile minted again")
	}

	// And the claim that could not be paid, is paid.
	ctx.Sender = "hive:alice"
	ctx.Height = genesis + engine.HeightsPerDay*uint64(engine.MigrationMintDays+1)
	if !Accrue(ts, ctx.Height) {
		t.Fatal("accrue")
	}
	if r := ClaimMint(ts, ctx, 1); !r.OK {
		t.Fatalf("claim after reconcile: %s", r.Msg)
	}
	if got := Balance(ts, "hive:alice"); got < lc(7_000_000) {
		t.Fatalf("alice should hold her principal back: %s", fmtA(got))
	}
}

func TestReconcileFloatCannotInventMoney(t *testing.T) {
	// A healthy chain — token adopted from the start — has nothing to fix,
	// and reconciling must not hand the contract free tokens.
	ts, _ := newTokenChain(t)
	if r := CreditMigration(ts, "hive:alice", lc(1_000), 0); !r.OK {
		t.Fatalf("migrate: %s", r.Msg)
	}
	before := ts.TokenSupply()
	if r := ReconcileFloat(ts); !r.OK || r.Msg != "already backed" {
		t.Fatalf("expected a no-op: ok=%v msg=%q", r.OK, r.Msg)
	}
	if ts.TokenSupply() != before {
		t.Fatalf("minted on a healthy chain: %s -> %s", fmtA(before), fmtA(ts.TokenSupply()))
	}
}

// The instrument that watches for the failure must itself be able to see it.
// floatShort is how the late-adoption fuzzer notices a payout refused for want
// of float — a refusal the fuzzer otherwise treats as ordinary and discards.
// Fed the original bug it must fire; fed the repaired chain it must stay zero.
func TestTheFloatShortCounterSeesTheOriginalBugAndOnlyThat(t *testing.T) {
	claim := func(t *testing.T, repair bool) int {
		t.Helper()
		s, ctx := newChain(t)
		if r := CreditMigration(s, "hive:alice", lc(1_000), lc(7_000_000)); !r.OK {
			t.Fatalf("migrate: %s", r.Msg)
		}
		ts := adoptTokenLate(t, s, "hive:alice")
		if repair {
			if r := ReconcileFloat(ts); !r.OK {
				t.Fatalf("reconcile: %s", r.Msg)
			}
		}
		wrapped := countingToken{ts}
		floatShort = 0
		ctx.Sender = "hive:alice"
		ctx.Height = genesis + engine.HeightsPerDay*uint64(engine.MigrationMintDays+1)
		if !Accrue(wrapped, ctx.Height) {
			t.Fatal("accrue")
		}
		ClaimMint(wrapped, ctx, 1)
		return floatShort
	}
	if n := claim(t, false); n == 0 {
		t.Fatal("the counter did not notice a 7,000,000 claim refused for want of float")
	}
	if n := claim(t, true); n != 0 {
		t.Fatalf("the counter fired %d time(s) on a correctly backed chain", n)
	}
}

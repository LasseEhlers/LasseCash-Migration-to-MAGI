package state

import (
	"strings"
	"testing"

	"github.com/lassecash/engine"
)

// THE PUBLIC STATE ABI — FROZEN 2026-08-21.
//
// Once the owner keys are burned, the key layout below is permanent. Future
// dApps derive the governing top-10 by reading these keys out of core state
// with `sdk.ContractStateGet`, and nobody will ever be able to rename them.
//
//	gov/board          "<acct>|<acct>|…"   up to 20 candidate accounts
//	shr/<acct>         "<int64>"           held L-Shares, 1e8-scaled, decimal
//	bal/<acct>         "<int64>"           liquid balance, same encoding
//
// <acct> is the FULLY QUALIFIED address as the SDK renders it — `hive:alice`,
// not `alice` — so a `did:` account can never collide with a Hive one.
//
// A dApp reads the board, reads each candidate's shares, and ranks them with
// `engine.ConsensusGroup` — the same package, imported, not re-implemented.
// 21 bounded reads. The tests below are executable documentation of exactly
// that contract: if any of them fails, the ABI moved, and moving it after
// launch is impossible.

// foreignReader is what a dApp contract has: raw key reads and nothing else.
// It deliberately does NOT use any helper from this package.
type foreignReader struct{ core Store }

func (f foreignReader) read(key string) string {
	v := f.core.Get(key) // stand-in for sdk.ContractStateGet(coreId, key)
	if v == nil {
		return ""
	}
	return *v
}

// top10 is the full derivation a dApp performs.
func (f foreignReader) top10() []engine.Member {
	board := f.read("gov_board")
	if board == "" {
		return nil
	}
	var holders []engine.Holder
	for _, acct := range strings.Split(board, "|") {
		shares := engine.Shares(decI64(f.read("shr_" + acct)))
		holders = append(holders, engine.Holder{Account: acct, Shares: shares})
	}
	return engine.ConsensusGroup(holders)
}

func TestForeignContractCanDeriveTheTop10FromRawKeys(t *testing.T) {
	s, ctx := newChain(t)

	// Fifteen holders with distinct stakes so the ranking is unambiguous,
	// plus one who mints and then fully exits to prove zero-share holders drop.
	names := []string{"hive:a", "hive:b", "hive:c", "hive:d", "hive:e", "hive:f",
		"hive:g", "hive:h", "hive:i", "hive:j", "hive:k", "hive:l", "hive:m",
		"hive:n", "did:pkh:eip155:1:0xabc"}
	for i, n := range names {
		creditLiquid(s, n, lc(int64(1_000*(i+1))))
		if _, r := CreateMint(s, at(ctx, n, genesis), lc(int64(1_000*(i+1))), 365); !r.OK {
			t.Fatalf("%s mint: %s", n, r.Msg)
		}
	}

	want := ConsensusMembers(s)
	got := foreignReader{s}.top10()

	if len(got) != engine.ConsensusSize || len(want) != engine.ConsensusSize {
		t.Fatalf("expected a full group of %d: core=%d foreign=%d",
			engine.ConsensusSize, len(want), len(got))
	}
	for i := range want {
		if got[i].Account != want[i].Account || got[i].Shares != want[i].Shares {
			t.Fatalf("seat %d differs: core=%+v foreign=%+v", i, want[i], got[i])
		}
	}
	// The did: holder has the largest stake and must sit in seat 0 — proving
	// a non-Hive address round-trips through the key layout intact.
	if got[0].Account != "did:pkh:eip155:1:0xabc" {
		t.Errorf("seat 0 is %s; the did: holder has the largest stake", got[0].Account)
	}
}

// The exact key strings and value encodings, pinned as goldens.
func TestPublicKeysAndEncodingsAreFrozen(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(5_000))
	if _, r := CreateMint(s, at(ctx, "hive:alice", genesis), lc(1_234), 365); !r.OK {
		t.Fatal(r.Msg)
	}
	f := foreignReader{s}

	if k := sharesKey("hive:alice"); k != "shr_hive:alice" {
		t.Fatalf("shares key is %q — the ABI says shr/<acct>", k)
	}
	if k := balKey("hive:alice"); k != "bal_hive:alice" {
		t.Fatalf("balance key is %q — the ABI says bal/<acct>", k)
	}
	if keyBoard != "gov_board" {
		t.Fatalf("board key is %q — the ABI says gov/board", keyBoard)
	}

	// Balance: 5000 - 1234 = 3766 LC, as a plain decimal of base units.
	if v := f.read("bal_hive:alice"); v != "376600000000" {
		t.Errorf("balance encodes as %q, want plain decimal base units", v)
	}
	// Shares: a positive plain decimal, nothing else — no sign, no scale suffix.
	v := f.read("shr_hive:alice")
	if v == "" || strings.Trim(v, "0123456789") != "" {
		t.Errorf("shares encode as %q, want an unsigned plain decimal", v)
	}
	if board := f.read("gov_board"); board != "hive:alice" {
		t.Errorf("board with one holder is %q, want the bare account", board)
	}
}

// ALL voting power — governance seats and post votes alike — ends 100% at
// maturity (Lasse, 2026-08-21, superseding the earlier held-shares design).
// The accrual walk retires `shr_` on the maturity day, so a dApp reading shr_
// sees live commitment only: a matured, unclaimed mint votes with NOTHING,
// and a dead account cannot haunt the top-10 after the key burn.
func TestVotingPowerEndsAtMaturity(t *testing.T) {
	w := newWorld(t)
	creditLiquid(w.s, "hive:alice", lc(10_000))
	if _, r := CreateMint(w.s, at(w.ctx, "hive:alice", genesis), lc(10_000), 30); !r.OK {
		t.Fatal(r.Msg)
	}
	if decI64(foreignReader{w.s}.read("shr_hive:alice")) == 0 {
		t.Fatal("live mint must carry voting weight")
	}

	// The day before maturity the seat is intact; once the walk passes the
	// maturity day, it is gone — no claim, no transaction by alice, nothing.
	w.warpDays(t, 29)
	if decI64(foreignReader{w.s}.read("shr_hive:alice")) == 0 {
		t.Error("voting weight vanished before maturity")
	}
	w.warpDays(t, 31)
	if after := decI64(foreignReader{w.s}.read("shr_hive:alice")); after != 0 {
		t.Errorf("matured mint still votes with %d; ALL voting power ends at maturity", after)
	}
	if TotalShares(w.s) != 0 {
		t.Errorf("active shares are %d after the only mint matured; want 0", TotalShares(w.s))
	}
	// The claim, whenever it comes, must not double-release anything.
	if r := ClaimMint(w.s, at(w.ctx, "hive:alice", w.ctx.Height), 1); !r.OK {
		t.Fatalf("claim after retirement: %s", r.Msg)
	}
	if got := decI64(foreignReader{w.s}.read("shr_hive:alice")); got != 0 {
		t.Errorf("shares went negative or reappeared after claim: %d", got)
	}
}

package state

import (
	"testing"

	"github.com/lassecash/engine"
)

// 🔴 LAUNCH BLOCKER — THIS TEST IS EXPECTED TO FAIL UNTIL THE YIELD ACCOUNTING
// IS REWRITTEN. Do not delete it, do not skip it, do not "fix" it by asserting
// the current numbers.
//
// The L-Share yield pool is claimed as `pool * myShares / totalShares` AT THE
// MOMENT OF CLAIMING (see ClaimMint). Nothing records WHEN a mint's shares
// started earning, so a mint that was created seconds ago has exactly the same
// claim on a year of accumulated emission as one that was locked for that year.
//
// The result is that yield is not paid for time locked, it is paid for being
// the last one standing. Measured below: alice and bob lock the same amount for
// the same 30 days, alice first — and bob collects 2.5x what she does.
//
// The standard remedy is an accumulated-reward-per-share checkpoint: the global
// accumulator only ever rises, each mint stores its value at creation, and the
// entitlement is `shares * (accNow - accAtStart)`. That pays exactly the
// emission that occurred while the shares were live. It also gives the natural
// place to STOP accrual at maturity (open question 6), which the current design
// has nowhere to put.
func TestLateMinterDilutesAccruedYield(t *testing.T) {
	const days = 30

	run := func(bobJoins bool) (aliceGot, bobGot engine.Amount) {
		w := newWorld(t)
		creditLiquid(w.s, "alice", lc(10_000))
		creditLiquid(w.s, "bob", lc(10_000))

		aliceID, r := CreateMint(w.s, at(w.ctx, "alice", genesis), lc(10_000), days)
		if !r.OK {
			t.Fatal(r.Msg)
		}

		// Alice's mint runs its full course as the ONLY mint in existence.
		maturity := genesis + days*day
		w.warp(t, maturity)

		var bobID uint64
		if bobJoins {
			// Bob mints the same amount at the very moment alice matures,
			// having been locked for exactly zero blocks.
			bobID, r = CreateMint(w.s, at(w.ctx, "bob", maturity), lc(10_000), days)
			if !r.OK {
				t.Fatal(r.Msg)
			}
		}

		before := Balance(w.s, "alice")
		if r := ClaimMint(w.s, at(w.ctx, "alice", maturity), aliceID); !r.OK {
			t.Fatal(r.Msg)
		}
		aliceGot = Balance(w.s, "alice") - before

		if bobJoins {
			bobMaturity := maturity + days*day
			w.warp(t, bobMaturity)
			before = Balance(w.s, "bob")
			ClaimMint(w.s, at(w.ctx, "bob", bobMaturity), bobID)
			bobGot = Balance(w.s, "bob") - before
		}
		return
	}

	aliceAlone, _ := run(false)
	aliceWithBob, bobGot := run(true)

	t.Logf("alice mints alone, matures, claims:            %s", fmtA(aliceAlone))
	t.Logf("same but bob mints as she matures, then claims: %s", fmtA(aliceWithBob))
	t.Logf("bob receives:                                   %s", fmtA(bobGot))

	if aliceWithBob < aliceAlone {
		t.Errorf("\nALICE WAS DILUTED: %s -> %s, losing %s to a minter who\n"+
			"arrived after every one of those tokens had already accrued.",
			fmtA(aliceAlone), fmtA(aliceWithBob), fmtA(aliceAlone-aliceWithBob))
	}
}

// A monthly Proof-of-Brain mint must be indistinguishable from a capital mint
// once created — same accumulator stamp, same expiry scheduling, same yield.
//
// THE FIRST WASM SHIPPED THIS BUG: pob.go carried its own copy of the mint
// registration tail, so the accrual rewrite never reached it. A PoB mint's
// AccStart stayed 0 — entitling it to the ENTIRE accumulator history since
// genesis — and its shares never left the active denominator at maturity,
// diluting every live minter forever. Both paths now share registerMint();
// this test exists so a third path can never quietly appear.
func TestPoBMintEarnsExactlyLikeACapitalMint(t *testing.T) {
	const days = 30

	w := newWorld(t)
	// A year of history accrues first, held by an unrelated whale. If a later
	// mint's AccStart were unstamped, THIS is the emission it would steal.
	creditLiquid(w.s, "hive:whale", lc(1_000_000))
	// dave's stake is credited now too — migration closes once emission starts —
	// but sits liquid, earning nothing, until he mints a year later.
	creditLiquid(w.s, "hive:dave", lc(1_000))
	CreateMint(w.s, at(w.ctx, "hive:whale", genesis), lc(1_000_000), 1095)
	oneYear := genesis + 365*day
	w.warp(t, oneYear)

	// carol earns a PoB reward; dave capital-mints the identical amount at the
	// identical moment for the identical duration.
	SetMintDuration(w.s, at(w.ctx, "hive:carol", oneYear), days)
	accruePending(w.s, "hive:carol", lc(1_000), 1)
	// The monthly mint fires when the calendar month turns, so the settling
	// context carries a LATER epoch than the one the earnings anchored.
	nextMonth := Ctx{Sender: "hive:carol", Height: oneYear + 1, Epoch: 2}
	if r := SettlePending(w.s, nextMonth, "hive:carol"); !r.OK {
		t.Fatalf("pob mint: %s", r.Msg)
	}
	if PendingOf(w.s, "hive:carol") != 0 {
		t.Fatal("pending balance did not convert into a mint")
	}
	if _, r := CreateMint(w.s, at(w.ctx, "hive:dave", oneYear+1), lc(1_000), days); !r.OK {
		t.Fatalf("capital mint: %s", r.Msg)
	}

	// Same commitment, same moment — the two must mature worth the same.
	both := oneYear + 1 + (days+1)*day
	w.warp(t, both)
	carol := PendingYield(w.s, "hive:carol", 1)
	dave := PendingYield(w.s, "hive:dave", 1)

	if carol == 0 || dave == 0 {
		t.Fatalf("a mint earned nothing: carol=%s dave=%s", fmtA(carol), fmtA(dave))
	}
	if carol != dave {
		t.Errorf("identical commitments earned differently: pob=%s capital=%s.\n"+
			"If pob is larger, its AccStart was never stamped and it is claiming\n"+
			"emission from before it existed.", fmtA(carol), fmtA(dave))
	}
	// And a year of the whale's history must dwarf both — nobody stole it.
	whale := PendingYield(w.s, "hive:whale", 1)
	if whale < carol*100 {
		t.Errorf("the whale's year of accrual (%s) is implausibly small next to a "+
			"30-day newcomer (%s) — history leaked to a latecomer", fmtA(whale), fmtA(carol))
	}
}

// Minting against a stale accumulator is REFUSED, not tolerated.
//
// Measured on the real chain: letting mint absorb a 1200-day catch-up walk
// cost 5.85B gas — 200x a normal call — charged to whichever user happened to
// transact first after a silence. Worse, a mint stamped mid-lag joins the
// share denominator for days that predate it, reopening the late-minter
// dilution in miniature. So the mint fails fast, the caller runs the
// permissionless `advance`, and the retry is cheap.
func TestMintIsRefusedWhileAccrualIsBehind(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(10_000))

	// Far beyond what one bounded walk can cover, with nothing settled between.
	far := genesis + (MaxAccrualDays+100)*uint64(engine.HeightsPerDay)
	if _, r := CreateMint(s, at(ctx, "hive:alice", far), lc(10_000), 30); r.OK {
		t.Fatal("mint succeeded against a stale accumulator; it must refuse")
	}

	AccrueFully(s, far) // what `advance` calls do
	if _, r := CreateMint(s, at(ctx, "hive:alice", far), lc(10_000), 30); !r.OK {
		t.Fatalf("mint still refused after accrual caught up: %s", r.Msg)
	}
}

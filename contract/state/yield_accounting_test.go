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

		// Claim the day AFTER maturity, once the walk has closed that day and
		// written its accAt_<matDay> checkpoint — claiming exactly ON the
		// maturity day is refused (see the ClaimMint fix, 2026-08-23), because
		// day matDay's emission is genuinely still being divided among
		// whoever is active THAT day: a mint created within the same day as
		// Alice's maturity would fairly co-share that one day's pot (bounded,
		// tiny, and consistent with day-granular accrual, not the bug this
		// test exists to catch). Bob is created AFTER the checkpoint closes
		// instead, which isolates the actual question: can a later minter
		// reach back into an ALREADY-WRITTEN checkpoint and dilute it. He
		// cannot — accAt_<matDay> is immutable once written.
		afterClose := maturity + day

		var bobID uint64
		if bobJoins {
			bobID, r = CreateMint(w.s, at(w.ctx, "bob", afterClose), lc(10_000), days)
			if !r.OK {
				t.Fatal(r.Msg)
			}
		}

		before := Balance(w.s, "alice")
		if r := ClaimMint(w.s, at(w.ctx, "alice", afterClose), aliceID); !r.OK {
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

// TestSameDayClaimIsRefusedNotWrong pins the fix for the maturity-day
// concentration bug found by review on 2026-08-23.
//
// The accumulator only checkpoints a day once the walk has fully closed it.
// Claiming exactly ON the maturity day used to fall back to a LIVE reading
// that excluded that day's own emission — while ALSO removing the claimant's
// shares from shares_total immediately, so the day's remaining emission
// divided across whoever was left. On a day where thousands of mints mature
// together (the migration cliff), an unrelated mint that simply did not
// claim that day could pick up the ENTIRE day's L-Share emission: measured,
// 50 x 200,000 LC claiming together handed one unrelated 200 LC mint 100.0%
// of that day's emission, 11x its own principal.
//
// The fix refuses a claim until the day has closed, so every claim reads the
// SAME checkpoint no matter when it is made.
func TestSameDayClaimIsRefusedNotWrong(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(10_000))
	id, r := CreateMint(s, at(ctx, "hive:alice", genesis), lc(10_000), 30)
	if !r.OK {
		t.Fatal(r.Msg)
	}
	mature := genesis + 30*day

	// Refused exactly on the maturity day — never a silent wrong answer.
	if r := ClaimMint(s, at(ctx, "hive:alice", mature), id); r.OK {
		t.Fatal("claim on the maturity day itself should be refused, not silently accepted")
	}
	// One height before the day closes: still refused.
	if r := ClaimMint(s, at(ctx, "hive:alice", mature+day-1), id); r.OK {
		t.Fatal("claim one height before the day closes should still be refused")
	}
	// The moment the day closes: succeeds.
	if r := ClaimMint(s, at(ctx, "hive:alice", mature+day), id); !r.OK {
		t.Fatalf("claim once the day has closed should succeed: %s", r.Msg)
	}
}

// TestMaturityCohortSharesTheDayEqually is the direct regression for the
// concentration scenario: many mints maturing on the SAME day, one that does
// not claim that day at all, must not be able to capture a disproportionate
// share of that day's emission just because everyone else claimed promptly
// (and promptness is no longer possible mid-day — see the test above — but
// this pins the OUTCOME once the day closes and everyone claims in any order).
func TestMaturityCohortSharesTheDayEqually(t *testing.T) {
	s, ctx := newChain(t)

	// Fifty equal mints maturing together — the migration-cliff shape.
	var ids []uint64
	for i := 0; i < 50; i++ {
		acct := "hive:cohort" + fmtA(engine.Amount(i))
		creditLiquid(s, acct, lc(200_000))
		id, r := CreateMint(s, at(ctx, acct, genesis), lc(200_000), 30)
		if !r.OK {
			t.Fatalf("cohort mint %d: %s", i, r.Msg)
		}
		ids = append(ids, id)
	}
	// One small, unrelated mint on a DIFFERENT schedule, still active through
	// the cohort's maturity day.
	creditLiquid(s, "hive:bystander", lc(200))
	if _, r := CreateMint(s, at(ctx, "hive:bystander", genesis), lc(200), 60); !r.OK {
		t.Fatal(r.Msg)
	}

	mature := genesis + 30*day
	afterClose := mature + day

	cohortBefore := Balance(s, "hive:cohort0")
	var cohortReceived engine.Amount
	// The cohort claims first, in order, all AFTER the day has closed.
	for i, id := range ids {
		acct := "hive:cohort" + fmtA(engine.Amount(i))
		before := Balance(s, acct)
		if r := ClaimMint(s, at(ctx, acct, afterClose), id); !r.OK {
			t.Fatalf("cohort claim %d: %s", i, r.Msg)
		}
		cohortReceived += Balance(s, acct) - before
	}
	// The bystander did not act at all that day, and never claims here —
	// this checks what it would be OWED, not what it collects.
	Accrue(s, afterClose+day)
	bystanderEntitled := PendingYield(s, "hive:bystander", 1)

	// The bug's signature: a ~0.002% shareholder (200 of 10,000,200 LC)
	// capturing a share of emission wildly out of proportion to that weight —
	// in the worst measured case, 100% of an entire day belonging to the
	// cohort. A fair system pays the bystander roughly its share-weight
	// fraction of what the cohort collectively earned; this asserts it is
	// nowhere close to comparable, let alone larger.
	shareRatio := float64(lc(200)) / float64(lc(200)+10_000_000_00000000)
	maxFair := engine.Amount(float64(cohortReceived) * shareRatio * 20) // 20x slack
	if bystanderEntitled > maxFair {
		t.Fatalf("CONCENTRATION: a 200 LC bystander (share of pool ~%.4f%%) is "+
			"entitled to %s while the 10,000,000 LC cohort collectively received "+
			"%s. That is wildly disproportionate — the bystander should earn "+
			"roughly its share-weight fraction, not something comparable to an "+
			"entire cohort's day.", shareRatio*100, fmtA(bystanderEntitled), fmtA(cohortReceived))
	}
	_ = cohortBefore
}

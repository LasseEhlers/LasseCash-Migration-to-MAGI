package state

import (
	"testing"

	"github.com/lassecash/engine"
)

// The whole 75-year emission life, lived end to end.
//
// Every number in CLAUDE.md's emission table was verified formula-by-formula;
// this instead runs the chain itself across the entire span and checks the
// destination: emission ends in year 75, the lifetime total lands on exactly
// 19,999,994.01840000 LC, the 51M hardcap survives with the migration on top,
// and the recycling engine still pays after emission is over.
func TestSeventyFiveYearRun(t *testing.T) {
	w := newWorld(t)

	// The full recommended migration, as one holder for simplicity.
	migrated := engine.Amount(1_906_873_606_104_624) // 19,068,736.06104624 LC
	if r := creditLiquid(w.s, "hive:world", migrated); !r.OK {
		t.Fatal(r.Msg)
	}
	// A perpetual staker so emission always has somewhere to go.
	if _, r := CreateMint(w.s, at(w.ctx, "hive:world", genesis), lc(1_000_000), 1095); !r.OK {
		t.Fatal(r.Msg)
	}

	// Walk to year 80 in one-year strides (the walk is capped per call, so
	// AccrueFully loops it like `advance` would).
	for y := 1; y <= 80; y++ {
		w.warpDays(t, uint64(y)*365)
	}

	total := TotalEmitted(w.s)
	const want = engine.Amount(1_999_999_401_840_000) // 19,999,994.01840000 LC
	if total != want {
		t.Errorf("lifetime emission is %s, spec says exactly 19,999,994.01840000", fmtA(total))
	}

	// Emission is genuinely OVER: another decade must add nothing.
	w.warpDays(t, 90*365)
	if TotalEmitted(w.s) != total {
		t.Errorf("emission continued after year 75: %s -> %s", fmtA(total), fmtA(TotalEmitted(w.s)))
	}

	// Hardcap arithmetic on the real ledger, not on paper.
	if maxEver := MigratedSupply(w.s) + TotalEmitted(w.s); maxEver > engine.LC(51_000_000) {
		t.Errorf("HARDCAP BREACHED: %s > 51,000,000", fmtA(maxEver))
	}

	// The recycling engine outlives emission. Two cases, both mandatory:
	//
	// 1. Value recycled while NOBODY is actively minting is held, not lost.
	//    (The bucket already carries every year of emission since the lone
	//    mint matured in year 3 — held-not-lost applies to emission too, and
	//    the first minters to return inherit the whole backlog. Deliberate:
	//    it is the strongest possible incentive to restart minting after a
	//    dead spell, and the alternative is stranding it forever.)
	heldBefore := getAmount(w.s, keyAccHeld)
	Recycle(w.s, lc(10_000))
	if getAmount(w.s, keyAccHeld) != heldBefore+lc(10_000) {
		t.Fatalf("recycled with no active minters: held went %s -> %s, want +10,000",
			fmtA(heldBefore), fmtA(getAmount(w.s, keyAccHeld)))
	}

	// 2. The moment a minter exists again, the held value must flow to them.
	//    Year-90 minting must work — and must unlock what was waiting.
	accBefore := AccPerShare(w.s)
	if _, r := CreateMint(w.s, at(w.ctx, "hive:world", w.ctx.Height), lc(50_000), 365); !r.OK {
		t.Fatalf("minting after emission ended must still work: %s", r.Msg)
	}
	w.warpDays(t, 90*365+10)
	if AccPerShare(w.s) <= accBefore {
		t.Error("held recycled value was never distributed once a minter " +
			"existed — the post-emission reward engine is dead")
	}
	if held := getAmount(w.s, keyAccHeld); held > lc(1) {
		t.Errorf("%s still stranded in the held bucket", fmtA(held))
	}
}

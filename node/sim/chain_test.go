package sim

import (
	"strings"
	"testing"
	"time"

	"github.com/lassecash/engine"
)

const genesis = uint64(109_200_000)

func newSim(t *testing.T) *Chain {
	t.Helper()
	c, err := New(genesis, time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	return c
}

func mustTx(t *testing.T, c *Chain, sender, ep, args string) Result {
	t.Helper()
	r := c.Submit(sender, ep, args)
	if !r.OK {
		t.Fatalf("%s %s(%s): %s", sender, ep, args, r.Msg)
	}
	return r
}

// The simulator must reject exactly what the contract rejects — it is the same
// code. If this ever diverges, the frontend is being lied to.
func TestSimulatorEnforcesContractRules(t *testing.T) {
	c := newSim(t)
	mustTx(t, c, "system", "migrate", "hive:alice|100000000000|0")

	bad := []struct{ sender, ep, args, why string }{
		{"hive:alice", "transfer", "hive:bob|999900000000000", "overdraft"},
		{"hive:alice", "mint", "100000000000|1096", "over the 3-year maximum"},
		{"hive:alice", "mint", "100000000000|0", "zero days"},
		{"hive:bob", "claim_mint", "1", "claiming a mint that does not exist"},
		{"hive:alice", "post", "x|0", "posting with no L-Shares"},
		{"hive:alice", "set_param", "attacker.backdoor|1", "unknown parameter"},
		{"hive:alice", "nonsense", "", "unknown entrypoint"},
	}
	for _, b := range bad {
		if r := c.Submit(b.sender, b.ep, b.args); r.OK {
			t.Fatalf("%s was accepted: %s %s", b.why, b.ep, b.args)
		}
	}
}

// Advancing the clock must credit emission, and only once per height.
func TestAdvanceEmitsOnceAndOnlyForward(t *testing.T) {
	c := newSim(t)
	if got := c.Info().TotalEmitted; got != "0.00000000" {
		t.Fatalf("emitted %s before any time passed", got)
	}

	c.AdvanceDays(1)
	after1 := c.Info().TotalEmitted
	if after1 == "0.00000000" {
		t.Fatal("a day passed and nothing was emitted")
	}

	// Settling again at the same height must add nothing.
	mustTx(t, c, "hive:anyone", "settle", "")
	if c.Info().TotalEmitted != after1 {
		t.Fatal("settling twice at one height emitted twice")
	}

	c.AdvanceDays(1)
	if c.Info().TotalEmitted == after1 {
		t.Fatal("a second day emitted nothing")
	}
}

// Month epochs must be real calendar months, not a drifting 30-day cycle —
// that is the whole reason the monthly mint lands on "the 1st".
func TestEpochFollowsTheCalendar(t *testing.T) {
	c := newSim(t)
	start := c.Info().Epoch

	// 20 August + 20 days = 9 September: one month boundary crossed.
	c.AdvanceDays(20)
	if got := c.Info().Epoch; got != start+1 {
		t.Fatalf("epoch %d after crossing into September, want %d", got, start+1)
	}
	// A full year must advance exactly twelve.
	c.AdvanceDays(365)
	if got := c.Info().Epoch; got != start+13 {
		t.Fatalf("epoch %d after a year and a bit, want %d", got, start+13)
	}
}

// The headline: a complete user journey through the simulator.
func TestFullLifecycleThroughTheSimulator(t *testing.T) {
	c := newSim(t)
	mustTx(t, c, "system", "migrate", "hive:alice|1000000000000|0") // 10,000 LC
	mustTx(t, c, "system", "migrate", "hive:bob|1000000000000|0")

	// Mint, and shares appear.
	mustTx(t, c, "hive:alice", "mint", "500000000000|365")
	acct := c.Account("hive:alice")
	if len(acct.Mints) != 1 || acct.Shares == "0.00000000" {
		t.Fatalf("mint did not register: %+v", acct)
	}
	if acct.Balance != "5000.00000000" {
		t.Fatalf("balance %s after locking half, want 5000", acct.Balance)
	}

	// Open the pool at the measured market ratio and swap through it.
	mustTx(t, c, "hive:bob", "mint", "100000000000|365") // bob needs shares to post later
	mustTx(t, c, "hive:alice", "add_liquidity", "100000000000|103000000")
	before := c.Info()
	mustTx(t, c, "hive:bob", "swap_lc_hbd", "10000000000|0")
	after := c.Info()
	if after.AmmLC == before.AmmLC || after.AmmHBD == before.AmmHBD {
		t.Fatal("swap did not move the reserves")
	}

	// Publish, curate, pay out.
	mustTx(t, c, "hive:bob", "post", "hello-world|0")
	mustTx(t, c, "hive:alice", "vote", "hive:bob|hello-world|100")
	c.AdvanceDays(8) // past the 7-day viral window
	mustTx(t, c, "hive:anyone", "payout", "hive:bob|hello-world")
	mustTx(t, c, "hive:alice", "claim_curation", "hive:bob|hello-world")

	if c.Account("hive:bob").Pending == "0.00000000" {
		t.Fatal("author accrued no pending rewards")
	}
	if c.Account("hive:alice").Pending == "0.00000000" {
		t.Fatal("curator accrued no pending rewards")
	}

	// Cross a month boundary and the pending balance becomes ONE mint.
	mintsBefore := len(c.Account("hive:bob").Mints)
	c.AdvanceDays(31)
	mustTx(t, c, "hive:bob", "settle_pending", "")
	acctBob := c.Account("hive:bob")
	if len(acctBob.Mints) != mintsBefore+1 {
		t.Fatalf("monthly settle produced %d new mints, want 1",
			len(acctBob.Mints)-mintsBefore)
	}
	if acctBob.Pending != "0.00000000" {
		t.Fatalf("pending not drained: %s", acctBob.Pending)
	}

	// Ride the mint to maturity and claim it.
	c.AdvanceDays(365)
	mustTx(t, c, "hive:alice", "claim_mint", "1")
	if c.Account("hive:alice").Mints[len(c.Account("hive:alice").Mints)-1].Ended != true {
		t.Fatal("claimed mint not marked ended")
	}
}

// Amounts must cross the wire as strings — JavaScript's Number cannot hold
// 51,000,000 LASSECASH in base units without losing precision.
func TestAmountsAreDecimalStrings(t *testing.T) {
	c := newSim(t)
	mustTx(t, c, "system", "migrate", "hive:whale|3100000000000000|0") // 31,000,000 LC

	info := c.Info()
	if !strings.Contains(info.MigratedSupply, ".") {
		t.Fatalf("migrated supply %q is not a decimal string", info.MigratedSupply)
	}
	if info.MigratedSupply != "31000000.00000000" {
		t.Fatalf("migrated supply %q, want 31000000.00000000", info.MigratedSupply)
	}
	// Eight decimal places, always — a trimmed string would round-trip wrong.
	frac := strings.Split(c.Account("hive:whale").Balance, ".")[1]
	if len(frac) != engine.Decimals {
		t.Fatalf("balance has %d decimal places, want %d", len(frac), engine.Decimals)
	}
}

// The simulator must never invent supply.
func TestSimulatorRespectsTheHardcap(t *testing.T) {
	c := newSim(t)
	mustTx(t, c, "system", "migrate", "hive:a|1900000000000000|0") // 19M
	if r := c.Submit("system", "migrate", "hive:b|1300000000000000|0"); r.OK {
		t.Fatal("migration breaching the 51M hardcap was accepted")
	}
}

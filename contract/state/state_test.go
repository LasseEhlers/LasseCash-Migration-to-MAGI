package state

import (
	"strconv"
	"strings"
	"testing"

	"github.com/lassecash/engine"
)

const genesis = uint64(109_200_000)

func lc(n int64) engine.Amount { return engine.LC(n) }

func fmtA(a engine.Amount) string {
	neg := ""
	v := int64(a)
	if v < 0 {
		neg, v = "-", -v
	}
	return neg + strconv.FormatInt(v/engine.Unit, 10) + "." +
		strings.Repeat("0", 8-len(strconv.FormatInt(v%engine.Unit, 10))) +
		strconv.FormatInt(v%engine.Unit, 10)
}

// newChain returns an initialised store plus a context at genesis.
func newChain(t *testing.T) (*MemStore, Ctx) {
	t.Helper()
	s := NewMemStore()
	if r := Init(s, genesis); !r.OK {
		t.Fatalf("init failed: %s", r.Msg)
	}
	return s, Ctx{Height: genesis, Epoch: 1}
}

func at(ctx Ctx, sender string, height uint64) Ctx {
	ctx.Sender = sender
	ctx.Height = height
	return ctx
}

// --- the global conservation invariant ------------------------------------

// auditSupply sums every place value can live and checks it against what the
// chain says it has issued. If these disagree, tokens were created or lost.
func auditSupply(t *testing.T, s *MemStore) {
	t.Helper()
	var held engine.Amount
	for _, k := range s.Keys() {
		switch {
		case strings.HasPrefix(k, "bal_"):
			held += getAmount(s, k)
		case strings.HasPrefix(k, "pool_"):
			held += getAmount(s, k)
		case k == keyPoolLC:
			// The AMM's LASSECASH reserve is real supply the pool custodies.
			// (amm/hbd is deliberately NOT counted — that side is HBD.)
			held += getAmount(s, k)
		case strings.HasPrefix(k, "pend_"):
			held += decodePending(*s.Get(k)).Balance
		case strings.HasPrefix(k, "mint_"):
			// mint_<acct>_<id>: the id is digits, so the owner is everything
			// between the prefix and the LAST underscore.
			trimmed := strings.TrimPrefix(k, "mint_")
			owner := trimmed[:strings.LastIndex(trimmed, "_")]
			m, ok := decodeMint(owner, *s.Get(k))
			if ok && !m.Ended {
				held += m.Principal
			}
		case strings.HasPrefix(k, "post_"):
			p, ok := decodePost(*s.Get(k))
			if ok {
				held += p.CuratorPot // parked, awaiting curator claims
			}
		}
	}

	// Burned value is NOT subtracted: burning credits the null account (see
	// BurnAccount), so it stays inside total supply — visibly quarantined in
	// `bal_hive:null`, which the balance sweep above already counted.
	issued := MigratedSupply(s) + TotalEmitted(s)
	if held != issued {
		t.Fatalf("SUPPLY LEAK: held %s but issued %s (difference %s)",
			fmtA(held), fmtA(issued), fmtA(held-issued))
	}
	if issued > engine.HistoricHardCap {
		t.Fatalf("HARDCAP BREACH: issued %s exceeds %s",
			fmtA(issued), fmtA(engine.HistoricHardCap))
	}
}

// --- init & migration -----------------------------------------------------

func TestInitIsOnceOnly(t *testing.T) {
	s := NewMemStore()
	if r := Init(s, 0); r.OK {
		t.Fatal("genesis height 0 should be refused")
	}
	if r := Init(s, genesis); !r.OK {
		t.Fatalf("init failed: %s", r.Msg)
	}
	if r := Init(s, genesis+1); r.OK {
		t.Fatal("re-init should be refused — genesis must be immutable")
	}
	if GenesisHeight(s) != genesis {
		t.Fatalf("genesis moved to %d", GenesisHeight(s))
	}
}

func TestMigrationEnforcesHardcap(t *testing.T) {
	s, _ := newChain(t)

	// The real 12-month snapshot figure fits comfortably.
	if r := creditLiquid(s, "hive:lasseehlers", lc(19_068_736)); !r.OK {
		t.Fatalf("real snapshot total rejected: %s", r.Msg)
	}
	auditSupply(t, s)

	// migrated + 20M emission cap must stay under 51M, so 31M is the ceiling.
	if r := creditLiquid(s, "hive:whale", lc(12_000_000)); r.OK {
		t.Fatal("credit breaching the 51M hardcap was accepted")
	}
	// Just under the line is fine.
	if r := creditLiquid(s, "hive:ok", lc(11_900_000)); !r.OK {
		t.Fatalf("in-bounds credit rejected: %s", r.Msg)
	}
	auditSupply(t, s)

	if r := creditLiquid(s, "hive:x", 0); r.OK {
		t.Fatal("zero credit accepted")
	}
	if r := creditLiquid(s, "hive:x", -1); r.OK {
		t.Fatal("negative credit accepted")
	}
}

// Migration must close once emission starts, or supply could appear later.
func TestMigrationClosesAfterEmissionStarts(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:a", lc(1_000))
	Settle(s, at(ctx, "hive:a", genesis+engine.HeightsPerDay))
	if r := creditLiquid(s, "hive:b", lc(1_000)); r.OK {
		t.Fatal("migration credit accepted after emission started")
	}
}

// --- transfers ------------------------------------------------------------

func TestTransferCannotOverdrawOrForge(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(100))
	a := at(ctx, "hive:alice", genesis)

	if r := Transfer(s, a, "hive:bob", lc(150)); r.OK {
		t.Fatal("overdraft accepted")
	}
	if r := Transfer(s, a, "hive:bob", -lc(50)); r.OK {
		t.Fatal("negative transfer accepted — would be theft in reverse")
	}
	if r := Transfer(s, a, "hive:alice", lc(10)); r.OK {
		t.Fatal("self-transfer accepted")
	}
	if r := Transfer(s, a, "", lc(10)); r.OK {
		t.Fatal("transfer to empty account accepted")
	}
	if r := Transfer(s, a, "hive:bob", lc(40)); !r.OK {
		t.Fatalf("valid transfer rejected: %s", r.Msg)
	}
	if got := Balance(s, "hive:alice"); got != lc(60) {
		t.Fatalf("alice has %s, want 60", fmtA(got))
	}
	if got := Balance(s, "hive:bob"); got != lc(40) {
		t.Fatalf("bob has %s, want 40", fmtA(got))
	}
	auditSupply(t, s)
}

// --- emission -------------------------------------------------------------

// Settling in many small steps must equal settling once, exactly. An idle
// chain must not mint a different amount than a busy one.
func TestSettleIsPathIndependent(t *testing.T) {
	target := genesis + 5*engine.HeightsPerDay

	one := NewMemStore()
	Init(one, genesis)
	Settle(one, Ctx{Height: target})

	many := NewMemStore()
	Init(many, genesis)
	for h := genesis + 1000; h <= target; h += 1000 {
		Settle(many, Ctx{Height: h})
	}

	if TotalEmitted(one) != TotalEmitted(many) {
		t.Fatalf("one-shot emitted %s but stepwise emitted %s",
			fmtA(TotalEmitted(one)), fmtA(TotalEmitted(many)))
	}
	// And the three pools must match too, not just the total.
	for _, k := range []string{keyPoolLShare, keyPoolViral, keyPoolDeep, keyPoolLiquidity} {
		if getAmount(one, k) != getAmount(many, k) {
			t.Fatalf("%s differs: %s vs %s", k,
				fmtA(getAmount(one, k)), fmtA(getAmount(many, k)))
		}
	}
	auditSupply(t, one)
	auditSupply(t, many)
}

func TestSettleIsIdempotentAndNeverGoesBackwards(t *testing.T) {
	s, _ := newChain(t)
	h := genesis + engine.HeightsPerDay
	Settle(s, Ctx{Height: h})
	first := TotalEmitted(s)

	Settle(s, Ctx{Height: h})
	if TotalEmitted(s) != first {
		t.Fatal("settling the same height twice emitted twice")
	}
	Settle(s, Ctx{Height: h - 1000})
	if TotalEmitted(s) != first {
		t.Fatal("settling a past height emitted more")
	}
	if SettledHeight(s) != h {
		t.Fatalf("watermark moved backwards to %d", SettledHeight(s))
	}
}

func TestEmissionSplitsFiftyTwentyfiveTwentyfive(t *testing.T) {
	s, _ := newChain(t)
	Settle(s, Ctx{Height: genesis + 30*engine.HeightsPerDay})

	emitted := TotalEmitted(s)
	lshare := PoolLShare(s)
	viral := PoolViral(s)
	deep := PoolDeep(s)
	liq := getAmount(s, keyPoolLiquidity)

	if lshare+viral+deep+liq != emitted {
		t.Fatalf("pools total %s but %s was emitted",
			fmtA(lshare+viral+deep+liq), fmtA(emitted))
	}
	pob := viral + deep
	// PoB is 50%, L-Share and liquidity 25% each (PoB absorbs rounding dust).
	if pob < lshare || pob < liq {
		t.Fatalf("PoB %s should be the largest slice", fmtA(pob))
	}
	if deep <= viral {
		t.Fatalf("deep %s should exceed viral %s (75/25)", fmtA(deep), fmtA(viral))
	}
	t.Logf("30 days: emitted %s -> lshare %s viral %s deep %s liquidity %s",
		fmtA(emitted), fmtA(lshare), fmtA(viral), fmtA(deep), fmtA(liq))
}

// --- minting --------------------------------------------------------------

func TestMintLocksPrincipalAndGrantsShares(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(100_000))
	a := at(ctx, "hive:alice", genesis)

	id, r := CreateMint(s, a, lc(100_000), 1095)
	if !r.OK {
		t.Fatalf("mint failed: %s", r.Msg)
	}
	if Balance(s, "hive:alice") != 0 {
		t.Fatalf("principal not debited, balance %s", fmtA(Balance(s, "hive:alice")))
	}
	// Max size and max duration is the 2.25x case: 100k / 1.0 rate * 2.25.
	if got := SharesOf(s, "hive:alice"); got != engine.Shares(lc(225_000)) {
		t.Fatalf("shares %s, want 225000 (2.25x)", fmtA(engine.Amount(got)))
	}
	if TotalShares(s) != SharesOf(s, "hive:alice") {
		t.Fatal("network total disagrees with the only holder")
	}

	m, found := GetMint(s, "hive:alice", id)
	if !found || m.Principal != lc(100_000) || m.Days != 1095 {
		t.Fatalf("mint record wrong: %+v", m)
	}
	auditSupply(t, s)
}

func TestMintRejectsBadInput(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(1_000))
	a := at(ctx, "hive:alice", genesis)

	for _, c := range []struct {
		amt  engine.Amount
		days int64
		why  string
	}{
		{lc(1), 0, "zero days"},
		{lc(1), -1, "negative days"},
		{lc(1), 1096, "over three years"},
		{lc(5_000), 365, "more than the balance"},
		{engine.MinMintAmount - 1, 365, "below minimum mint"},
		{0, 365, "zero principal"},
		{-lc(1), 365, "negative principal"},
	} {
		if _, r := CreateMint(s, a, c.amt, c.days); r.OK {
			t.Fatalf("%s was accepted", c.why)
		}
	}
	if Balance(s, "hive:alice") != lc(1_000) {
		t.Fatal("a rejected mint moved the balance")
	}
}

// Claiming at maturity returns principal plus the account's yield share.
func TestClaimAtMaturityPaysPrincipalPlusYield(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(10_000))
	a := at(ctx, "hive:alice", genesis)

	id, r := CreateMint(s, a, lc(10_000), 365)
	if !r.OK {
		t.Fatalf("mint failed: %s", r.Msg)
	}
	mature := genesis + 365*engine.HeightsPerDay
	// Claim the day AFTER maturity, not on it: claiming exactly on the
	// maturity day is refused until the walk closes that day, so every
	// claim reads the same checkpoint regardless of when it is made.
	afterClose := mature + engine.HeightsPerDay
	if r := ClaimMint(s, at(ctx, "hive:alice", afterClose), id); !r.OK {
		t.Fatalf("claim failed: %s", r.Msg)
	}

	got := Balance(s, "hive:alice")
	if got <= lc(10_000) {
		t.Fatalf("claimed %s, expected principal plus yield", fmtA(got))
	}
	if SharesOf(s, "hive:alice") != 0 {
		t.Fatal("shares not released after claim")
	}
	if TotalShares(s) != 0 {
		t.Fatal("network share total not reduced")
	}
	t.Logf("10,000 locked 365d -> claimed %s", fmtA(got))
	auditSupply(t, s)
}

// Ending on day one recovers half the principal and forfeits all yield.
func TestEarlyEndSlashesHalfAndForfeitsYield(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(10_000))
	a := at(ctx, "hive:alice", genesis)
	id, _ := CreateMint(s, a, lc(10_000), 1095)

	// Let a month of emission accrue so there IS yield to forfeit.
	Settle(s, Ctx{Height: genesis + 30*engine.HeightsPerDay})
	poolBefore := PoolLShare(s)

	if r := ClaimMint(s, at(ctx, "hive:alice", genesis+1), id); !r.OK {
		t.Fatalf("early end failed: %s", r.Msg)
	}

	got := Balance(s, "hive:alice")
	// ~50% of principal at day 0, and nothing from the pool.
	if got > lc(5_001) || got < lc(4_999) {
		t.Fatalf("recovered %s, want ~5,000 (50%%)", fmtA(got))
	}
	if PoolLShare(s) <= poolBefore-got {
		// The slashed half must have swept back into the pool.
		t.Fatalf("pool %s did not absorb the slash (was %s)",
			fmtA(PoolLShare(s)), fmtA(poolBefore))
	}
	auditSupply(t, s)
}

func TestMintCannotBeClaimedTwice(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(1_000))
	a := at(ctx, "hive:alice", genesis)
	id, _ := CreateMint(s, a, lc(1_000), 30)

	mature := genesis + 30*engine.HeightsPerDay
	afterClose := mature + engine.HeightsPerDay
	if r := ClaimMint(s, at(ctx, "hive:alice", afterClose), id); !r.OK {
		t.Fatalf("first claim failed: %s", r.Msg)
	}
	if r := ClaimMint(s, at(ctx, "hive:alice", afterClose), id); r.OK {
		t.Fatal("DOUBLE CLAIM: second claim succeeded")
	}
	auditSupply(t, s)
}

// Another account must not be able to claim someone else's mint.
func TestCannotClaimSomeoneElsesMint(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(1_000))
	id, _ := CreateMint(s, at(ctx, "hive:alice", genesis), lc(1_000), 30)

	mature := genesis + 30*engine.HeightsPerDay
	if r := ClaimMint(s, at(ctx, "hive:mallory", mature), id); r.OK {
		t.Fatal("stole another account's mint")
	}
	if Balance(s, "hive:mallory") != 0 {
		t.Fatalf("mallory gained %s", fmtA(Balance(s, "hive:mallory")))
	}
}

func TestGoodAccountingWindow(t *testing.T) {
	s, ctx := newChain(t)
	creditLiquid(s, "hive:alice", lc(1_000))
	id, _ := CreateMint(s, at(ctx, "hive:alice", genesis), lc(1_000), 365)
	mature := genesis + 365*engine.HeightsPerDay

	if r := ArmGoodAccounting(s, at(ctx, "hive:alice", genesis), id); r.OK {
		t.Fatal("armed far too early")
	}
	if r := ArmGoodAccounting(s, at(ctx, "hive:alice", mature-engine.HeightsPerDay), id); r.OK {
		t.Fatal("armed before maturity — nothing to decide yet")
	}
	Settle(s, Ctx{Height: mature + engine.HeightsPerDay})
	if r := ArmGoodAccounting(s, at(ctx, "hive:alice", mature+engine.HeightsPerDay), id); !r.OK {
		t.Fatalf("day 1 of grace should be inside the window: %s", r.Msg)
	}
	// And never once the bleed has started.
	s2, ctx2 := newChain(t)
	creditLiquid(s2, "hive:bob", lc(1_000))
	id2, _ := CreateMint(s2, at(ctx2, "hive:bob", genesis), lc(1_000), 365)
	late := mature + (engine.GraceDays+1)*engine.HeightsPerDay
	Settle(s2, Ctx{Height: late})
	if r := ArmGoodAccounting(s2, at(ctx2, "hive:bob", late), id2); r.OK {
		t.Fatal("armed mid-bleed — user could opt out of the bleed retroactively")
	}
}

// TestMissingKeysBehaveTheWayMagiReportsThem pins the single most dangerous
// divergence found in this project.
//
// MAGI's sdk.StateGetObject returns a NON-NIL pointer to an empty string for a
// key that was never written. MemStore used to return nil, so `IsInit`'s
// `!= nil` test passed 40 tests locally and then reported "already initialised"
// on a virgin contract the moment it hit the real chain — making `init`
// impossible and the deployment permanently unusable.
//
// Two things are asserted, and both matter:
//   - the fake still behaves as awkwardly as the chain (nobody "fixes" MemStore)
//   - reads go through get(), which collapses empty to absent
//
// If this test is ever failing, do not soften MemStore. Fix the caller.
func TestMissingKeysBehaveTheWayMagiReportsThem(t *testing.T) {
	s := NewMemStore()

	raw := s.Get("never/written")
	if raw == nil {
		t.Fatal("MemStore returned nil for a missing key; MAGI returns a " +
			"pointer to an empty string. Making the fake kinder than the " +
			"chain is how the contract got bricked on the first deploy.")
	}
	if *raw != "" {
		t.Fatalf("missing key should read as empty, got %q", *raw)
	}

	if got := get(s, "never/written"); got != nil {
		t.Fatalf("get() must report a missing key as absent, got %q", *got)
	}

	// The bug, stated as behaviour: a fresh contract must be initialisable.
	if IsInit(s) {
		t.Fatal("a virgin contract reports itself already initialised — " +
			"init can never be called and the deployment is dead")
	}
	if r := Init(s, 109_200_956); !r.OK {
		t.Fatalf("init on a virgin contract must succeed, got %q", r.Msg)
	}
	if !IsInit(s) {
		t.Fatal("after init the contract must report itself initialised")
	}
	if r := Init(s, 109_200_956); r.OK {
		t.Fatal("init must be refused the second time")
	}
}

// One migration credit per account, enforced by the CONTRACT — not by the
// executor's resume file. A deleted progress file during the 2026-08-21
// rehearsal double-credited 8 accounts; this makes that class of operator
// error impossible where it matters.
func TestMigrationCreditsEachAccountExactlyOnce(t *testing.T) {
	s, _ := newChain(t)
	if r := creditLiquid(s, "hive:alice", lc(1_000)); !r.OK {
		t.Fatal(r.Msg)
	}
	if r := creditLiquid(s, "hive:alice", lc(1)); r.OK {
		t.Fatal("a second migration credit for the same account was accepted")
	}
	if Balance(s, "hive:alice") != lc(1_000) {
		t.Fatalf("balance is %s after the refused double credit", fmtA(Balance(s, "hive:alice")))
	}
	// Other accounts are unaffected by alice's marker.
	if r := creditLiquid(s, "hive:bob", lc(5)); !r.OK {
		t.Fatal(r.Msg)
	}
}

// creditLiquid migrates a liquid-only snapshot position — the shorthand most
// tests want, since they are exercising something other than the migration.
func creditLiquid(s Store, account string, amt engine.Amount) Result {
	return CreditMigration(s, account, amt, 0)
}

// The batched migration — the entrypoint that exists because MAGI freezes a
// call's full rc_limit for 5 days, making 6,039 single credits cost ~1,800
// HBD of parked RC.
func TestMigrationBatch(t *testing.T) {
	s, _ := newChain(t)

	batch := []MigrationEntry{
		{Account: "hive:a", Liquid: lc(100)},
		{Account: "hive:b", Liquid: lc(200)},
		{Account: "hive:c", Liquid: lc(250), Staked: lc(50)},
	}
	if r := CreditMigrationBatch(s, batch); !r.OK {
		t.Fatalf("batch failed: %s", r.Msg)
	}
	if MigratedSupply(s) != lc(600) {
		t.Fatalf("migrated %s, want 600", fmtA(MigratedSupply(s)))
	}
	// The staked half of hive:c became the 6-month migration mint, not balance.
	if Balance(s, "hive:c") != lc(250) {
		t.Fatalf("hive:c liquid is %s, want 250", fmtA(Balance(s, "hive:c")))
	}
	if SharesOf(s, "hive:c") != engine.Shares(lc(50)) {
		t.Fatalf("hive:c shares are %d, want staked 1:1", SharesOf(s, "hive:c"))
	}

	// Idempotent resume: rerunning a batch that straddles the crash point
	// credits only the genuinely new account, exactly once.
	again := append(batch, MigrationEntry{Account: "hive:d", Liquid: lc(50)})
	r := CreditMigrationBatch(s, again)
	if !r.OK {
		t.Fatalf("resume batch failed: %s", r.Msg)
	}
	if r.Msg != "migrated 1 of 4" {
		t.Fatalf("resume said %q, want a single fresh credit", r.Msg)
	}
	if MigratedSupply(s) != lc(650) || Balance(s, "hive:a") != lc(100) {
		t.Fatal("resume double-credited")
	}

	// A batch that would breach the hardcap must apply NOTHING — not even its
	// valid entries.
	before := MigratedSupply(s)
	huge := []MigrationEntry{
		{Account: "hive:ok", Liquid: lc(1)},
		{Account: "hive:whale", Liquid: engine.HistoricHardCap - engine.EmissionCap},
	}
	if r := CreditMigrationBatch(s, huge); r.OK {
		t.Fatal("hardcap-breaching batch accepted")
	}
	if MigratedSupply(s) != before || Balance(s, "hive:ok") != 0 {
		t.Fatal("failed batch half-applied — atomicity is broken")
	}

	// Bounds and malformed input.
	over := make([]MigrationEntry, MaxMigrateBatch+1)
	for i := range over {
		over[i] = MigrationEntry{Account: "hive:x" + encU64(uint64(i)), Liquid: lc(1)}
	}
	if r := CreditMigrationBatch(s, over); r.OK {
		t.Fatal("oversized batch accepted")
	}
	if r := CreditMigrationBatch(s, []MigrationEntry{{Account: "hive:z"}}); r.OK {
		t.Fatal("zero amount accepted")
	}
	if r := CreditMigrationBatch(s, []MigrationEntry{
		{Account: "hive:neg", Liquid: lc(1), Staked: -1},
	}); r.OK {
		t.Fatal("negative staked accepted")
	}
	if r := CreditMigrationBatch(s, []MigrationEntry{
		{Account: "hive:dup", Liquid: lc(1)}, {Account: "hive:dup", Liquid: lc(2)},
	}); r.OK {
		t.Fatal("in-batch duplicate accepted")
	}
	auditSupply(t, s)
}

// The staked-power conversion, per the spec: LASSECASH POWER becomes
// Migration L-Shares 1:1 inside a 6-month mint — no multipliers, no share
// rate, and the ordinary lifecycle (mature → grace → bleed) is what purges
// dead weight into the reward pool.
func TestMigrationMintConvertsStakedPowerOneToOne(t *testing.T) {
	s, ctx := newChain(t)

	if r := CreditMigration(s, "hive:staker", lc(1_000), lc(9_000)); !r.OK {
		t.Fatal(r.Msg)
	}
	if Balance(s, "hive:staker") != lc(1_000) {
		t.Fatalf("liquid is %s, want 1,000", fmtA(Balance(s, "hive:staker")))
	}
	// 1:1 — NOT through the multiplier path. A voluntary 182-day mint of the
	// same size would receive Longer-Pays-Better and yield MORE than 1:1; the
	// migration mint must not.
	if SharesOf(s, "hive:staker") != engine.Shares(lc(9_000)) {
		t.Fatalf("shares are %d, want exactly the staked amount", SharesOf(s, "hive:staker"))
	}
	m, found := GetMint(s, "hive:staker", 1)
	if !found || m.Principal != lc(9_000) || m.Days != engine.MigrationMintDays {
		t.Fatalf("migration mint wrong: found=%v principal=%s days=%d",
			found, fmtA(m.Principal), m.Days)
	}
	if m.StartHeight != GenesisHeight(s) {
		t.Fatal("migration mint must start at genesis, not at broadcast height")
	}
	auditSupply(t, s)

	// It lives the ordinary lifecycle: claimable the day after maturity for
	// full principal (claiming exactly on the maturity day is refused until
	// the walk closes it — see the fix in ClaimMint/endMint).
	mature := genesis + uint64(engine.MigrationMintDays)*engine.HeightsPerDay
	afterClose := mature + engine.HeightsPerDay
	Settle(s, Ctx{Height: afterClose})
	if r := ClaimMint(s, at(ctx, "hive:staker", afterClose), 1); !r.OK {
		t.Fatalf("mature claim failed: %s", r.Msg)
	}
	if got := Balance(s, "hive:staker"); got < lc(10_000) {
		t.Fatalf("after claim: %s, want at least principal back (plus yield)", fmtA(got))
	}
	auditSupply(t, s)
}

// The burn is recorded per account, not as an anonymous lump: each
// non-qualifying account's LASSECASH and POWER go to hive:null AND leave a
// permanent receipt, so who held what is readable on MAGI forever (Lasse,
// 2026-08-21). Migrated accounts carry the same receipt without "burned".
func TestBurnBatchRecordsProvenanceAtNull(t *testing.T) {
	s, _ := newChain(t)
	CreditMigration(s, "hive:alive", lc(10), lc(90))

	batch := []MigrationEntry{
		{Account: "hive:dead1", Liquid: lc(100), Staked: lc(400)},
		{Account: "hive:dead2", Liquid: lc(5)},
		{Account: "hive:lassecash", Liquid: lc(7_000)},
	}
	if r := BurnMigrationBatch(s, batch); !r.OK {
		t.Fatalf("burn batch: %s", r.Msg)
	}
	if got := TotalBurned(s); got != lc(7_505) {
		t.Fatalf("null holds %s, want 7,505", fmtA(got))
	}
	if Balance(s, "hive:dead1") != 0 || SharesOf(s, "hive:dead1") != 0 {
		t.Fatal("a burned account must hold nothing and vote with nothing")
	}
	if SharesOf(s, BurnAccount) != 0 {
		t.Fatal("null must never hold shares")
	}
	// The receipts.
	burned, liq, stk, found := MigrationRecord(s, "hive:dead1")
	if !found || !burned || liq != lc(100) || stk != lc(400) {
		t.Fatalf("dead1 receipt wrong: burned=%v liq=%s stk=%s found=%v", burned, fmtA(liq), fmtA(stk), found)
	}
	burned, liq, stk, found = MigrationRecord(s, "hive:alive")
	if !found || burned || liq != lc(10) || stk != lc(90) {
		t.Fatalf("alive receipt wrong: burned=%v liq=%s stk=%s", burned, fmtA(liq), fmtA(stk))
	}
	if _, _, _, found := MigrationRecord(s, "hive:nobody"); found {
		t.Fatal("an account outside the snapshot must have no receipt")
	}
	// Supply identity: everything is held somewhere — null included.
	if MigratedSupply(s) != lc(100+7_505) {
		t.Fatalf("migrated supply %s, want 7,605 (owners + null)", fmtA(MigratedSupply(s)))
	}
	auditSupply(t, s)

	// Idempotent resend, and never twice: a burned account cannot later be
	// migrated, and a migrated account cannot later be burned.
	if r := BurnMigrationBatch(s, batch); !r.OK || r.Msg != "burned 0 of 3 to null" {
		t.Fatalf("resend: %+v", r)
	}
	if r := CreditMigration(s, "hive:dead1", lc(1), 0); r.OK {
		t.Fatal("a burned account was migrated afterwards")
	}
	if r := BurnMigrationBatch(s, []MigrationEntry{{Account: "hive:alive", Liquid: lc(1)}}); !r.OK || TotalBurned(s) != lc(7_505) {
		t.Fatal("a migrated account was burned afterwards")
	}
	auditSupply(t, s)
}

// --- the account roll -------------------------------------------------------

// walkRoll rebuilds the holder set the way a foreign reader would: chunk by
// chunk through plain key reads, with no enumeration and no knowledge of the
// contract's internals beyond acct_n and acctl_<i>.
func walkRoll(s Store) []string {
	n := AccountCount(s)
	var out []string
	for i := uint64(0); i*AccountChunkSize < n; i++ {
		out = append(out, AccountChunk(s, i)...)
	}
	return out
}

// TestTheAccountRollCanRebuildTheHolderSet is the whole point of the roll:
// MAGI cannot enumerate state, so without this nobody could answer "who holds
// LASSECASH?" from the chain alone — and after the key burn that is the only
// thing standing between a broken MAGI and an unrecoverable LasseCash.
func TestTheAccountRollCanRebuildTheHolderSet(t *testing.T) {
	s, ctx := newChain(t)

	// A liquid holder.
	if !credit(s, "hive:liquid", lc(1_000)) {
		t.Fatal("credit failed")
	}
	// A STAKE-ONLY holder: zero liquid, entire position is a mint. This is the
	// case that would silently break the roll, and it is not hypothetical —
	// @daneamanda arrives at genesis with 0 liquid and 250,000 staked.
	if !creditMigrationMint(s, "hive:stakeonly", lc(250_000)) {
		t.Fatal("migration mint failed")
	}
	if Balance(s, "hive:stakeonly") != 0 {
		t.Fatal("test setup wrong: the stake-only holder should have no liquid")
	}

	roll := walkRoll(s)
	has := func(a string) bool {
		for _, x := range roll {
			if x == a {
				return true
			}
		}
		return false
	}
	if !has("hive:liquid") {
		t.Error("a liquid holder is missing from the roll")
	}
	if !has("hive:stakeonly") {
		t.Error("A STAKE-ONLY HOLDER IS MISSING FROM THE ROLL — the mint hook is broken")
	}

	// Idempotent: crediting the same account again must not duplicate it.
	before := AccountCount(s)
	for i := 0; i < 5; i++ {
		credit(s, "hive:liquid", lc(1))
	}
	if AccountCount(s) != before {
		t.Errorf("repeat credits grew the roll: %d -> %d", before, AccountCount(s))
	}
	_ = ctx
}

// TestTheRollChunksAndStaysExact pushes past a chunk boundary — an off-by-one
// there would drop or duplicate holders, and the failure would only show up
// years later at the moment the roll is actually needed.
func TestTheRollChunksAndStaysExact(t *testing.T) {
	s, _ := newChain(t)

	want := map[string]bool{}
	total := AccountChunkSize*3 + 7 // deliberately not a chunk multiple
	for i := 0; i < total; i++ {
		a := "hive:h" + encU64(uint64(i))
		want[a] = true
		if !credit(s, a, lc(1)) {
			t.Fatalf("credit %s failed", a)
		}
	}
	if got := AccountCount(s); got != uint64(total) {
		t.Fatalf("roll counted %d accounts, want %d", got, total)
	}

	roll := walkRoll(s)
	if len(roll) != total {
		t.Fatalf("walking the roll returned %d names, want %d", len(roll), total)
	}
	seen := map[string]bool{}
	for _, a := range roll {
		if seen[a] {
			t.Fatalf("%s appears twice in the roll", a)
		}
		seen[a] = true
		if !want[a] {
			t.Fatalf("%s is in the roll but never held anything", a)
		}
	}
	for a := range want {
		if !seen[a] {
			t.Fatalf("%s held LASSECASH but is missing from the roll", a)
		}
	}
}

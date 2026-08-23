package state

import (
	"math/big"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/lassecash/engine"
)

// The overnight economic fuzzer.
//
// Every bug found on 2026-08-21 — late-minter dilution, the PoB path missing
// its AccStart stamp, the refusal that ate a principal — was found by a
// targeted test someone thought to write. This is the net for the ones nobody
// thinks to write: random actors doing random things over random stretches of
// simulated decades, with the books audited after EVERY single operation.
//
// Run shape: each iteration is one economy living up to ~40 years. Ordinary
// `go test` runs a handful of economies as a smoke check; the overnight run
// sets FUZZ_ROUNDS high and lets it grind.
//
//	FUZZ_ROUNDS=100000 go test -run TestFuzzEconomy -timeout 12h
//
// A failure prints the seed; FUZZ_SEED replays it exactly.
// poolOpsDone tallies pool operations that actually SUCCEEDED across a whole
// fuzz run.
//
// WHY IT EXISTS. A fuzzer whose pool calls are all refused — insufficient
// balance, ratio mismatch, no open tranche — passes every invariant while
// testing nothing, and it does so silently. That failure mode is invisible
// precisely because the run goes green. The tally makes it loud: if any pool
// operation never once succeeded across every economy in the run, the run
// FAILS rather than reassuring.
var poolOpsDone = map[string]int{}

func TestFuzzEconomy(t *testing.T) {
	rounds := 25
	if v := os.Getenv("FUZZ_ROUNDS"); v != "" {
		rounds, _ = strconv.Atoi(v)
	}
	var seeds []int64
	if v := os.Getenv("FUZZ_SEED"); v != "" {
		n, _ := strconv.ParseInt(v, 10, 64)
		seeds = []int64{n}
	} else {
		for i := 0; i < rounds; i++ {
			seeds = append(seeds, rand.Int63())
		}
	}
	poolOpsDone = map[string]int{}
	for _, seed := range seeds {
		seed := seed
		t.Run("seed="+strconv.FormatInt(seed, 10), func(t *testing.T) {
			fuzzOneEconomy(t, seed)
		})
	}
	for _, op := range []string{"add", "remove", "claim", "swap_lc", "swap_hbd", "sweep"} {
		t.Logf("pool %-9s %d successful", op, poolOpsDone[op])
		if poolOpsDone[op] == 0 {
			t.Errorf("pool operation %q NEVER succeeded in this run — "+
				"the fuzzer is not exercising the pool, and a green run means nothing", op)
		}
	}
}

func fuzzOneEconomy(t *testing.T, seed int64) {
	r := rand.New(rand.NewSource(seed))
	s, _ := newChain(t)
	// Real HBD custody. The pool is the ONLY place in the contract that holds
	// somebody else's actual money, and until 2026-08-23 the 500k fuzzer never
	// touched it — no AddLiquidity, no Swap, no ClaimPoolRewards, no
	// SweepTranche. Every pool test was a case a human thought to write, which
	// is exactly the gap this fuzzer exists to cover everywhere else.
	assets := NewMemAssets()

	actors := []string{"hive:a", "hive:b", "hive:c", "hive:d", "did:pkh:eip155:1:0xe"}
	for _, a := range actors {
		// A random liquid/staked split, like the real snapshot: the staked part
		// becomes a 182-day migration mint, so every fuzzed economy also
		// exercises the staked-power conversion and its lifecycle.
		liquid := lc(int64(1_000 + r.Intn(2_000_000)))
		var staked engine.Amount
		if r.Intn(2) == 0 {
			staked = lc(int64(r.Intn(2_000_000)))
		}
		if res := CreditMigration(s, a, liquid, staked); !res.OK {
			t.Fatalf("seed credit %s: %s", a, res.Msg)
		}
	}

	height := genesis
	epoch := uint64(1)
	// Track live mints per actor: id -> maturity, so ops can aim at real ones.
	mints := map[string][]uint64{}
	var posts []string
	tranches := map[string][]uint64{}

	audit := func(op string) {
		t.Helper()
		if failed := auditEconomy(s); failed != "" {
			t.Fatalf("seed %d, after %s at height %d:\n%s", seed, op, height, failed)
		}
		if failed := auditPoolCustody(s, assets); failed != "" {
			t.Fatalf("seed %d, after %s at height %d:\n%s", seed, op, height, failed)
		}
	}
	audit("genesis")

	steps := 200 + r.Intn(400)
	for i := 0; i < steps; i++ {
		// Time lurches forward unevenly: minutes to ~2 years, so eras, grace
		// windows, bleeds and expiries all get straddled at random.
		height += uint64(1+r.Intn(2*365)) * uint64(engine.HeightsPerDay) / uint64(1+r.Intn(48))
		if r.Intn(6) == 0 {
			epoch++
		}
		who := actors[r.Intn(len(actors))]
		c := Ctx{Sender: who, Height: height, Epoch: epoch}

		switch r.Intn(16) {
		case 0, 1: // mint something affordable
			bal := Balance(s, who)
			if bal > engine.MinMintAmount {
				amt := engine.MinMintAmount + engine.Amount(r.Int63n(int64(bal-engine.MinMintAmount)+1))
				days := int64(1 + r.Intn(1095))
				if id, res := CreateMint(s, c, amt, days); res.OK {
					mints[who] = append(mints[who], id)
				}
			}
		case 2: // claim (early, mature, bleeding or dead — all fair game)
			if ids := mints[who]; len(ids) > 0 {
				n := r.Intn(len(ids))
				if res := ClaimMint(s, c, ids[n]); res.OK {
					mints[who] = append(ids[:n], ids[n+1:]...)
				}
			}
		case 3: // transfer a random slice
			if bal := Balance(s, who); bal > 0 {
				to := actors[r.Intn(len(actors))]
				Transfer(s, c, to, engine.Amount(r.Int63n(int64(bal)+1)+1))
			}
		case 4: // burn a sliver
			if bal := Balance(s, who); bal > 100 {
				Burn(s, c, engine.Amount(r.Int63n(int64(bal/100)+1)+1))
			}
		case 5: // post, if rich enough in shares
			perm := "p" + strconv.Itoa(i)
			if res := CreatePost(s, c, perm, engine.Window(r.Intn(2)), PayoutMode(r.Intn(3))); res.OK {
				posts = append(posts, who+"|"+perm)
			}
		case 6: // vote on some post
			if len(posts) > 0 {
				parts := strings.SplitN(posts[r.Intn(len(posts))], "|", 2)
				Vote(s, c, parts[0], parts[1], int64(1+r.Intn(100)))
			}
		case 7: // pay out a post
			if len(posts) > 0 {
				parts := strings.SplitN(posts[r.Intn(len(posts))], "|", 2)
				Payout(s, c, parts[0], parts[1])
			}
		case 8: // monthly pending mint / curation drain
			SettlePending(s, c, who)
		case 9: // good accounting on a random mint
			if ids := mints[who]; len(ids) > 0 {
				ArmGoodAccounting(s, c, ids[r.Intn(len(ids))])
			}

		case 10: // add liquidity — opens the pool, or matches its ratio
			if bal := Balance(s, who); bal > lc(1) {
				in := engine.Amount(r.Int63n(int64(bal/2)+1) + int64(lc(1)))
				// A deliberately generous HBD ceiling most of the time, and an
				// occasionally stingy one, so the maxHbd refusal path is hit
				// with its money still un-moved.
				maxHbd := in * 4
				if r.Intn(8) == 0 {
					maxHbd = engine.Amount(r.Int63n(int64(in) + 1))
				}
				if id, res := AddLiquidity(s, assets, c, in, maxHbd); res.OK {
					tranches[who] = append(tranches[who], id)
					poolOpsDone["add"]++
				}
			}
		case 11: // withdraw a tranche, whole
			if ids := tranches[who]; len(ids) > 0 {
				n := r.Intn(len(ids))
				if res := RemoveLiquidity(s, assets, c, ids[n]); res.OK {
					tranches[who] = append(ids[:n], ids[n+1:]...)
					poolOpsDone["remove"]++
				}
			}
		case 12: // claim pool rewards — re-registers loyalty at today's age
			if ids := tranches[who]; len(ids) > 0 {
				if ClaimPoolRewards(s, c, ids[r.Intn(len(ids))]).OK {
					poolOpsDone["claim"]++
				}
			}
		case 13: // sell LASSECASH into the pool
			if bal := Balance(s, who); bal > lc(1) {
				in := engine.Amount(r.Int63n(int64(bal/4)+1) + 1)
				before := productK(s)
				if res := SwapLCForHBD(s, assets, c, in, 0); res.OK {
					mustNotShrinkK(t, seed, "swap lc->hbd", before, productK(s))
					poolOpsDone["swap_lc"]++
				}
			}
		case 14: // buy LASSECASH with HBD
			if lcRes, hbdRes := PoolReserves(s); lcRes > 0 && hbdRes > 0 {
				before := productK(s)
				if res := SwapHBDForLC(s, assets, c, engine.Amount(r.Int63n(int64(hbdRes/4)+1)+1), 0); res.OK {
					mustNotShrinkK(t, seed, "swap hbd->lc", before, productK(s))
					poolOpsDone["swap_hbd"]++
				}
			}
		case 15: // a STRANGER tries to evict somebody else's tranche
			// The single most dangerous line in the pool: closeTranche must pay
			// the OWNER, never ctx.Sender. Fuzzed from the hostile direction —
			// a random actor sweeping a random other actor's position — because
			// getting it wrong turns a permissionless sweep into permissionless
			// robbery, and it would only show up as somebody else's money
			// arriving in the caller's balance.
			victim := actors[r.Intn(len(actors))]
			if ids := tranches[victim]; len(ids) > 0 {
				n := r.Intn(len(ids))
				before := Balance(s, who)
				res := SweepTranche(s, assets, c, victim, ids[n])
				if res.OK {
					if who != victim && Balance(s, who) != before {
						t.Fatalf("seed %d: SWEEP PAID THE CALLER: %s swept %s's tranche %d and gained %s",
							seed, who, victim, ids[n], fmtRaw(Balance(s, who)-before))
					}
					tranches[victim] = append(ids[:n], ids[n+1:]...)
					poolOpsDone["sweep"]++
				}
			}
		}
		// Whatever happened, the walk may lag; close it like `advance` would,
		// then audit. An audit that only ran at the end would tell us THAT the
		// books broke, not WHICH operation broke them.
		AccrueFully(s, height)
		audit("op " + strconv.Itoa(i))
	}
}

// auditEconomy is auditSupply as a reusable check: every base unit must be in
// a balance, a pool, a live principal, pending, or a curator pot — and the
// total must equal migrated + emitted - burned exactly. Returns "" when sound.
func auditEconomy(s *MemStore) string {
	var held engine.Amount
	for _, k := range s.Keys() {
		switch {
		case strings.HasPrefix(k, "bal_"), strings.HasPrefix(k, "pool_"),
			k == keyPoolLC:
			held += getAmount(s, k)
		case strings.HasPrefix(k, "pend_"):
			f := strings.Split(*s.Get(k), "|")
			held += engine.Amount(decI64(f[0]))
		case strings.HasPrefix(k, "mint_"):
			f := strings.Split(*s.Get(k), "|")
			if len(f) >= 6 && !decBool(f[5]) {
				held += engine.Amount(decI64(f[0]))
			}
		case strings.HasPrefix(k, "post_"):
			if p, ok := decodePost(*s.Get(k)); ok {
				held += p.CuratorPot
				if !p.PaidOut {
					// pending author value is paid from pools at payout; the
					// pools above still hold it, so nothing to add here.
					_ = p
				}
			}
		}
	}
	// Burns credit hive:null (counted in the balance sweep above), so nothing
	// is subtracted: every base unit ever issued is still held somewhere.
	want := MigratedSupply(s) + TotalEmitted(s)
	if held != want {
		return "SUPPLY LEAK: sum of all holdings " + fmtRaw(held) +
			" != migrated+emitted " + fmtRaw(want) +
			" (diff " + fmtRaw(held-want) + ")"
	}
	return ""
}

func fmtRaw(a engine.Amount) string { return strconv.FormatInt(int64(a), 10) }

// auditPoolCustody is the pool's half of the per-operation audit.
//
// The LASSECASH side is already covered: auditEconomy sums `amm_lc` and the
// `pool_*` keys into the supply identity, so a leak there fails as a supply
// leak. What it cannot see is the HBD side, because HBD is not LasseCash's
// money — it is real, custodied, and belongs to whoever put it in.
//
// Three properties, checked after EVERY operation:
//
//  1. CUSTODY MATCHES THE LEDGER. The HBD reserve the contract has written down
//     must equal the HBD it actually holds. This is the invariant the 2026-08-22
//     milli-unit bug broke on mainnet — the adapter handed the engine 1e8 units
//     against a 1e3 allowance — and it would have been fatal after the key burn.
//
//  2. THE POOL NEVER OWES MORE SHARES THAN EXIST. If the sum of open tranche
//     shares exceeded the recorded total, the last provider out would find the
//     reserves already spent.
//
// Returns "" when sound.
func auditPoolCustody(s *MemStore, a *MemAssets) string {
	lcRes, hbdRes := PoolReserves(s)

	if int64(hbdRes) != a.Held {
		return "HBD CUSTODY MISMATCH: reserve says " + fmtRaw(hbdRes) +
			" but the contract holds " + strconv.FormatInt(a.Held, 10)
	}
	if hbdRes < 0 || lcRes < 0 {
		return "NEGATIVE RESERVE: lc " + fmtRaw(lcRes) + " hbd " + fmtRaw(hbdRes)
	}
	var open engine.Amount
	for _, key := range s.Keys() {
		if !strings.HasPrefix(key, "amm_t_") {
			continue
		}
		f := strings.Split(*s.Get(key), "|")
		// field 1 is Shares, field 3 the closed flag — see the tranche codec.
		if len(f) >= 4 && !decBool(f[3]) {
			open += engine.Amount(decI64(f[1]))
		}
	}
	if total := getAmount(s, keyPoolShares); open > total {
		return "SHARES OVERSOLD: open tranches hold " + fmtRaw(open) +
			" against a recorded total of " + fmtRaw(total)
	}
	return ""
}

// productK is the pool's constant product, in big integers.
//
// It does not fit in an int64 and the first version of this check pretended it
// did: reserves of ~1e13 each multiply to ~1e26, which wrapped negative and
// made every economy fail with "k SHRANK: 0 -> -4305396175147829280". The
// fuzzer caught the checker, which is the right order for that to happen in.
func productK(s *MemStore) *big.Int {
	lcRes, hbdRes := PoolReserves(s)
	return new(big.Int).Mul(big.NewInt(int64(lcRes)), big.NewInt(int64(hbdRes)))
}

// mustNotShrinkK asserts the constant product did not fall across a swap.
//
// Every swap floors the output in the pool's favour, so k can only grow. A
// shrinking k means a rounding error pointed the wrong way and value walked out
// of the reserves a base unit at a time — the slow leak that nobody notices
// until the last provider out is short.
func mustNotShrinkK(t *testing.T, seed int64, what string, before, after *big.Int) {
	t.Helper()
	if after.Cmp(before) < 0 {
		t.Fatalf("seed %d: k SHRANK across %s: %s -> %s", seed, what, before, after)
	}
}

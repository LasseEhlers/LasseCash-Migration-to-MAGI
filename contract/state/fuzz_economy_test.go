package state

import (
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
	for _, seed := range seeds {
		seed := seed
		t.Run("seed="+strconv.FormatInt(seed, 10), func(t *testing.T) {
			fuzzOneEconomy(t, seed)
		})
	}
}

func fuzzOneEconomy(t *testing.T, seed int64) {
	r := rand.New(rand.NewSource(seed))
	s, _ := newChain(t)

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

	audit := func(op string) {
		t.Helper()
		if failed := auditEconomy(s); failed != "" {
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

		switch r.Intn(10) {
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
				Transfer(s, c, to, engine.Amount(r.Int63n(int64(bal))+1))
			}
		case 4: // burn a sliver
			if bal := Balance(s, who); bal > 100 {
				Burn(s, c, engine.Amount(r.Int63n(int64(bal/100))+1))
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

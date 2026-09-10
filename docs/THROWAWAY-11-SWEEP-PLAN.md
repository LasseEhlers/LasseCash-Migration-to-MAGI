# Throwaway #11 — the bleed and `sweep_unclaimed`, on mainnet

**Why this deploy exists.** `sweep_unclaimed` is the last money-moving path in
the frozen contract that has never been broadcast on any chain. On production
it cannot run until **29 March 2027** — five months after the keys are gone —
so if it is wrong, nobody will ever be able to correct it. It is proven by
`TestSweepUnclaimedRecyclesTheRemainderOnce` and on the simulator, and that is
not the same as having run.

The migration **bleed** rides along in the same deploy: a claim in the bleed
window pays only the surviving fraction and recycles the rest.

## The build

| | |
|---|---|
| artifact | `contract/artifacts/main-testwindows.wasm` |
| bytes | 105,084 |
| code CID | `bafkreia3ebidtsbavr5h4v4y7ft3mp2j776ttellys45rlmtv4pvskl7xm` |
| clock | **TESTWINDOWS 240x** — a "day" is 6 minutes, 120 heights. Emission and the 7%/yr ratchet stay on mainnet time, so every VALUE is real; only the waiting compresses. `init` stamps the return with `[TESTWINDOWS BUILD 240x]`. |

## The snapshot — `tools/throwaway-tree.py`

Three leaves, root **`3a342a73fa1ed051f6c8979fac7b333f2af8d15133579787ed83aaf65c4ff23a`**,
cross-checked against the contract's own Go verifier before deploying (a bad
root would waste the 10 HBD).

| account | liquid | staked | role |
|---|---|---|---|
| hive:lassecashmagi | 1.00 | 10.00 | claims mid-bleed |
| hive:lassecashdapps | 2.00 | 20.00 | **never claims** — this is what gets swept |
| hive:null | 0 | 0 | burned leaf |

Qualifier total **33.00000000 LASSECASH**, burn total 0.

## The clock

Genesis is set **in the past** so the contract starts deep in its own
timeline: `genesis = head − 19,800` puts it at **day 165** — 45 days into the
90-day bleed, so exactly **50% of a staked position survives**. Day 211 (past
the 210-day claim deadline) then arrives **~4.6 hours** later in real time.

## The run

Every step is one command. `CONTRACT_ID` must be set explicitly on every
call.js invocation — unset it falls back to throwaway #9 and reports success
against a dead contract.

```bash
# 1. deploy (10 HBD from lassecashmagi's L1 balance)
WASM=contract/artifacts/main-testwindows.wasm NAME="LasseCash throwaway 11" \
  DESC="TESTWINDOWS 240x — sweep_unclaimed and the migration bleed" ./deploy.sh deploy

export TW=<the contract id it prints>

# 2. genesis at day 165 (recompute head at the moment you run it)
HEAD=$(curl -s https://api.hive.blog -d '{"jsonrpc":"2.0","method":"condenser_api.get_dynamic_global_properties","params":[],"id":1}' | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['head_block_number'])")
CONTRACT_ID=$TW node tools/chain-test/call.js init "$((HEAD-19800))" 1500

# 3. commit the snapshot (owner-only, once)
CONTRACT_ID=$TW node tools/chain-test/call.js set_snapshot \
  "3a342a73fa1ed051f6c8979fac7b333f2af8d15133579787ed83aaf65c4ff23a|3300000000|0" 2000

# 4. walk the accrual to today, 50 days per call (~4 calls, a few thousand RC each)
CONTRACT_ID=$TW node tools/chain-test/call.js advance 50 8000    # repeat until it says it is current

# 5. claim mid-bleed as lassecashmagi
CONTRACT_ID=$TW node tools/chain-test/call.js claim_migration \
  "100000000|1000000000|3a7cc648922a748b067522e88c4d050e50fd9d8dbef54f4a180499af7de0b7fe,0f4091c4e28e73e55a0c73ec328559c6c0a39e9d4713a0254e556c685403a4df" 6000
```

**Expected, exactly:** liquid is always credited in full, only the staked part
bleeds. At day 165 half the stake survives, so the claim pays
**1.00 + 5.00 = 6.00000000 LASSECASH** and **5.00000000 recycles into the
L-Share pool**. `ret` reads `claimed 600000000 liquid`.

```bash
# 6. before day 210 the sweep must REFUSE
CONTRACT_ID=$TW node tools/chain-test/call.js sweep_unclaimed "" 1000
#    expect: "claim window still open"

# 7. ~4.6 hours later, past day 210: walk to today, then sweep
CONTRACT_ID=$TW node tools/chain-test/call.js advance 50 8000    # repeat until current
CONTRACT_ID=$TW node tools/chain-test/call.js sweep_unclaimed "" 2000
```

**Expected:** `swept 2200000000 unclaimed to the reward pool` — the 22.00
LASSECASH lassecashdapps never claimed — the L-Share pool rises by exactly
that, `sup_migrated` rises by exactly that, and **a second call refuses with
"already swept"**. A claim attempted after the deadline refuses with "claim
window closed".

## RESULTS — 2026-09-10

**Deployed** `vsc1BWKyP3XtDUqhZQQbWSZvcVhEsB19gQnEj5`, code CID
`bafkreia3ebidtsbavr5h4v4y7ft3mp2j776ttellys45rlmtv4pvskl7xm` (= the local
artifact), owner hive:lassecashmagi, tx `f0d4cac4…`.
**init** `b9a5d31f…` → "initialised at height 109759027 [TESTWINDOWS BUILD
240x]", contract born at **day 165**. **set_snapshot** `6682ffa6…` → root and
33.00000000 committed. **Accrual walk** four `advance 50` calls, ~90 s in
total, ending "accrual is current" at acc_day 165.

**Emission cross-check, unprompted:** `sup_emitted` = 6,278.53861800 over
those 165 compressed days = era-1's 0.31709791 × 19,800 REAL heights, exactly.
The TESTWINDOWS promise — compressed calendar, real values — holds on mainnet.

### The bleed — EXACT, tx `38565d4d…`, anchored 109,779,022

```
past      = 109,779,022 − maturity 109,762,627 = 16,395 heights
into      = 16,395 − 10,800 grace              =  5,595
remaining = 10,800 − 5,595                     =  5,205
frac      = 5,205 × 1e8 / 10,800 = 48,194,444        (floored)
kept      = 1,000,000,000 × 48,194,444 / 1e8 = 481,944,440
```

Paid **581,944,440** = 1.00000000 liquid in full + 4.81944440 of the stake.
`pool_lshare` 156,963,465,450 → 157,481,521,010, **+518,055,560 = exactly the
bled remainder**. Nothing created, nothing lost.

⚠️ **The contract floors TWICE** — once on the fraction, once on the amount —
so a single float division over-predicts by a few base units. `BleedRemaining`
computes the SURVIVING side directly for that reason (comment in
engine/lshare.go, review find 2026-08-24). Any external calculator that
predicts a claim must do the same two integer steps.

⚠️ **`ctx.Height` is the transaction's ANCHOR height**, not the height of the
output block. 8 heights apart here; on a 240x clock that is 0.07 of a day and
it moved the expected figure visibly.

### Refusal paths, all free simulations

| attempt | answer | RC |
|---|---|---|
| claim twice from one account | already claimed | 157 |
| one byte flipped in the proof | proof does not match the snapshot | 139 |
| right proof, inflated amounts | proof does not match the snapshot | 139 |
| another account's proof | proof does not match the snapshot | 139 |
| `sweep_unclaimed` before day 210 | claim window still open | 106 |

`record_burn` on the tiny tree's null leaf refuses "bad entry" — correct: it
requires `liquid+staked > 0` and that test leaf holds zero. An artefact of the
three-leaf tree, not of the contract.

## What is being watched

- the bleed pays the surviving fraction **to the base unit**, and the bled part
  lands in the pool rather than vanishing
- `sweep_unclaimed` refuses before the deadline, works once after it, and
  refuses the second time
- the supply identity holds across both: `sum of holdings = migrated + emitted`
- the RC cost of a 211-day accrual walk in slices, on mainnet, for real

# Throwaway #15 — reproduce the float shortfall, then fix it

**Why this deploy exists.** On 2 October the first day-30 migration claim on
production was refused: the core's books owe 9,189,552 LASSECASH and the token
ledger holds 166,665 (docs/FLOAT-SHORTFALL.md). `reconcile_float` is written
and unit-tested, but a unit test runs where the token and the core are the
same world — which is precisely the blind spot that produced the bug. **This
deploy exists to make the failure happen on a real chain, and then make it go
away.**

If step 7 does not REPRODUCE the refusal, stop: we do not understand the bug
well enough to fix it on a contract that is about to be frozen.

## The build

| | |
|---|---|
| artifact | `contract/artifacts/main.wasm` (MAINNET clock, not TESTWINDOWS) |
| bytes | 106,263 |
| code CID | `bafkreifrpanzlyv7uduovzwzvreg4nfnozlj3powgjdw5cxsc5xy6hzyii` |
| deployed source | current `main` |

**Mainnet clock on purpose.** A fast-clock build would compress the waiting,
but the fix has to be proven on the build closest to what goes live. Time is
bought instead by backdating genesis, which changes no code.

Reproducibility is already established: rebuilding the DEPLOYED source
(`f41e883`) reproduces the live CID
`bafkreiaal6j4ar5wiktqcsaqk5qgzb6ouxwrkma4qixghawdlppokcv6za` exactly, so the
candidate differs from production by `reconcile_float` and +1,159 bytes and
nothing else.

## The clock

```
genesis = head − 892_800        # 31 × 28,800 heights = 31 days
```

Day 31 from the first block, so a migration mint created at genesis is already
matured AND its maturity day has closed — which is what a claim needs
(`accAt_30` must exist). Compute it at deploy time:

```bash
python3 - <<'PY'
import json,urllib.request
r=urllib.request.Request('https://api.okinoko.io/api/v1/graphql',
  data=json.dumps({'query':'{localNodeInfo{last_processed_block}}'}).encode(),
  headers={'Content-Type':'application/json'})
h=json.load(urllib.request.urlopen(r,timeout=20))['data']['localNodeInfo']['last_processed_block']
print('genesis =', h-892_800)
PY
```

## The snapshot — `tools/throwaway-tree.py`

Root **`f5c0726be580235f8a54c64d72a6d6b10bf768f68afa55f87b9255752ceb57b6`**,
qualifier total **700100100000000** (7,001,001 LASSECASH), burn total 0.

| account | liquid | staked |
|---|---|---|
| hive:lassecashmagi | 1,000 | **7,000,000** |
| hive:lassecashdapps | 1 | 0 |
| hive:null | 0 | 0 (burned leaf) |

⚠️ **THE STAKE MUST BE BIG, and that is the whole design.** A mint's principal
is only unbacked if it exceeds what emission has since minted into the float.
At 31 days that is ~283,000 LASSECASH — so a small stake is quietly covered
and the claim SUCCEEDS, proving nothing. This is exactly why production's
small claims worked while the 7,005,065 one did not, and why the unit test had
to go from 9,000 to 7,000,000 before it would fail.

## The sequence

Every call: `CONTRACT_ID=<CORE> node tools/chain-test/call.js <action> <payload> <rc_limit>`.
⚠️ **Always set `CONTRACT_ID` explicitly** — unset, call.js silently targets a
dead throwaway and reports success.

| # | step | command | cost |
|---|---|---|---|
| 1 | Deploy the core | `WASM=contract/artifacts/main.wasm NAME="LasseCash throwaway 15 (float)" ./deploy.sh deploy` | 10 HBD L1 |
| 2 | `init` backdated | `call.js init <genesis> 3000` | ~400 RC |
| 3 | Commit the snapshot | `call.js set_snapshot 'f5c0726b…|700100100000000|0' 3000` | ~600 RC |
| 4 | Claim the leaf — **no token set** | `call.js claim_migration '100000000000|700000000000000|2ac98c14…,0f4091c4…' 9500` | ~6,000 RC |
| 5 | Walk accrual past day 30 | `call.js advance 31 20000` (repeat until `acc_day` ≥ 31) | ~2,000 RC |
| 6 | Withdraw 10 HBD MAGI → L1 | wallet | 10,000 RC |
| 7 | Deploy the token | `WASM=contract/artifacts/magi-token.wasm NAME="LC15" ./deploy.sh deploy` | 10 HBD L1 |
| 8 | `init` the token | `CONTRACT_ID=<TOKEN> call.js init '{"name":"LC15","symbol":"LC15","decimals":8,"maxSupply":"5100000000000000"}' 3000` | RC |
| 9 | Hand the token to the core | `CONTRACT_ID=<TOKEN> call.js changeOwner '{"newOwner":"contract:<CORE>"}' 3000` | RC |
| 10 | Point the core at it | `call.js set_token <TOKEN> 3000` | RC |
| 11 | Sweep the legacy row | `call.js migrate_ledger 'hive:lassecashmagi' 20000` | ~900 RC |

**Steps 9 → 10 → 11 in that order.** The sweep mints and only the owner can
mint, so the core must own the token first. Proven on throwaway #10, where
@lassecashmagi was refused "Must be owner to mint" the moment it handed over.

## The two checks that are the point

**CHECK A — the shortfall exists.** After step 11:

```
sup_migrated + sup_emitted   >>   token.supply
```

Expect the token to hold roughly the 1,000 liquid plus whatever emission
minted, and the 7,000,000 of mint principal to be missing. That is the
production bug, reproduced.

**CHECK B — the claim is refused.** `call.js claim_mint 1 9000` must fail with
**`Insufficient balance`** — capital I, from the TOKEN contract, not from us.
If it succeeds, the stake was too small; raise it and redo.

## The fix

| # | step | expected |
|---|---|---|
| 12 | `call.js reconcile_float '' 5000` | `minted <n> of backing` |
| 13 | re-read supply | `token.supply == sup_migrated + sup_emitted`, exactly |
| 14 | `call.js reconcile_float '' 5000` again | **`already backed`**, supply unchanged — idempotent by arithmetic |
| 15 | `call.js claim_mint 1 9000` | CONFIRMED; the 7,000,000 principal plus yield lands |

Step 14 matters as much as 12: the production run happens by hand, possibly
twice, possibly at night.

## RC budget

~27,000 RC in total against @lassecashmagi's 45,634, with the 10,000 for the
withdrawal included. Do the CALLS before the withdrawal where possible — a
withdrawal costs credits one-for-one AND lowers the ceiling, so pulling HBD
out mid-run can strand the rest of the sequence for a day.

## Then, and only then

Queue the production update (10 HBD, 48h timelock), verify on activation,
run `reconcile_float` on production, and pay Lasse's 7,061,423 claim as the
proof. The burn height is discussed after that, never before.

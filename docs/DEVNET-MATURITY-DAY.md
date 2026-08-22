# The migration maturity day — MEASURED on the local devnet, 2026-08-22

The last unmeasured contract cost before the freeze. Every migration mint
matures on the **same day** (day 30 — they all take the genesis height), so the
accrual walk that crosses that day has to retire thousands of per-account
`shr_` entries, `MaxRetirePerWalk = 200` at a time, across several `advance`
calls. `tools/devnet/README.md` listed this as "worth measuring before the
freeze". This is that measurement.

**Headline: `MaxRetirePerWalk = 200` is safe — one slice costs 2,090,259,133
gas (20,903 RC), 20.9% of the 10B per-call ceiling.** `MaxAccrualDays = 1200`
is also adequate. But two things came out of it that need action, and neither
is a contract constant: the frontend's `RC_LIMITS.advance` is 5x too small to
cross the day at all, and an ordinary `mint` or `claim_mint` attempted while
the drain is pending **fails after burning ~22,500 RC of work that is then
discarded**.

Nothing here touched mainnet. Three throwaway contracts on the local devnet,
`localhost:18080–18083`.

---

## Setup

| | |
|---|---|
| WASM | `contract/artifacts/main-testwindows-push.wasm`, **98,773 bytes** — the production build plus `-tags "testwindows push"` |
| build | `docker run … tinygo build -gc=custom -scheduler=none -panic=trap -no-debug -tags "testwindows push" -target=wasm-unknown` |
| devnet | healthy, ~20,300 blocks, 4 nodes in sync, epoch 357 |
| clock | TESTWINDOWS: a day is **120 heights** (6 minutes) |

| contract | owner | genesis | role |
|---|---|---|---|
| `vsc1BaEtYcJZ3LjQT5adWJsFwi6GC42eFe6Hs9` | `hive:magi.test1` | 16227 (= head − 3840) | 25 REAL staked migrations, REAL `advance` across day 30 |
| `vsc1BWgqk3Y3RQxkufJUTcSAXXuKm3R3ueYXpE` | `hive:magi.test2` | 16439 (= head − 3780) | the simulation rig — the sweep below |
| `vsc1BViXqnN5Zd9aJ1kZVH9Ft7RZpaB1AipSoW` | `hive:magi.test3` | 1 | a 168-day walk, to get the per-day slope cold |

### The backdating trick extends to the maturity day

`init(currentHeight − 3840)` puts the contract at **day 32 the moment it is
created**, and `migrate_batch` stamps every migration mint at the *genesis*
height, so all of them mature on day 30 — a day the walk then has to cross for
real, in the same session. Two things make this work and are worth writing
down:

- **`migrate_batch` does not advance the walk.** `registerMints` calls
  `Accrue(ctx.Height)` with `ctx.Height = genesis`, i.e. `DayOf = 0`, which is
  a no-op. So `cfg_settled` stays at `cfg_genesis` and migration stays open
  however far the chain has actually moved past the backdated genesis.
- **The first REAL `advance` closes migration forever.** `CreditMigrationBatch`
  refuses once `cfg_settled > cfg_genesis`. Simulations run on top of persisted
  state, so once a real `advance` lands, no further seeding is possible even in
  simulation. **Seed everything first; broadcast `advance` last.** (Learned the
  expensive way: contract #1 was advanced before the sweep was finished, which
  is why contract #2 exists.)

---

## 1. What one slice of the drain costs

Measured on contract #2 with `simulateContractCalls`. The instrument is
`advance|<days>`: `advance|30` walks days 0–29 without touching day 30, then
each `advance|1` performs exactly one drain slice. That isolates the drain from
the ordinary day-walking, which would otherwise creep as the devnet advances.

| entries on day 30 | `advance\|1` gas | rc | result |
|---|---|---|---|
| 0 | 49,540,313 | 496 | plain 1-day step (the control) |
| 30 | 367,785,664 | 3,678 | drained, day complete |
| 60 | 673,422,743 | 6,735 | drained |
| 90 | 979,059,912 | 9,791 | drained |
| 120 | 1,284,697,055 | 12,847 | drained |
| 150 | 1,590,334,198 | 15,904 | drained |
| 180 | 1,898,474,166 | 18,985 | drained |
| **200 (the budget)** | **2,090,259,133** | **20,903** | **"advanced; still behind, call again"** — cursor stored |
| the 10 left over | 165,594,991 | 1,656 | next call completes the day |

**Marginal cost: 10,187,905 gas per account retired** — constant to within
0.001% from 30 to 180 entries (each 30-entry step costs 305,637,1xx). The
retirement is one `shr_` read plus one `shr_` write per account and it prices
exactly like that: **~102 RC per migrated account, paid once, at maturity.**

**Against the 10,000,000,000 hard ceiling** (`rc_limit` caps at 100,000 and
100,000 gas = 1 RC), a full 200-entry slice uses **20.9%**. There is **4.8x
headroom**; the budget would have to rise to roughly **950** before a slice
stopped fitting.

## 2. Confirmed by a real broadcast

Contract #1 carried 25 migration mints created by a genuine `migrate_batch`
broadcast (`ok=true "migrated 25 of 25"`, 25 entries in `expl_30_0`,
`explc_30="1"`). A real `advance` at `rc_limit 8000` then crossed day 30:

```
result[0]: ok=true ret="accrual is current"      charged 4,401 RC
```

State read back afterwards:

| key | before | after |
|---|---|---|
| `acc_day` | (absent) | `32` |
| `cfg_settled` | `16227` (= genesis) | `20067` (= genesis + 32·120) |
| `exp_30` | `1250371100` | **deleted** |
| `expl_30_0` | 25 `account,shares` entries | **deleted** |
| `explc_30` | `1` | **deleted** |
| `accAt_30` | (absent) | written |
| `shr_hive:mgr000000` | `50000000` | **`0`** |
| `shr_hive:mgr000024` | `50029688` | **`0`** |

So the rule holds on a real chain: **all voting power ends at maturity**, the
walk retires it, and the day's bookkeeping cleans itself up. `gov_board` still
lists the accounts — as designed, the board can only wrongly EXCLUDE, and
`ConsensusGroup` re-reads `shr_` live, so a board full of zero-share names
resolves to an empty governing set rather than a haunted one.

## 3. How many calls the real migration needs

`tools/snapshot/data/migration_set.json` (3-month set): **2,260 migrating
accounts, of which 1,583 carry stake** and therefore create a migration mint.
Worst case is every one of them claiming before day 30.

`ExpiryChunkSize = 25` and `MaxRetirePerWalk = 200` means **8 chunks per call**:

| entries maturing | chunks | `advance` calls | total RC |
|---|---|---|---|
| 1,583 (real 3-month set, all claimed) | 64 | **8** | ~165,000 |
| 2,000 | 80 | **10** | ~209,000 |
| 4,000 | 160 | 20 | ~418,000 |

Plus one ordinary 30-day walk (~2,958 RC) to reach the day in the first place.
**No single call comes near the ceiling** — the cost is a call count, not a
wall.

On mainnet `rc_limit` is **frozen for five days**, so ~209,000 RC means
~209 HBD of MAGI capacity parked if the whole drain is done in one sitting.
Spreading it over a few days costs nothing but patience; `advance` is
permissionless and pays the caller nothing, so whoever does it is doing it out
of self-interest (nobody can mint or claim until it is done — see below).

## 4. 🔴 The finding that matters: users are blocked, and they pay for it

While the day-30 list is still draining, `Accrue` cannot catch up in one call,
and every entrypoint that requires a current accumulator refuses. Measured on
contract #2 with 211 entries pending (simulated, `hive:magi.test2`):

| call | success | gas | rc | message |
|---|---|---|---|---|
| `mint 1 LC / 30d` | **false** | 2,246,511,761 | **22,466** | `accrual is behind; call advance then mint again` |
| `claim_mint 1` | **false** | 2,255,119,753 | **22,552** | `accrual is behind; call advance then claim again` |
| `transfer 1 LC` | true | 28,022,843 | 281 | `transferred` — unaffected |
| `settle_pending` | true | 25,920,071 | 260 | `anchored` — unaffected |

and, once the drain has finished, straight back to normal:

| call | success | gas | rc |
|---|---|---|---|
| `mint 1 LC / 30d` | true | 221,914,305 | 2,220 |
| `claim_mint 1` | true | 133,083,263 | 1,331 |

**The refusal is not free.** `app/main.go`'s `finish()` calls `sdk.Abort` on a
failed `Result`, which discards the call's writes — so the 200 retirements the
failed `mint` just performed are thrown away, and the next caller starts from
the same cursor. The user pays for work that does not happen.

On mainnet it is worse in a different way: `RC_LIMITS.mint` is **7,000**, so the
call would not reach the refusal at all — it would `gas_limit_hit` at 7,000 RC
and freeze that for five days.

**Who is NOT affected, and this is the important half:** a *matured*
`claim_migration` never calls `Accrue` — `state.ClaimMigration` takes the
`else` branch for a mature mint and settles it arithmetically
(`contract/state/claim.go`). Pre-maturity claims do call `Accrue`, but by the
time day 30 is being crossed there are no pre-maturity claims left. **So the
migration claim flow itself keeps working throughout the drain.** It is capital
minting and mint-claiming that stall.

## 5. `MaxAccrualDays = 1200` — adequate

Measured cold on contract #3 (genesis at height 1, so a 168-day walk with no
mints and no expiry days):

| `advance\|days` | gas | rc |
|---|---|---|
| 1 | 141,132,131 | 1,412 |
| 10 | 188,768,324 | 1,888 |
| 50 | 350,428,270 | 3,505 |
| 100 | 546,328,750 | 5,464 |
| 150 | 752,289,184 | 7,523 |
| 168 (all of it) | 824,382,964 | 8,244 |
| 1200 (capped by the chain's age) | 828,388,244 | 8,284 |

**Fit: `gas ≈ 137M + 4.09M · days`**, linear across 168 days. Extrapolated, a
full `MaxAccrualDays = 1200` walk is **≈ 5.04B gas / 50,400 RC** — under the
10B ceiling, and consistent with CLAUDE.md's independently measured mainnet
figure of 5.85B for the same walk. The 1,095-day catch-up that the constant
exists to guarantee costs ≈ 4.62B / 46,200 RC.

Worst case for a single call — a 1,200-day walk that also crosses a 200-entry
expiry day — is ≈ 7.1B gas / 71,000 RC. Still inside the ceiling, though it
would need an `rc_limit` most people do not have.

## 6. Actions

**Nothing in the contract needs to change.** `MaxRetirePerWalk = 200`,
`ExpiryChunkSize = 25` and `MaxAccrualDays = 1200` all execute with room. Two
frontend fixes and one judgement call:

### 🔴 `RC_LIMITS.advance = 4_000` cannot cross the maturity day

`api/src/aioha-signer.ts` currently carries

```ts
advance: 4_000,   // no-op 100; one ordinary day ~5,000 gas => tiny
```

A maturity-day slice needs **20,903 RC**. Every `advance` the site sends on
that day would `gas_limit_hit` and the walk would never move — while `mint` and
`claim_mint` stay refused. **Raise it to at least 25,000** (or size it per call
the way the claim page sizes `claim_migration`: the frontend can read `acc_day`
and `explc_<day>` and know exactly which case it is in).

### 🟠 Refuse to sign `mint` / `claim_mint` while accrual is behind

`RC_LIMITS.mint` and `.claim_mint` are 7,000; the call needs 22,500 mid-drain.
The site already reads chain state — comparing `acc_day` against the current
day is one read, and it turns a `gas_limit_hit` that costs the user five days
of frozen RC into a sentence: *"the chain is settling the migration maturity
day; press Advance, then mint."*

### 🟡 Consider whether 200 is the right budget — a judgement call, not a bug

A slice costs 20,903 RC. A fresh account's entire free allowance is **10,000
RC**, and there is no way to buy a smaller slice: `AccrueSteps` takes a
`maxDays` argument, but `retireBudget` is hardcoded to `MaxRetirePerWalk`. So
**only an account with ≳21 HBD parked on MAGI can push the walk across the
migration maturity day.** In practice that is fine — the founder will do it, and
it is a once-ever event — but it does mean the permissionless escape hatch is
not actually available to everyone on the one day it matters most.

Lowering `MaxRetirePerWalk` to **75** (three chunks, ≈7,700 RC) would put the
crossing inside any account's free allowance, at the cost of 22 calls instead of
8 for the real snapshot. Since `advance` pays nothing either way, more cheap
calls that anyone can afford is arguably the better shape. **Not changed here —
flagging it for Lasse's call before the freeze.**

⚠️ **Hard constraint if it is ever touched: `MaxRetirePerWalk` must be ≥
`ExpiryChunkSize`.** `drainExpiryList` skips a chunk whose length exceeds the
remaining budget (`if *budget < len(entries) { … return false }`), so a budget
smaller than one chunk would make the walk refuse forever and wedge the chain
at that day permanently — with no admin key to fix it. Any new value should be
an exact multiple of 25.

## 7. Caveats

- **Floors, not ceilings.** Every figure was taken against a nearly-empty
  contract. Real state is much larger; MAGI's IO gas weights writes 19x reads,
  and the drain is one read + one write per account.
- **Warm vs cold.** The sweep in §1 measures calls 2+ inside a single
  simulation, where the seeding calls have already touched the same `shr_`
  keys. The one cold datapoint — contract #1's real broadcast, 32 days + 25
  retirements for 4,401 RC — implies ~6.9M gas per entry against the sweep's
  10.19M. The headline number is therefore **conservative**, and the 4.8x
  ceiling headroom survives an error of either sign.
- **RC accounting differs from mainnet.** This devnet charges *actual* RC used;
  mainnet freezes the full `rc_limit` for five days. Size `rc_limit` from
  measured gas, never from what the devnet lets you get away with.
- **Devnet artifact, not a bug:** `accAt_30` read back as `0` on contract #1.
  The devnet's active share base (12.5 LC) is below
  `engine.MinSharesForAccrual` (100 LC), so the day's inflow was HELD rather
  than distributed — the documented overflow guard doing its job. At the real
  13.8M L-Share base it cannot arise.
- Devnet witnesses run this checkout. Confirm anything consensus-critical
  against mainnet.

# LasseCash — Core Migration to MAGI

> This file is loaded automatically at the start of every session.
> It is the durable record of locked decisions. If something here conflicts
> with a suggestion made mid-conversation, **this file wins** — challenge the
> suggestion, don't silently drift.

## Golden rule — REVISED 2026-08-20 (supersedes "backend does all calculations")

**One engine, everywhere.** The Go engine is the only implementation of
LasseCash economics. It runs on-chain (TinyGo → `wasm-unknown`), in the dev
chain (native Go), and in the browser (TinyGo → `wasm` js target). The frontend
may compute previews freely — but only by **calling** the engine, never by
reimplementing a formula in TypeScript.

**The chain remains the only source of truth.** A preview is a preview;
anything that becomes a transaction is confirmed by the chain.

### Why the rule changed

The original rule ("the backend does all calculations") was protecting against
a real danger — a second implementation of the money math drifting from the
first — but it banned computation wholesale, which cost user experience. A vote
slider that round-trips on every drag event feels broken, and worse, the
round-trip buys latency without buying accuracy: the true payout depends on
every vote cast between preview and broadcast, so it is an estimate wherever it
is computed.

Shipping the actual engine to the browser resolves the tension. Measured:
**81,276 bytes** of WASM plus a 16KB shim, **0.36 ms per call** — a 60fps
slider has a 16ms budget, so 45x more headroom than needed. Same source, same
math, byte-identical results, zero drift.

### The three-way split this implies

| Kind of value | Where it is computed | Staleness |
|---|---|---|
| **Pure functions of user input** — mint multipliers, shares at a given rate, loyalty multiplier, vote cost | Browser, **exactly** | None possible |
| **Functions of live pool state** — swap output, yield share, vote value | Browser **estimate** from last-fetched state; must be labelled, and protected by `minOut` on submit | Reserves move between quote and broadcast — this is how Uniswap works |
| **Balances and settled amounts** | Chain only. Never estimated | n/a |

Backend quote endpoints remain: they are the authoritative confirmation before
signing, and `MagiBackend` needs them because the browser cannot know the live
reserves at broadcast time.

## Locked technical decisions

| Decision | Choice | Locked |
|---|---|---|
| Precision | **8 decimals**, `1 LC = 100_000_000` base units | 2026-08-20 |
| Money math | **Integer / fixed-point only.** No floats in any accounting path, ever | 2026-08-20 |
| Economic engine | **Go**, written once | 2026-08-20 |
| On-chain contracts | Go → **TinyGo → WASM** (MAGI requirement, not a preference) | 2026-08-20 |
| Dev simulator | Same Go engine compiled as a local node that mimics MAGI's API | 2026-08-20 |
| Read/indexer API | TypeScript, thin — aggregates chain state, computes nothing novel | 2026-08-20 |
| Frontend | TypeScript + SvelteKit | 2026-08-20 |
| Hive auth | Aioha (`@aioha/aioha`; note `@aioha/react-provider` is unsupported) | 2026-08-20 |

**Why the engine is Go and written once:** the consensus contract *must* be
Go/TinyGo on MAGI. If the dev simulator were TypeScript, the L-Share formula,
the bleed curve and the penalty slash would exist in two languages and would
drift. A rounding difference between backend and chain means the dashboard
promises a payout the chain won't pay. One implementation, two compile targets.

## MAGI (Virtual Smart Chain) — verified facts

- Contracts: Go compiled with TinyGo to WASM. `//go:wasmexport` entrypoints.
  All entrypoint params and returns are `*string`.
- Build: `tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
  -target=wasm-unknown -o artifacts/main.wasm ./contract`
  (Docker image `tinygo/tinygo:0.39.0`). **No goroutines, channels, or defer.**
- Template: https://github.com/vsc-eco/go-contract-template
- Contract state: `sdk.StateSetObject/GetObject/DeleteObject`, `StateSetU64`.
- Assets: SDK only knows `hive`, `hive_consensus`, `hbd`, `hbd_savings`.
  **LASSECASH is a contract-managed token** — balances live in contract state.
- Node query API: **GraphQL**, `https://api.vsc.eco/api/v1/graphql`.
- Client lib: `@aioha/magi` + `@aioha/aioha` + `viem`.
- Docs: https://docs.magi.eco/

### Block time & height semantics — VERIFIED FROM CHAIN 2026-08-20

Do not re-litigate this; it was measured, not assumed.

- `Env.BlockHeight` is the **Hive block height**, advancing every **3 seconds**.
  Measured: height 109,189,570 → 13:02:24, height 109,189,590 → 13:03:24
  (20 heights / 60s).
- **MAGI blocks are produced every 10th height = every 30 seconds.**
  `witnessSchedule` slot spacing is a constant 10, verified across heights
  100,000,000 → 109,190,000. A round is 120 slots = 1 hour.
- Therefore the spec's `31,536,000 blocks = 3 years` is **correct** when read
  as *heights*. What was wrong is the phrase "per-block reward": real payouts
  happen every 10th height, in chunks 10× larger (era 1: 3.17097910 LC per
  MAGI block, not 0.317).
- **Consequence for all engine code:** emission and yield are NEVER accumulated
  per tick. They are closed-form functions of height, settled as a difference
  between the last settled height and the current one. A contract may run
  irregularly or not at all for long stretches; the math must not care.

### Liquidity pair: LASSECASH:HBD — CONFIRMED

TibFox was right. Magi routes **every** pool through HBD as the single base
asset (BTC → HBD → ETH). There is no LASSECASH:HIVE or LASSECASH:BTC option.
The migration pool and the 25% liquidity reward pool are **LASSECASH:HBD**.
This supersedes both §3 (`:BTC`) and §6 (`:HIVE`) of the spec — the source
`.odt` should be corrected.

## Tokenomics invariants — NEVER violate

These are verified by [tokenomics_check.py](tokenomics_check.py). Re-run it
after any change to emission code. Treat a failure as a launch blocker.

1. **Historic hardcap: 51,000,000 LC.** Absolute. Includes everything ever
   issued, pre- and post-migration.
2. **Post-migration emission cap: 20,000,000 LC.** Separate, additional
   ceiling on *new* tokens. Approached asymptotically, never reached.
3. **Therefore:** `migrated_supply + total_emitted <= 51M`, which requires
   `migrated_supply <= 31,000,000 LC`. ✅ **VERIFIED**: the 12-month snapshot
   migrates 19,068,736.06 LC, leaving 11.93M of headroom. The contract enforces
   this in `CreditMigration` — the only point where supply enters from outside.
4. **Rounding always floors.** Integer division on emission means the chain
   under-issues, never over-issues. Rounding must never be able to breach a
   cap. If you ever find yourself writing `round()` in emission code, stop.
5. Era = `31,536,000` blocks @ 3s = 1095 days, called "3 years".
6. Halving = 50% per era, integer `//= 2`.

### Verified emission schedule (exact, 8dp, spec's −50%/era)

Produced by `engine` tests, not by hand.

| Era | Years | Budget (LC) | LC / height (3s) | LC / MAGI block (30s) |
|---|---|---|---|---|
| 1 | 1–3 | 10,000,000 | 0.31709791 | 3.17097910 |
| 2 | 4–6 | 5,000,000 | 0.15854895 | 1.58548950 |
| 3 | 7–9 | 2,500,000 | 0.07927447 | 0.79274470 |
| 4 | 10–12 | 1,250,000 | 0.03963723 | 0.39637230 |
| … | … | … | … | … |
| 26 | 76+ | — | **0** | emission ends |

Emission ends **year 75**. Total ever issued **19,999,994.01840000 LC**
(5.9816 LC stranded by integer flooring — correct and intentional).

### Longevity — DECIDED 2026-08-20: keep −50%/era, ends year 75

Lasse's call, and it is sound. 75 years is longer than the internet has
existed, so optimising the year-2100 tail is false precision. Ship the simple
version.

⚠️ **CORRECTED 2026-08-21.** This section used to say "the intent is a hardfork
to something new in 3–7 years anyway". That was never Lasse's position and it
must not be used as an argument again. In his words: *"no I dont, its a
possibility maybe the migration tokenomics will run for 50 years like
bitcoin."* Design for the 75-year run. A hardfork is a possibility, not a plan,
and nothing may be left sloppy on the assumption that it gets replaced.

**Known accepted limitation:** penalties/bleed/liquidation feed only the
**L-Share** pool, so after emission ends in year 75 the Proof-of-Brain and
Liquidity pools have no funding source. Accepted deliberately — not worth the
complexity now. Mitigation: the penalty destination is a single named constant
in the engine, so a future hardfork can redirect it (e.g. through `Split()`)
without restructuring anything.

### Longevity lever — reference table

The reduction rate, not the era length, is the real lever. Total stays exactly
20M in every row; only the shape changes. Cost of a longer tail is lower
early-year rewards.

| Cut per era | Era-1 budget | LC / MAGI block | Emission ends |
|---|---|---|---|
| −50% (spec) | 10,000,000 | 3.17097910 | year 75 |
| −33% | 6,666,666 | 2.11398610 | year 126 |
| −25% | 5,000,000 | 1.58548950 | year 174 |
| −10% | 2,000,000 | 0.63419580 | year 447 |
| −5% | 1,000,000 | 0.31709790 | year 876 |

For reference: **Bitcoin's issuance ends ~2140** — 114 years from now, 131
from genesis. Bitcoin is not "forever" either.

**A hard cap and perpetual new issuance are mathematically incompatible.**
"Forever" must come from *recycling*, not issuance — LasseCash already has
three recycling sources (early-mint penalty slash, the 4-month bleed, and
day-120 liquidation) which all sweep into the reward pool. Recycled tokens are
not new issuance and never touch the cap, so the reward pool can pay out
indefinitely after emission ends. Emission is the bootstrap; recycling is the
perpetual engine.

### Per-block allocation (of every block reward)

- **50%** Proof-of-Brain — LasseMedia creators + curators
- **25%** L-Share yield — long-term minters
- **25%** Pool rewards — DEX liquidity providers

## LasseMint rules — DECIDED 2026-08-20

All three ambiguities resolved by Lasse. These are now specification.

**Early End Mint — recovery rises 50% → 100%, linearly.**
End on day 1 of a mint: recover 50% of principal, forfeit all rewards.
End at maturity: 100% of principal plus all rewards. Linear between.
Slashed principal sweeps to the L-Share reward pool.

**Post-maturity timeline — applies to principal AND rewards.
GRACE WIDENED 30 → 90 DAYS, 2026-08-22.**
```
maturity ──90d grace (nothing happens)──► ──90d bleed 100%→0%──► day 180: zero
```
Grace exists so illness or forgetfulness costs nothing. Bleed is linear per
height. Everything bled sweeps to the L-Share reward pool.

**Why 90.** Thirty days was the harshest parameter in the design. Someone who
locked faithfully for three years and then spent six weeks in hospital could
not even ARM Good Accounting — the window is `[maturity, maturity+GraceDays)`
— and was already bleeding, at zero by day 120. Three years of good behaviour
undone by one bad month. Ninety days is the same quarter of warning the pool's
dormancy check gives an LP, and the principle is the same: **be tight with
people who were GIVEN tokens, generous with people who COMMITTED capital.** A
matured mint is committed capital. Recycling still happens, just later.

Two figures move with it, both DERIVED, neither a new constant:
- **Good Accounting arming window → 90 days** (`GoodAccountingArmDays = GraceDays`)
- **Migration claim window → 210 days ≈ 7 months**
  (`MigrationMintDays 30 + GraceDays 90 + BleedDays 90`, see
  `state.ClaimDeadlineHeight`). The announcement must say seven months, not
  five.

**Good Accounting Mode — armed DURING THE GRACE PERIOD AFTER MATURITY (90
days since 2026-08-22).
REVISED 2026-08-21 (supersedes "final 7 days before maturity").** Lasse,
after comparing with HEX (which arms only after maturity, by anyone): *"lets
do that that you can only run good accounting after maturity and that gives
them 1 month to do it.. thats much more clean."* The owner is then looking at
a matured, whole position with a real decision in front of them. It CANNOT be
armed before maturity (nothing to decide yet) and CANNOT be armed once the
bleed has started — so nobody can watch themselves lose value and opt out
retroactively; the anti-abuse rule holds by construction. Unlike HEX it stays
**owner-only**: a stranger must not reshape someone's tax timing.
`GoodAccountingArmDays = GraceDays`; `CanArmGoodAccounting` is
`[maturity, maturity+GraceDays)` — 90 days since 2026-08-22. Trade-off
accepted: an owner who misses the grace period cannot be rescued by anyone —
consistent with "pay attention", but a quarter is long enough that only
genuine absence loses it.
(History: decided as "final 7 days" on 08-20; the code shipped with 30 days
BEFORE maturity by mistake, which Lasse caught on the dashboard 08-21; the
discussion that followed produced the after-maturity rule.)

Once armed it **extends the grace period to 3 years (1095 days)**, then the
ordinary 90-day bleed runs; full liquidation at day 1185 after maturity.

- Implemented as one constant, not a second state machine: Good Accounting
  changes `GraceDaysFor()`, nothing else.
- 3 years, not 1: tax years are annual, so a 1-year window offers only a single
  year-end to choose from. Deferral is usually about reaching a low-income or
  loss year, rarely next year specifically. 3 years gives four tax years.
- Finite on purpose. An infinite hold would strand the principal of anyone who
  lost their keys, permanently starving the recycling engine that funds the
  reward pool after emission ends in year 75.

**ALL voting power ends 100% at maturity — DECIDED 2026-08-21 (supersedes
"held shares vote until claimed").** Lasse: *"the governance voting power and
the post voting power should end 100% at maturity for all mints!!"* Grace is a
claim safety-net, not a voting extension. Implemented in the accrual walk: at
registration each mint appends to its maturity day's chunked per-account
expiry list (`explc_/expl_/explp_` keys, `ExpiryChunkSize=25`); the walk
drains the list when it crosses the day, retiring the shares from the owner's
`shr_` exactly like it already retired them from the active total. Bounded by
`MaxRetirePerWalk=200` per call and resumable mid-day via a cursor, so the
migration day (thousands maturing together) is crossed over several `advance`
calls — `TestExpiryDrainResumesAcrossWalkCalls` pins it. A close that beats
the walk (early end, maturity-day claim) releases the shares itself and
removes its list entry (`Mint.ExpChunk` locates it; mint codec field 8,
append-only). **Consequence for the public ABI: `shr_` is now LIVE voting
weight — a matured, unclaimed mint votes with NOTHING**, so a dApp reading
`shr_` inherits the correct set and no dead account can haunt the top-10.
`TestVotingPowerEndsAtMaturity` replaced the old pin. Good Accounting remains
strictly owner-only (Lasse rejected HEX-style third-party arming: a stranger
must not reshape someone's tax position).

**Burning credits `hive:null` — DECIDED 2026-08-21 (supersedes "burns are
recorded against a counter").** Lasse: the null account keeps the tokens *"so
we always can see how much is burned in the future"*. Hive's `null` has no
keys, so `hive:null` is provably unspendable on MAGI. `state.BurnAccount`;
`burn()` is the one way value is ever burned (user `burn`, PoB burn payout
mode); `TotalBurned() = Balance(hive:null)`; `sup_burned` key retired, never
reuse. **The supply identity is now `sum of all holdings = migrated +
emitted`** — nothing is ever destroyed, burns stay visibly quarantined.
At migration EVERYTHING that does not migrate (protocol accounts + non-
qualifying holders, LASSECASH and POWER alike) is credited to hive:null as
LIQUID in one aggregate — never a mint; the contract refuses `null` staking,
so null can never vote or recycle. Verified on the dev chain: migrated
29,763,159.24433197 (full snapshot), hive:null holds 10,694,423.18328573
(current pre-rescan criteria), + 20M emission = 49.76M < 51M cap. The ~1.24M
gap to Hive-Engine's 31M issued is dust lost in the Steem-Engine/Hive-Engine
years — accepted, history lives on those chains.

**The burn is recorded PER ACCOUNT — `burn_batch`, DECIDED 2026-08-21.**
Lasse: it must be *"written in history that they had these lassecash and
lassecash power"* — not an anonymous lump at null. So non-qualifying accounts
go through their own owner-only genesis entrypoint `burn_batch` (same
`<acct>,<liquid>,<staked>|…` wire format as `migrate_batch`, same atomic /
idempotent / hardcap discipline): each account's LASSECASH + POWER is
credited to hive:null AND a permanent receipt is written. **`mig_<acct>` is
now the receipt, not a "1" marker**: `liquid|staked` for migrated accounts,
`burned|liquid|staked` for burned ones (`state.MigrationRecord` reads it; the
one-credit guard is unchanged — a burned account can never be migrated later
nor vice versa). The Hive L1 custom_json carrying each batch is the second
public record. `tools/migrate.py` runs migrations then burns (two work lists,
one progress file); rehearsed on a virgin dev chain: 1,985 migrated + 7,923
burned (zero-holders skipped) in 199 batches, 29,763,159.24433197 exact,
receipts readable. Entrypoints now 25; WASM 83,003 bytes. `mig_<acct>` is
worth treating as part of the frozen public ABI — it is history.

**Dead positions are sweepable — `sweep_mint`, DECIDED 2026-08-21.**
Claiming was the only path that recycled a mint's value and released its
shares, so a fully-bled, never-claimed mint stranded its principal outside the
reward pool forever AND kept its `shr_` governance weight forever — a zombie
seat nobody could evict after the key burn. `SweepMint(owner, id)` is
permissionless, pays the caller NOTHING (same reasoning as `SweepCuration`),
and runs through `endMint` — the SAME settlement as a claim — refusing unless
the owner is owed exactly zero. So it can only ever touch positions already
worth nothing, and it is what makes Good Accounting's deliberately-finite
grace actually deliver its promise that key-loss cannot starve the recycling
engine. Tests: `TestSweepMintReleasesDeadPositions`,
`TestSweepMintRespectsGoodAccounting`. Entrypoints now 24; WASM 79,378 bytes.

**Multipliers are MULTIPLICATIVE — 1.5 x 1.5 = 2.25x maximum.**
The two 1.5x ceilings are **hardcoded and immutable**. Only the *amounts* that
trigger Bigger Pays Better are governable (defaults 10,000 → 100,000 LC).

## Opening pool price — DECIDED 2026-08-20

Seed the pool near the prevailing Hive-Engine price and let the market take it
from there. Measured 2026-08-20:

| Source | Value |
|---|---|
| LASSECASH last price (Hive-Engine `market` metrics) | **0.02500000 SWAP.HIVE** |
| HIVE/USD | $0.04120439 |
| Implied LASSECASH | **≈ $0.00103** |
| HBD peg | $1.00 |
| **Opening ratio** | **≈ 0.00103 HBD per LASSECASH** |

So ~1,030 HBD alongside 1,000,000 LASSECASH. **Re-measure at launch** — this
is a method, not a fixed number. The first `add_liquidity` call sets the price,
so it should be Lasse's, at a deliberate ratio.

**SIZE DECIDED 2026-08-21: 100 HBD + the equivalent LASSECASH (~97,087 LC at
the 0.00103 ratio; recompute from the launch-day price).** Lasse: *"I dont
have more to spare, since we run this migration soon."* A thin pool is fine —
price impact per trade is high at first, which is exactly what attracts LPs
to the 25% emission slice (~2,283 LC/day in era 1) and arbitrage keeps the
price honest at any depth. The pool deepens as others add liquidity; the
opening RATIO is what matters, not the size.

## CLAIM-BASED MIGRATION — DECIDED AND BUILT 2026-08-21 (supersedes push)

**Why.** The push model (owner credits every account via `migrate_batch` /
`burn_batch`) needs ~8.8M RC ≈ thousands of HBD parked on MAGI for weeks;
Lasse's MAGI RC capacity is ~120k (110 HBD). *"I dont even have this kind of
money right now."* So the migration is PULL: the owner commits ONE Merkle
root; every holder claims their own leaf with a proof, paying their own free
RC (10,000 per account). **MEASURED on the devnet 2026-08-21:** a staked
claim before day 30 costs 4,017 RC, **5,892 worst case** (it creates the mint
AND takes a `gov_board` seat — board contention is +47%); liquid-only 1,042;
matured (grace) 1,327; bleeding 1,824; `record_burn` 590; any bad proof
~125 and writes nothing. Proof length is noise (0.43 RC per hash). Real
broadcasts matched simulation to the RC. `RC_LIMITS`: claim_migration
9,500 (inside a fresh account's free 10,000), and the claim page passes the
cheap 2,500 limit for liquid-only / matured claims; record_burn 1,000.
`mint` is 1,976 on this build (−18%). Devnet trick for post-maturity tests:
`init(currentHeight − 3700)` on the TESTWINDOWS build puts the contract at
day 31 instantly.
Owner cost: three transactions (`init`, `set_snapshot`, done).

**The tree IS the record.** Every account — qualifying AND burned — is a leaf
`sha256("lassecash-migration-leaf-v1|" + hive:acct + "|" + liquid + "|" +
staked + "|" + m|b)`; sorted-pair parents, odd node promoted, no direction
bits (`engine/merkle.go`, own 2 KB SHA-256 pinned to stdlib — crypto/sha256
cost 54 KB of WASM). Root on-chain (`cfg_migroot`), full leaf list published
in this repo (`web/static/migration/leaves.json`) and by root hash in a Hive
post — anyone can prove forever what any account held and whether it burned.
Lasse: *"THAT IS SO GOOD... we can do claim and still record everything
forever."* Proofs are served as ~617 per-prefix shard files; the page fetches
one. Tool: `./build.sh tree` (`node/migtree`, `node/cmd/merkletree`) — rerun
after ANY snapshot change; a test fails if the published root goes stale.

**THE CLAIM IS THE MINT.** Every migration mint runs on the shared clock from
genesis whether or not claimed — identical economics to push:

| claim on | the staked part |
|---|---|
| day 0–30 | a real 30-day mint, earning and voting from the claim onward |
| day 30–60 (grace) | the full minted amount, straight to liquid, no yield |
| day 60–150 (bleed) | the surviving fraction; the bled part recycles to the L-Share pool |
| after day 150 | refused; `sweep_unclaimed` (permissionless, once) recycles ALL unclaimed — stake and liquid — to the L-Share pool (Lasse chose pool over null: it is the tail of the same bleed) |

Liquid is always credited in full on claim. Nobody earns or votes before
claiming (Lasse: fine). `ClaimDeadlineHeight = genesis + (30+30+90) days` —
derived, not a new constant. Burned leaves can never be claimed; anyone may
`record_burn` a receipt (`mig_<acct> = burned|liquid|staked`) at their own
RC — moves nothing; null gets the burn total at `set_snapshot`. Supply
identity holds throughout: `sup_migrated` grows on commit (burn), on each
claim, and on the sweep; `sup_claimed ≤ cfg_migtotal` is checked.

Entrypoints: `set_snapshot <rootHex>|<qualifierTotal>|<burnTotal>` (owner,
once), `claim_migration <liquid>|<staked>|<proofHex,…>`, `record_burn
<acct>|<liquid>|<staked>|<proof>`, `sweep_unclaimed`. **The production build
carries 26 entrypoints and NO push path** — `migrate`/`migrate_batch`/
`burn_batch` moved to `app/push.go` behind `-tags push` (rehearsal/fallback
only; the simulator keeps them). WASM 90,499 bytes. UI: `ClaimMigration.svelte` at the top of LasseMint — hides
itself once `mig_<acct>` exists, refuses to offer a button if the served
root differs from the chain's, previews every figure via `previewMintClose`
on the synthetic genesis mint. Current root (3-month set, signed-ops
criteria, unstakes + delegations + Diesel pool + open orders counted):
`f22793d7…e9af2`, 9,924 leaves (1,985 claimable, 7,939 burned); re-taken at
the announced block. Verified end to end on the simulator.

**Launch-day consequences:** Hive-Engine LASSECASH keeps existing; the
announcement and the token's info tab must say it is dead. Everyone needs a
MAGI-capable wallet to claim (they need it to use anything anyway).
Claim window: 5 months. The founder claims first and holds most early
shares for the one migration month — accepted.

## LASSECASH:HBD pool — BUILT 2026-08-20

**We build the AMM ourselves.** Verified: the contract SDK exposes NO pool,
swap or liquidity primitives — `GetBalance` / `HiveDraw` / `HiveTransfer` /
`HiveWithdraw` is the entire asset surface, and the node's GraphQL API has zero
pool types. Magi's native pools pair MAPPED assets (BTC/ETH/SOL) against HBD;
LASSECASH is a contract-managed token, so it cannot enter one.

It does not need to. `hbd` IS a first-class SDK asset, so the contract custodies
**real HBD** on one side and its own LASSECASH ledger on the other.

- **Constant product** (x·y=k), same shape as Hive-Engine Diesel pools.
- **Swap fee: ZERO. Hardcoded, not governable — REVISED 2026-08-20.**
  There is no fee parameter and no governance path to a non-zero fee; the
  earlier `pool.swap_fee_bps` registry entry has been **deleted**. Lasse's
  call, and the reasoning is sound:
  - LPs are paid from the **25% inflation slice**, which grows with the
    product's success. Trading-fee income would be noise beside it — Hive-Engine
    Diesel pools are the worked example of fee income never being meaningful.
  - **Arbitrage keeps the price honest for free.** Bots realign the pool against
    any external CEX/DEX venue because the spread is the profit; they do not
    need a fee rebate from us. A fee would only widen the no-arb band, i.e.
    give LasseCash holders *worse* prices.
  - A lever that exists eventually gets pulled. Deleting it makes "0% swap fee"
    a promise the code enforces rather than a default a future top-10 could
    quietly walk back. Reintroducing one now needs a timelocked, publicly
    visible contract update — the right bar for breaking a stated promise.
  - Enforced by two tests: `TestSwapTakesNoFee` (engine — `SwapOut` must equal
    the bare constant-product formula to the base unit) and
    `TestSwapFeeIsZeroAndNotGovernable` (contract — fails if any fee key is
    ever re-registered).
- **Loyalty bonus: LINEAR, +1%/day, capped at 90 days = +90% (1.90x).**
  Liquidity sits in the pool as **tranches**, each earning by its own age:
  day 1 → +1%, day 10 → +10%, day 30 → +30%, day 90 → +90%, and flat
  thereafter. Confirmed by Lasse 2026-08-20; the old About page's "1% per day
  up to 30 days, capping at 30% extra" is the same rule with a shorter cap.
- **Tranches are exited individually by id**, exactly like mints. Nothing is
  consumed oldest-first behind the user's back, so a partial exit can never
  silently destroy their most-matured loyalty position.
- **Reward claims re-register**: claiming removes the tranche's weight and its
  slice of the pool together, then re-adds the weight at the tranche's current
  age. Conserves exactly; an untouched tranche under-earns rather than over-earns.
- Every swap FLOORS in the pool's favour, so `k` can only ever grow.
- **LP rewards use a cumulative reward-per-weight ACCUMULATOR — FIXED
  2026-08-21.** `ClaimPoolRewards` used to split `pool_liq` by current weight
  at claim time: the same "claim last wins" bug the L-Share side had — a
  tranche added today could take half of last month's inflow. Now
  `syncPoolAccumulator` (keys `amm_acc`, `amm_accheld`, `amm_accseen`) folds
  inflow into the accumulator across the weight registered AT THE TIME, before
  every deposit/claim/withdrawal; a tranche's reward is `weight × (acc_now −
  acc_at_registration)`; tranche codec gained `accStart` (field 5, append-
  only). Claiming re-registers the weight at the current loyalty age for
  FUTURE inflow. `PoolRewardsOwed` is the read-only view the UI shows as
  `pending_reward`. Pinned by `TestLateLiquidityCannotClaimEarlierRewards`.
- **Claiming is lazy, never automatic** (no cron on MAGI; each write costs
  RC). Rewards accrue regardless; claim moves them to balance and refreshes
  loyalty. Withdraw = claim + principal, through the last COMPLETED day.

`state.Assets` is the interface for moving real HBD — `state/` must never import
`sdk`, so the HBD side is injected and mocked in tests. `auditPool` asserts the
contract's real HBD custody matches its bookkeeping on every pool test.

## Aioha wallet auth — BUILT 2026-08-20

**Aioha covers BOTH chains**, which was the key finding: `vscCallContract`
signs a MAGI contract call, `comment` publishes to Hive, and `signMessage`
produces the signature Hive's image server needs. There is no second signing
path and no `@aioha/magi` dependency.

Verified API (v1.8.5): `new Aioha()`, `registerKeychain()`,
`registerHiveAuth({name})`, `registerPeakVault()`, `registerHiveSigner(...)`,
`login(provider, username, {msg, keyType})`,
`vscCallContract(contractId, action, payload, rcLimit, intents, keyType)`,
`vscSetNetId(id)`, `comment(pa, pp, permlink, title, body, json, options)`,
`signMessage(message, keyType)`, `loadAuth()`, `getCurrentUser()`, `logout()`.

Providers: `keychain`, `hivesigner`, `hiveauth`, `ledger`, `peakvault`,
`metamasksnap`, `viewonly`. Key types: `posting`, `active`, `owner`, `memo`.

### The key-type split is a security boundary, not a detail

Login requests **POSTING** authority — enough to publish, vote and upload
images, and it **cannot move funds**. Every operation that touches value
(`mint`, `transfer`, `burn`, `claim_mint`, all the pool calls) requests
**ACTIVE** authority per call, in `AiohaSigner.ACTIVE_OPS`.

So signing in does not hand a website spending power. A compromised frontend
can annoy a user; it cannot drain them. **Adding a value-moving entrypoint
means adding it to `ACTIVE_OPS`** — forgetting would let posting authority
spend money.

### Dev vs wallet mode is derived, never toggled

`WALLET_MODE` comes from `VITE_CONTRACT_ID` being set, not from a switch. A
"use fake login" toggle that could be flipped in front of a real chain is a
footgun waiting for a bad day; `chain.signIn()` throws if called in wallet
mode. Absent contract id = dev chain + name-only sign-in, which is the honest
state until deployment.

Config: `VITE_CONTRACT_ID`, `VITE_MAGI_NET_ID`, `VITE_CHAIN_URL`.

### ⚠️ Unverified until a live wallet test

- **Image upload signing.** We compute sha256("ImageSigningChallenge" + bytes)
  and pass the hex digest to `signMessage`. Whether each provider signs the raw
  digest or re-hashes it must be confirmed against real Keychain/PeakVault.
- **`vscCallContract` payload encoding.** Our entrypoints take a single
  pipe-delimited `*string`; the payload parameter is typed `any`, so how VSC
  serialises it needs confirming on a test deploy.

Both are shaped correctly and both are cheap to fix once there is something to
test against — but neither should be assumed working.

## LasseMedia — content architecture

**Content lives on Hive. The contract tracks the money.** The contract stores
only `author + permlink + window + payoutMode + rshares` — no title, no body,
keyed exactly like the old Hive tribe. Publishing is therefore genuinely two
steps, and the code does them in this order:

1. write the article to the content layer
2. register it with the contract, opening the payout window

Order matters. If registration fails you have an unregistered article, which is
recoverable; the reverse would open a payout window over content that does not
exist.

`node/sim/content.go` stands in for Hive. It is a **separate file on a separate
type** deliberately, so it cannot quietly become a place where
consensus-relevant data hides.

### Curation is paid AUTOMATICALLY — the curation queue

**Nobody claims anything.** A curator who never opens the site is still paid.

The split-claim design exists for ONE reason: paying 201 curators inside the
payout transaction is unbounded iteration. Whoever settled a popular post would
pay for every curator in RC, and past a few thousand votes the post would
exceed the gas limit and become **permanently unpayable**. So payout stores two
numbers on the post — the curator pot and a snapshot of total vote weight — and
each curator's share is one O(1) sum: `pot * myWeight / totalWeight`, with both
figures decremented together so the pot can never be overdrawn.

That was a gas necessity leaking into UX. Two changes fixed it:

1. **`claim_curation` is PERMISSIONLESS.** The optional third argument names the
   curator; the reward always goes to them, never to the caller.
2. **The chain remembers what you are owed.** Every account's FIRST vote on a
   post appends to a per-account queue (`cq/`, `cqh/`, `cqt/` — a ring
   addressed by two cursors, not a slice, so a vote never rewrites a list).
   `SettlePending` drains the queue BEFORE reading the balance, so curation
   claimed this month lands in this month's mint.

Bounded by `MaxCurationDrain = 20` per call — the gas problem must not come
back through the fix for it.

⚠️ **20 IS A PLACEHOLDER AND MUST BE MEASURED.** It was chosen by judgement, not
by measurement, and the right number depends on MAGI's actual gas limit.
`simulateContractCalls` returns `gas_used` and `rc_used` for exactly this —
measure a full drain against a test deployment and raise the cap as high as
comfortably fits. Every unit raised is one fewer transaction an active curator's
client has to send.

**Who calls it — three layers, in order of how much they matter:**

1. **Piggyback on the voter's own transaction** (`PiggybackDrain = 3`). Voting
   settles a few of the voter's own outstanding claims. They are already
   sending a transaction and already paying RC, so it costs almost nothing —
   and it means an ACTIVE curator never builds a backlog at all. Kept small
   deliberately: voting must stay cheap, or people vote less, which harms the
   reward system more than a slightly longer queue.
2. **When the calendar month turns**, via `chain.settleOwed()`, which loops
   until the queue stops shrinking. Fire-and-forget, swallowing failures —
   housekeeping the user did not ask for must never raise an error dialog.

   **The trigger is the MONTH, not sign-in.** Hive users stay signed in for
   months at a time (Lasse: "I am logged in on hive sites like LasseCash
   forever"), so a sign-in-only settle would almost never fire. `refresh()`
   compares the chain's epoch against the last one settled, which is also
   exactly when there is something to settle: the monthly mint.
3. **Anyone, for anyone.** A script can settle for dormant accounts, but note
   that **the CALLER pays the RC** — this is not free, and at 6,000 accounts it
   is a real cost someone has to choose to bear.

### The RC guard — background work must not drain the user

MAGI has no fees; **RC is the cost of everything**. Spending a user's RC on
background settling could leave them unable to post, vote or transfer with no
idea why.

So `settleOwed` checks `client.hasRcHeadroom(0.25)` BEFORE each round and stops
while a comfortable majority of the meter is intact, surfacing
`settleStoppedForRc` so the UI can say *"paused, nothing is lost"* rather than
failing silently. RC comes from `getAccountRC` on the real node.

The floor is a **fraction of the account's own maximum**, not an absolute
number: a small account and a whale have very different meters, and an absolute
threshold would be either meaningless to one or a lockout for the other.

`DevBackend.resourceCredits()` returns **null (unknown)** rather than a fake
full meter, so the guard is exercised honestly in development instead of being
trivially satisfied and then failing in production.

### Curation expiry — ONE YEAR (decided 2026-08-20)

Unclaimed curation returns to the L-Share reward pool one year after a post
pays out. `SweepCuration` is permissionless and **pays the caller nothing** —
a bounty would create an incentive to lobby for a shorter expiry, and this must
only ever touch genuinely abandoned rewards.

A year is deliberately generous. Three layers already keep an active curator's
queue near empty, so reaching expiry means an account has been silent for
twelve months.

**The clock runs from the ACTUAL payout, not from when the window closed.**
Payout is permissionless and can happen late; measuring from the window close
would rob curators of however long settlement was delayed. Tested.

Queue entries pointing at a swept post clear themselves on the next drain
rather than jamming.

### What is NOT shown in the UI, and why

There is no "you are personally owed X" figure. Lasse's point: it would read
zero for anyone who opens the site, because opening it settles the queue. A
number that is almost always zero is noise, and computing it would mean walking
the queue per account for no benefit. Entries whose post has not paid out yet are left
in place and retried; skipping would lose the reward, and stopping at the first
open post would let one slow post block everything behind it.

Consequences, all tested:
- A curator who never claims is still paid (`TestCuratorNeverClaimsAndIsStillPaid`).
- Re-voting queues once, not twice.
- Manual claim followed by a drain pays once, not twice.
- A stranger settling for you cannot collect your reward.
- An account's FIRST ever earnings anchor that month and mint the next — the
  same rule capital minters get, so nobody mints a partial first month.

**No bleed on curation, deliberately.** The mint bleed enforces a promise the
minter made and was paid 1.5x for making. Curation is wages already earned;
confiscating it for inaction would punish something that costs the protocol
nothing. With the queue there is also nothing left to clean up.

### Payout modes — IMPLEMENTED 2026-08-20

Author's choice, set at publication and frozen with the post:

| Mode | Effect |
|---|---|
| `0` default | 20% liquid now, 80% into the monthly mint |
| `1` power up | 100% into the monthly mint |
| `2` burn | destroyed, and **recorded against total burned** |

Two rules inside this:
- **It applies to the AUTHOR's reward only.** Curators always take the standard
  split — one person's choice must never dictate how someone else is paid.
- **Burns are recorded**, not left in a pool. Otherwise declined rewards would
  silently inflate what is claimable and the supply audit would drift.

### Images — Hive's image server

Verified: `POST https://images.hive.blog/:username/:signature`, where the
signature is `sha256("ImageSigningChallenge" + imageData)` signed with the
**POSTING key**, and the account must clear a reputation threshold.

We should use it rather than host our own: every existing Hive post depends on
that infrastructure staying up, so it is maintained far beyond what we could
justify. It needs a wallet, so it lands with **Aioha**. Until then the compose
screen accepts pasted URLs, including existing `images.hive.blog` links.

### One markdown renderer

`web/src/lib/markdown.ts` is used by the compose preview, the feed cards AND
the post page. Three copies would drift and an author would publish something
that looked one way while writing and another once live.

**Security:** post bodies are attacker-controlled. Everything is HTML-escaped
FIRST, then our own tags are inserted, and every URL goes through `safeUrl()`
which permits only `http(s)` — a link or image `src` is a script-execution
vector otherwise. Never move an escape after a tag insertion.

Feed cards derive a cover image from the body when the author supplied none,
falling back to a YouTube thumbnail, so a video post is not a wall of text.

## Comments — DECIDED 2026-08-22

Lasse did not want to lose comment rewards ("a monster good valuable comment
[can] earn 100 or 1000 dollars"), and did not want the tip-bot spam. Both:

- **A comment is a registered reply** (`comment <permlink>|<parentAuthor>|
  <parentPermlink>|[mode]`), the same `post` machinery with a parent
  reference (post record fields 10–11, append-only). It runs VIRAL economics
  — 7-day window, viral pool, viral vote meter — but is gated by its own
  governable threshold `post.threshold_comment`: **floor 1, default 100,
  ceiling 10,000 L-Shares** (≈ $0.001 … $10 at the opening price; pinned by
  `TestPostingThresholdBoundsArePinned`). Only registered posts can be
  commented on.
- **On LasseCash a below-threshold commenter is refused BEFORE anything is
  written to Hive** ("need N L-Shares to comment"); the site preflights the
  threshold client-side.
- **A comment written from any other Hive frontend is shown on LasseCash
  only if its author holds the comment threshold** (read `shr_`); it earns
  only if registered. Below-threshold comments still exist on Hive — nobody
  is censored; they are simply not part of LasseCash. Tip bots and "nice
  post!" never appear. In Lasse's words: *"we make it better than anybody
  else."*
- Display: comments under their post, earning ones ranked first with their
  pending reward. No comment/reply tabs on profiles.

Production contract: 27 entrypoints. Frontend (reply box, comment list,
preflight, Hive-side display filter) follows; the comment WRITE path through
Aioha is verified at the wallet evening like every other signed call.

## No downvotes, no reputation — DECIDED 2026-08-22 (made explicit)

The contract accepts vote weights 1..100% only; zero or negative is refused
(`state.Vote`). You vote FOR what you value with your own stake, or you
withhold — you cannot subtract from someone else's reward. Reputation was
dropped years ago (themarkymark downvoted Lasse's Hive account). So: no
greyed-out posts, no hiding, no flag wars. A post nobody values earns
nothing and sorts by its (zero) pending reward. Every registered post and
comment is visible to everyone always, including crawlers; the ONLY filter
is the stake threshold at registration. Belongs on the About page.

## SEO & AI readability — BUILT 2026-08-22

Cloudflare Pages SSR (adapter-cloudflare, `nodejs_compat`, explicit
`_routes.json` — the default blew Cloudflare's 100-rule cap on the proof
shards). Server-rendered: `/@author/permlink` (canonical; `/post/…` 301s),
`/@name`, `/feed`, `/about` (prerendered from `docs/ABOUT.md`, which goes
through the escape-first post renderer — keep notes out of it). Client-only
(`ssr = false`): `/`, `/pool`, `/chain`, `/compose`, `/admin`. **No
economics server-side**: `Backend.postsMeta()` is the content-only half of
`posts()`, and reward figures are kept OUT of cached HTML (60 s cache; a
payout moves every 3 s). `$lib/Seo.svelte` + `$lib/site.ts`
(`PUBLIC_SITE_URL`); JSON-LD escapes `<>&` (titles are attacker-controlled).
Publish attaches `json_metadata {app: lassecash/2.0, canonical_url, format,
tags, description, image}` via `AiohaWallet.publishToHive()` —
`MagiBackend.publish()` must route through it or the canonical is given
away (TODO noted). `/robots.txt`, `/sitemap.xml`, `/feed.xml`, `/llms.txt`,
`/llms-full.txt`, `/@author/permlink.md`, `/about.md` all verified by curl on
the real Workers runtime; a post page's raw HTML carries title, body,
canonical, og:image, Article JSON-LD. Discovery files are capped at recent
history until a post index exists. Node 18 locally forced adapter v4 +
wrangler 3; bump Node. IPFS static build kept as a commented TODO.

## SEO & AI readability — DECIDED 2026-08-22 ("SUPER IMPORTANT")

Hive frontends are unfindable: client-rendered shells (crawlers see nothing),
the same post duplicated across five sites, no structure. Lasse: *"if we
can crack that nut we are 10 steps ahead."* The crack, all frontend/hosting:

- **Server-rendered content pages** (adapter-node): `/@author/permlink`
  renders title/body/author/date/cover as HTML before any JS; money figures
  still hydrate client-side from the engine (the server renders content,
  never derives economics — golden rule intact). Old `/post/…` URLs 301.
- **Canonical ownership on publish**: json_metadata `canonical_url =
  https://lassecash.com/@author/permlink`, `app: lassecash/2.0`. peakd and
  ecency honour it with their own canonical tag → every other frontend's
  copy points search engines back to us. No tribe does this.
- JSON-LD `Article`/`Person`, OpenGraph/Twitter cards, `<link canonical>`,
  `robots.txt`, `sitemap.xml`, RSS `feed.xml`.
- **AI-native**: `llms.txt` + `llms-full.txt`, every post as markdown at
  `/@author/permlink.md`, About at `/about.md`.
- **The canonical document**: `docs/ABOUT.md` is the ONE text — rendered at
  `/about`, identical to the GitHub README, and posted on Hive + LasseCash
  at the final announcement as the timestamped "rules people migrated
  under". The last edition of the old About page gets its own Hive post
  (end of the chaotic era, honestly labelled). Replaces tutorials/whitepaper:
  people ask their AI, which reads this. Include a "what changed from the
  2019 design" section so memory-trained AIs reconcile instead of blending.
- **Hosting DECIDED 2026-08-22: Cloudflare Pages + server functions**
  (adapter-cloudflare; Lasse already uses Cloudflare for his domains; free
  tier covers it). Workers runtime: no fs at request time (About text is
  imported at build time), Web APIs only, engine WASM stays client-side. A
  static build for an IPFS mirror stays possible from the same code.
- **"Headroom" is gone from the Chain page** (Lasse: "isn't these tokens
  essentially dead?" — yes). The hardcap picture uses the committed SNAPSHOT
  total (burned + claimable, `state.SnapshotTotal`, `snapshot_total` in
  ChainInfo), not merely what has been claimed; the remainder under 51M is
  labelled "lost on the old chains — never mintable" (issued on Steem/Hive-
  Engine, held by nobody, no issuer exists). Burned tile: "held by @null —
  unspendable, visible forever". `engine` bridge `supplyLimits` does the sum.

## Promote-by-burn — DECIDED 2026-08-22

Steem's promoted posts died in a dead tab where 0.00001 bought a position.
Ours: `promote_post <author>|<permlink>|<amount>` burns to null (visible
forever) and records the running total on the post (record field 12,
append-only). A promoted post gets a clearly labelled slot every Nth row
(frontend rule, starts at every 5th) of the SAME trending list, ordered by
burn, NEVER above the voted posts — money and votes are not mixed. Contract
rules: refused on comments, after payout, **once 75% of the window has
elapsed** (`engine.PromoteCutoffPct`; no burning for a slot that ends in ten
minutes), and below the governed minimum **`promote.min_burn`: floor 1,
default 100, ceiling 10,000 LASSECASH** (Lasse: 1M "would be crazy"; the ceiling is on the MINIMUM, no cap on what one may burn — a loud confirm on the button guards fat fingers) — the ceiling on the MINIMUM
stops a captured top-10 from abolishing promotion for everyone but
themselves. Pinned by `TestPostingThresholdBoundsArePinned`; behaviour by
`TestPromoteBurnsToNullWithinTheWindow`. Production contract: 28
entrypoints, 93,005 bytes. Frontend slot rule + promote button: to build.

## LasseCash Markets — DECIDED 2026-08-22 (post-launch track)

Lasse wants top-professional market data ("attract top traders", CMC /
CoinGecko / TradingView readiness, pays nobody ever). Design:
- **Index every trade, never sample.** Every swap is an on-chain tx; the
  recorder indexes each one (time, side, in, out, price, reserves after) —
  exact tick data from genesis, forever. Candles at any resolution derive
  from it. Cloudflare worker + D1 (free tier) fits the chosen hosting.
- **Chart**: TradingView *Lightweight Charts* (open source) on the Pool
  page — candles, volume, zoom; the licence-gated full Charting Library for
  indicators later.
- **Listing readiness**: a public API in the CMC/CoinGecko shape from the
  same index — `/pairs`, `/tickers`, `/orderbook` (synthetic AMM depth),
  `/historical_trades`. Acceptance is about volume/liquidity, not payment.
- **History**: MAGI-era perfect; Hive-Engine fills need a sidechain replay
  (public history ~1.5 y); Steem-Engine is archaeology. Check the existing
  `lassecash-price-stats` repo first — its README claims 2019→ data.
- **Main site vs stats site**: lassecash.com gets the price chart + a
  top-10 LP list (LPs discovered from tx history; the contract cannot
  enumerate); richlists and full LP tables stay on price-stats.lassecash.com,
  re-pointed at MAGI after migration. Additive, never touches the contract.

## Visual design — DECIDED 2026-08-20

**Anarcho-capitalist cyberpunk.** Direction chosen by Lasse from three options;
references were SkateHive (neon-on-black, monospace, glow) and the existing
LasseStats page.

The palette is not decoration: **black and gold IS the AnCap flag**, and
LasseCash already used gold. Leaning on it hard is on-brand and on-ideology at
once. Cyan is the only secondary, reserved for machine/terminal chrome so it
never competes with gold.

Rules that keep "cyberpunk" from becoming "unreadable":

- **Glow is for HERO NUMBERS ONLY.** If everything glows, nothing reads.
- Body copy stays high-contrast on near-black. No neon paragraphs.
- **Monospace for every number**, tabular figures, so digits do not jump as
  values update and the fixed 8-decimal form stays scannable.
- **RED IS RESERVED for value actively being lost** — the bleed, the early-end
  slash. Never for ordinary validation errors, or it stops meaning "you are
  losing money right now". Corollary caught during the build: *claiming* a
  bleeding mint is the correct action, so its button is gold-and-pulsing, not
  danger red. Danger red is for ending early, which forfeits yield.
- Faint engineering grid background, 1px gold/cyan rule under the header.

`MintTimeline.svelte` is the signature component: lock → maturity → grace →
bleed → zero as one bar, with a marker for where you are. **Segments are drawn
at FIXED widths, not to scale** — a 1095-day lock beside a 90-day bleed would
squash the bleed into a sliver exactly when it matters most. The marker is
positioned proportionally *within* its phase, so it still tells the truth.

Mints are **cards, not a table**. Eight columns clipped the primary action on
narrow viewports and left the timeline no room.

Mobile verified at 390px: nav wraps to its own row, stat tiles go two-up,
panels stack.

## Frontend (`web/`) — ALL FOUR PAGES BUILT 2026-08-20

SvelteKit 2 + Svelte 5 runes, `adapter-static`. The frontend is a pure client
of the chain — no server, nothing to render server-side that the chain has not
already computed.

```
./build.sh web     # http://localhost:5173  (needs ./build.sh node)
```

- `src/lib/chain.svelte.ts` — ONE client and ONE engine instance, shared. A
  per-component engine load would ship the same 104KB repeatedly.
- `src/lib/format.ts` — presentation only. Nothing here derives a value.
- `src/lib/MintForm.svelte` — the live preview. Calls the browser engine on
  every keystroke and slider tick, then **confirms against the chain before
  signing**, because the share rate ratchets with height and the volume
  thresholds are governed. If the authoritative figure differs, it shows the new
  number and makes the user submit again rather than silently signing.
- `src/lib/MintRow.svelte` — makes the BLEED impossible to ignore: red row, an
  explicit "losing value every block" line, and an early-end confirmation that
  states exactly how much yield is forfeited before anything is signed.

### Pages

| Route | What it does |
|---|---|
| `/` | **LasseMint** — mints, live mint preview, bleed alarm |
| `/pool` | **LASSECASH:HBD** — swap with slippage floor, tranches, loyalty |
| `/chain` | **Supply vs the 51M hardcap**, block split, consensus group, constants |
| `/feed` | **LasseMedia** — posts, vote slider, payouts, curation claims |

`src/lib/VoteSlider.svelte` is the component that justified revising the golden
rule. The **power cost is EXACT** (a pure function of the weight); the
**LASSECASH figure is an ESTIMATE**, labelled as one, because it divides a pool
that is still growing among rshares that are still arriving. A backend
round-trip per drag event would add latency without adding accuracy.

`/chain` reads its protocol constants from `engine.constants()` rather than
hardcoding them, so a bound can never drift from what the chain enforces.

Dev affordance: `?as=alice` signs in without a wallet. Harmless against a real
node, where the signer requires an actual Hive signature.

**Two bugs found by actually looking at the rendered pages:**
1. "Next payday" reported *no open mints* while a matured position sat in the
   table — the filter excluded anything already mature. Matured positions are
   claimable NOW and take priority.
2. On `/chain`, viral/deep showed 13%/38% nested under "Proof-of-Brain 50%" —
   correct as a share of the whole block reward, but nested there they read as
   though they did not add up. Now shown as a share of the PoB slice (25%/75%).

## Browser engine (`api/engine-wasm/`) — BUILT 2026-08-20

The Go engine compiled to `wasm` (js target) and shipped to the browser.
**104,035 bytes** + a 16KB TinyGo shim, **0.395 ms per call**.

`api/engine-wasm/main.go` is a BRIDGE, not an implementation — every function
forwards straight to `github.com/lassecash/engine`. It contains no arithmetic
beyond marshalling, because a formula written there would be exactly the second
implementation the golden rule prevents. Same for `api/src/engine.ts`: if a
preview needs a number the engine does not expose, **add it to the bridge**,
never compute it in TypeScript.

All values cross the bridge as base-unit STRINGS.

Exposed, and marked EXACT vs ESTIMATE in the TypeScript:

| EXACT (pure functions of user input) | ESTIMATE (depends on live pool state) |
|---|---|
| `mintQuote` `shareRate` `durationMultiplier` | `estimateSwap` |
| `volumeMultiplier` `loyaltyMultiplier` | `estimateRewardShare` |
| `voteCost` `voteWeight` `votePower` | `estimateLiquidity` |
| `routePayout` `blockSplit` | `previewMintClose` (curve exact, yield live) |

Plus `constants()` — the UI reads bounds from the engine and never hardcodes a
limit the chain enforces.

**The test that justifies the approach:** `browser engine agrees with the chain
EXACTLY` runs the same inputs through both the browser WASM and the dev chain
and asserts byte-identical outputs for shares, both multipliers, swap output
and price impact. If those ever diverge, the frontend is showing a number the
chain will not honour — and the suite fails.

## Indexer (`api/`) — BUILT 2026-08-20

TypeScript. **Aggregates chain state and computes nothing.** It is the
abstraction boundary: one `LasseCashClient` for the frontend, with either the
dev chain or a real MAGI node behind it.

```
api/src/
  amount.ts       Amount = decimal STRING. BigInt compare/format. No floats.
  types.ts        The view shapes; every field was computed on-chain.
  backend.ts      Backend + Signer interfaces — the boundary itself.
  dev-backend.ts  Talks to the dev chain (also drives its clock).
  magi-backend.ts Talks to a real node. Reads wired; writes await a contract id.
  client.ts       LasseCashClient — what the frontend imports.
```

### Amounts are decimal strings, never numbers

Balances DO fit in a JS number today (`MAX_SAFE_INTEGER` ≈ 90,071,992 LC against
a 51M cap, ~1.77x headroom). That is not a reason to use floats:

1. **Products leave the safe range immediately.** Every rate, bonus and share is
   a 1e8-scaled multiplier, so `amount × multiplier` is ~1e23.
2. **Decimal fractions are not exactly representable in binary at all** —
   `0.1 + 0.2 !== 0.3` regardless of magnitude.

So: strings on the wire, BigInt for comparison, strings out. `format()`
**truncates and never rounds up** — showing 1,234,568 when the account holds
1,234,567.89 would display money that is not there.

### Quotes: the golden rule's loophole, closed

A frontend showing "you will receive X" *before* submitting is performing a
calculation. That cannot live in TypeScript. So the backend gained three
engine-computed quote endpoints, and the client just forwards to them:

```
GET /quote/swap?direction=lc_hbd|hbd_lc&amount=   -> out, rate, price impact
GET /quote/mint?amount=&days=                     -> shares, both multipliers
GET /quote/liquidity?amount=                      -> HBD needed, shares, pool %
```

On a real node these map onto **`simulateContractCalls`**, which returns
`ret` / `rc_used` / `gas_used` without broadcasting. Same discipline, same
engine, no second implementation.

### API rule learned here

Every write method is `async` so a missing signer or a malformed amount
surfaces as a **rejected promise**, never a synchronous throw. A method typed
`Promise<T>` that sometimes throws before returning cannot be handled with
`.catch()` — which is exactly how a UI ends up swallowing errors silently.

## Dev chain (simulator) — BUILT 2026-08-20

`node/` runs the SAME code the contract runs: `contract-template/state` over an
in-memory store. It adds only what a chain provides — a clock, a calendar, and
a transaction dispatcher. **No economics live in the simulator.**

**It speaks plain JSON, NOT a hand-rolled GraphQL.** The abstraction boundary
belongs in the TypeScript indexer, which presents one interface to the frontend
and adapts either the simulator or a real MAGI node behind it. A partial
GraphQL server here would be a second, subtly-wrong API to keep in sync, and
the day it drifted the frontend would break on deploy.

Entrypoint names and pipe-delimited args are **identical to `app/main.go`**, so
frontend code written against the simulator works unchanged after deployment.
Keep them in step.

```
./build.sh node          # http://localhost:8080, seeded with a demo economy

GET  /chain              height, supply, all four pools, AMM reserves, consensus
GET  /account/{name}     balances, mints, tranches, vote power — ALL precomputed
POST /tx                 {"sender","entrypoint","args"}
GET  /state?keys=a,b     raw contract state (mirrors MAGI getStateByKeys)
POST /dev/advance        {"days"} or {"heights"} — move the clock
GET  /dev/dump           every state key (debug only)
```

### ⚠️ TWO SEEDS, AND THE TEST SUITE ONLY WORKS WITH ONE — 2026-08-22

```
./build.sh node                              demo economy (hive:demo, hive:tibfox, …)
go run . -snapshot=…/migration_set.json      claim model — NOBODY holds anything
```

The `-snapshot` seed credits no account: that is the whole point of
claim-based migration, nobody is credited until they claim. The `api` suite is
written against the DEMO economy, so run against a snapshot-seeded chain it
fails **7 tests with "insufficient balance"** — including `browser engine
agrees with the chain EXACTLY`, the test that guards the golden rule. It reads
exactly like a real regression and is not one.

**The tell:** on a freshly snapshot-seeded chain `/chain` reports
`migrated_supply` equal to the burn total alone (nothing claimed yet). Check
that before believing a red suite. Run tests on the demo seed; use `-snapshot`
for the claim page and the migration flows, and put the seed back when done.

**Amounts cross the wire as decimal STRINGS, never JSON numbers.** 51M LASSECASH
is 5.1e15 base units and JavaScript's `Number` loses precision above 2^53 — a
frontend parsing these as floats would display balances that disagree with the
chain. Always 8 decimal places, never trimmed.

`/account/{name}` returns `if_claimed_now`, `pending_yield`, `slashed_if_claimed_now`,
`bleed_remaining_pct`, `loyalty_multiplier` and tranche values **already computed
by the engine**. The frontend renders these; it never derives them. That is the
golden rule made mechanical.

Note: `Result.Msg` from the contract contains RAW BASE UNITS (they are
diagnostic, and formatting them on-chain would cost binary size and gas). The
frontend must not display contract messages verbatim.

## Contract architecture — BUILT 2026-08-20

```
contract/
  app/main.go      //go:wasmexport entrypoints. THIN: parse args, call state,
                   abort on failure. No arithmetic, no policy, no state layout.
  state/           Pure Go. Storage schema + every operation. Unit-tested
                   natively with `go test` against a MemStore.
  sdk/, runtime/   Vendored from vsc-eco/go-contract-template. Do not edit.
```

**Why the split.** The MAGI SDK declares its host calls with `//go:wasmimport`
and NO build tags, so `sdk` compiles only for a wasm target. Anything importing
it is impossible to `go test`. So all logic lives in `state/` behind a `Store`
interface; `app/` is the only file that touches the SDK.

### Entrypoints (16)

`init` `migrate` — owner only, genesis phase.
`transfer` `burn` `settle` `mint` `claim_mint` `good_accounting` `set_duration`
`settle_pending` `promote` `set_param` `post` `vote` `payout` `claim_curation`
`add_liquidity` `remove_liquidity` `claim_pool` `swap_lc_hbd` `swap_hbd_lc`

Args are **pipe-delimited positional strings**, e.g. `mint` takes
`<amount>|<days>`. Not JSON: `encoding/json` needs reflect, which bloats the
binary and costs gas charged to the caller's RC.

State records use the same encoding. **Field order is frozen and append-only** —
reordering or removing a field makes already-written state unreadable.

### Two problems solved during the build

**1. The leaderboard.** `ConsensusGroup` needs the top-10 L-Share holders, but
the contract cannot enumerate accounts. Solved with an incrementally maintained
board (`gov/board`, 20 slots): every share change offers the account a seat,
O(20). `promote` is permissionless so anyone can correct a stale exclusion.
Shares are re-read live before use, so the board can only ever wrongly EXCLUDE,
never wrongly include.

**2. Curator payouts.** A real post had 201 votes. Paying every curator inside
the payout transaction would make a viral post cost its author more RC than an
ignored one. Split in two: `payout` pays the author and PARKS the curator pot on
the post record; each curator calls `claim_curation` for their own O(1) share.
The vote record is deleted on claim, which is what prevents double collection.

### Verified

- `contract/artifacts/main.wasm` — **72,395 bytes**, all 21 entrypoints exported.
- 40 contract tests + 73 engine tests, all green via `./build.sh`.
- A global `auditSupply` invariant runs in every contract test: the sum of all
  balances, pools, pending accruals, live mint principals and parked curator
  pots must EXACTLY equal `migrated + emitted - burned`. Any leak fails the test.

## TinyGo / WASM compatibility — VERIFIED 2026-08-20

The whole engine compiles to `wasm-unknown` under the MAGI build flags.
**7,882 bytes.** No incompatibility found.

```bash
tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
  -target=wasm-unknown -o app.wasm ./app
```

Two build requirements that are easy to miss:
- `-gc=custom` requires the template's `runtime/gc_leaking_exported.go` to be
  imported (`_ "<module>/runtime"`), or the build dies with
  `panic: missing core function "runtime.free"`.
- The SDK imports `contract-template/runtime`, so the contract module must
  either be named `contract-template` or the import rewritten.

### Fees: there are NONE. Only RC.

Verified from `SimulateContractCallResult`: `rc_used` (resource credits) and
`gas_used` (WASM cycles). Gas is *metering charged against RC*, not a currency.
RC regenerates from staked balance. LasseCash's zero-fee claim holds.

**Consequence: WASM gas is charged to the caller's RC, so algorithmic cost is a
user-facing cost.** Three fixes came out of this:

1. `ConsensusGroup` was sorting **every holder** (11,236 accounts) to find the
   top 10. Now a fixed 10-slot partial selection: O(n·10), no allocation, no
   reflect.
2. `CollectMonthly` swept **every account with a pending balance** in one call.
   That cannot fit in gas at scale and there is no cron on MAGI. Replaced with
   `SettleAccount` — lazy, O(1), runs when an account is next touched. Same
   "compute on touch" discipline as emission. `CollectMonthly` survives for the
   simulator and tests ONLY; never call it from the contract.
3. `sort.Slice` pulled `reflect` into the binary. Removed entirely — the engine
   now imports only `math/bits` in production code. Binary went 11,872 → 7,882
   bytes (−33%).

**Rule going forward: no unbounded iteration in contract code.** Anything that
loops over "all accounts" or "all mints" belongs off-chain or must be lazy.

## Proof-of-Brain payout routing — DECIDED 2026-08-20

```
block reward
  └─ 50% Proof-of-Brain
       ├─ 25% VIRAL  (7-day payout,  7-day vote regen)
       └─ 75% DEEP  (30-day payout, 30-day vote regen)
            each: 75% author / 25% curators
                 └─ 20% liquid immediately
                    80% -> pending balance -> ONE mint on the 1st
```

**Why PoB payouts do NOT create mints directly.** Protocol-generated payouts
need no user transaction, so they have no rate limit. One real lassecash.com
post carried **201 votes** = 201 curation payouts. At ~20 posts/day that is
~1.5M mints/year in contract state — chain death.

**Manual capital minting has no such problem** and stays immediate and direct:
every mint costs a signed transaction plus Magi + Hive RC, which is a natural
brake. Steady state ~11,000 mints/year, ~33,000 open. Fine.

Rules:
- Pending is **one integer per account**, not a row per payout.
- On the 1st of each month the whole balance becomes ONE mint at the duration
  from the user's settings page (sliding scale 1–1095 days, default 3 years).
- Balances under **1 LASSECASH roll over** rather than minting dust.
- **Pending carries NO voting power.** KISS. L-Shares are voting power; pending
  is not yet L-Shares.
- **Curation is treated identically to author rewards** — same pending balance,
  same monthly mint.
- Claim Mint stays manual. The bleed is the teacher.
- "The 1st" is a real calendar month: the contract parses `block.timestamp` and
  hands the engine an epoch number, so the engine stays pure and clock-free.

Known and accepted: Bigger Pays Better gives post rewards a 1.0x volume
multiplier unless a month's earnings are large. Capital commitment should pay
better, and the bonus range (1.5x–2.25x) is small enough not to matter.

## Governance — parameter registry (DECIDED 2026-08-20)

**A parameter registry in contract state** — parameters are `key -> value`
rows, not hardcoded struct fields, so the top-10 median can move a value
without a code change.

⚠️ **CORRECTED 2026-08-21 — the registry is NOT a general extension point.**

This section used to claim two mechanisms. The second one does not survive the
key burn (see "Immutability" below), and the first was overstated:

- ~~"MAGI supports timelocked contract updates, so new *logic* can ship
  later"~~ — true of MAGI, **false of the core contract once the owner key is
  burned.** `findPendingContractUpdates` is real, but with no owner key there
  is nobody who can queue one. Timelocked updates apply to *dApp* contracts,
  which keep their owners. The core gets no new logic, ever.
- ~~"this is what makes future dApp fees injectable"~~ — **it does not.** A
  registry row is only meaningful if deployed code reads that key. The core
  contract cannot read a key it was never written to read, and after the burn
  its code is frozen. Writing `fee/rideshare = 0.4` into core state would
  change nothing anywhere.

The rows the registry *can* govern are exactly the ones in the GOVERNABLE
column below and no others, because those are the only keys the frozen code
reads. Treat that column as closed.

**The immutability split — this is the load-bearing design decision:**

| IMMUTABLE (hardcoded, no governance path) | GOVERNABLE (registry, bounded) |
|---|---|
| 51M hardcap | Bigger-Pays-Better start/end amounts |
| 20M emission cap + halving curve | Posting thresholds (viral / deep) |

**Posting thresholds — BOUNDS DECIDED 2026-08-21 (frozen forever).**
Denominated in L-SHARES (the unit of commitment; the ratchet makes a share
slowly cost more LASSECASH, the right direction against inflation), NOT in
dollars via the pool — that would be an on-chain oracle on a thin,
manipulable pool. The top-10 IS the oracle. Lasse's ranges ($0.01–$10 viral,
$0.10–$100 deep at the 0.001 opening price) with a one-share floor:

| | Floor | Default | Ceiling |
|---|---|---|---|
| Viral | 1 L-Share | 1,000 | 10,000 |
| Deep | 1 L-Share | 10,000 | 100,000 |

**The ceiling is the anti-capture rule**: the top-10 hold the most shares by
definition; with no ceiling six colluding seats could set deep above
everyone's holdings but their own and farm 37.5% of emission — capture pays
a cartel more than the price damage costs it, so "they want the price up"
does NOT protect against it (Lasse's "no limits, perfect AnCap" idea,
rejected for this reason). At the ceiling a captured committee can squeeze
deep posting to ~20 accounts — painful, visible, reversible, never
exclusive. **The floor is one share** so protection can't be switched off
but nobody is ever locked out; newcomers earn shares by posting viral and
grow into deep. Robust to a 100x price move either way. Pinned by
`TestPostingThresholdBoundsArePinned`. (The earlier "dynamic vs HBD price"
idea is closed.)
| 1.5x LPB ceiling, 1.5x BPB ceiling | *(closed — see correction above)* |
| **0% swap fee on LASSECASH:HBD** | |
| +1%/day LP loyalty bonus, 90-day cap | |
| 3-year maximum mint duration | |
| 7%/yr share-rate ratchet | |
| 50/25/25 pool split | |
| 75/25 author/curator split | |
| Early-end curve, grace, bleed periods | |

**Every governable parameter carries hardcoded min/max bounds.** The top-10 can
move a value inside its bounds and can never leave them. A posting threshold
bounded to its range can never leave it, no matter who controls consensus.

The bounds are hardcoded *because* they must be un-negotiable. A bounds table
that was itself governable would be no bounds at all — the top-10 would simply
widen the bound first, then move the value.

**Parameter changes affect FUTURE mints only.** Shares are computed once, at
mint creation, and frozen. Governance can never retroactively dilute an
existing minter — otherwise the top-10 could vote themselves everyone else's
share weight.

### Median governance — NO PROPOSALS (decided 2026-08-20)

**There are no proposals.** Lasse designed them early and discarded them: you
cannot verify on-chain that a funded proposal was ever delivered, and an
immutable protocol should not pretend otherwise. There is also no inflation
slice for proposals or onboarding, for the same reason. KISS.

**How it works instead:** each of the top 10 keeps a *standing preferred value*
for each parameter, changeable at any time. The **median** of those preferences
is the value in force, continuously. No quorum, no voting round, no tallying
job, nothing to time or snipe.

Worked example (ridesharing fee): members prefer 0.1, 0.2, 0.4, 0.5, 0.2, 0.3,
0.8, 0.9, 0.6, 0.7 → sorted 0.1 0.2 0.2 0.3 0.4 | 0.5 ... → **0.4% in force**.

**Why median, not mean or majority:** extreme votes are self-neutralising. A
member voting 10,000% moves the outcome no further than one voting a notch
above the median. An average would let a single absurd vote drag the result.

**Even parity uses the LOWER median** — exact integer arithmetic, no rounding,
so every node computes the same value.

**The 20% weight cap was REMOVED — it no longer applies.** Under median
governance each seat contributes exactly one number; L-Shares buy you a seat,
not extra influence within it. There is no weight to cap.

**What the median does NOT defend against** is one entity holding several of
the ten seats. Accepted deliberately: the hardcoded Min/Max bounds are what
limit the damage. A test asserts that even 6-of-10 seats captured cannot push a
value outside its bounds. The About page should describe the top 10 as a
*tweaking committee*, not a check on the founder.

Standard dApp fee band: **0.1%–1%** (versus Uber's 20–30%). This is a *norm for
dApp authors to follow*, not something the core contract enforces — see the
immutability section below for why the core cannot enforce it.

## Immutability — DECIDED 2026-08-21: THE KEYS ARE BURNED AT LAUNCH

This is Lasse's decision and it is the most consequential one in the project.

> *"No, it's necessary to claim it's real blockchain immutable, no admin keys.
> If I want to change anything in the future it's a real hardfork. I think I
> will burn the keys at launch and say it's 100% immutable — that's more
> earnest than having 100% admin keys for 12 months. That's disingenuous."*

**What "burn" means concretely:** after the core contract is deployed and the
migration is executed, the owner account's keys are destroyed. MAGI resolves a
contract update against the owner's active authority; with no key in existence,
`findPendingContractUpdates` can never receive an entry for this contract. Not
"we promise not to"; *nobody can*.

### What this forecloses — accept it before deploying, not after

| Wish | After the burn |
|---|---|
| Fix a bug in the core contract | **Impossible.** Only a chain-level hardfork. |
| Add a parameter the code doesn't already read | **Impossible.** |
| Add an entrypoint | **Impossible.** |
| Change a bound | **Impossible.** |
| Move a governable value inside its bounds | Fine — median governance still runs. |

There is no staged rollout and no "12 months of admin keys just in case".
That was explicitly rejected as dishonest. **REFINED 2026-08-21: the burn
happens at an ANNOUNCED height ≈ day 40 after genesis** — once the first
claims, the first accruals, the first monthly PoB mint and the day-30
migration-mint maturity have all passed on the real chain. The key cannot
touch anyone's tokens; its only power is a public, timelocked code update,
which is the recovery path if the live chain surprises us in those first
weeks. Announced in the genesis post with the block height and the reason;
the burn tx is published. See docs/LAUNCH-RUNBOOK.md §7. **Therefore the pre-launch test
deploys are the entire safety margin.** Iterate as many times as needed on a
throwaway contract before the real one; each deploy is 10 HBD and that is
cheap next to shipping a frozen bug.

### How dApps still get governance — Lasse's solution, 2026-08-21

The problem: if the core is frozen and its registry is closed, how does a
future ridesharing dApp get a governable fee?

**Each dApp is its own contract with its own owner and its own registry.** It
does not extend the core, it *reads* it:

```
   dApp contract  ──sdk.ContractStateGet──►  core contract state
   (own owner,                                (frozen, read-only
    own fee row,                               to everyone)
    own bounds)          reads: L-Share balances → derives the top 10
```

The top-10 consensus group is *derived from core state*, so every dApp inherits
the same legitimate governing set without the core needing to know dApps exist.
The dApp keeps its owner key, so it can iterate forever behind timelocks and
announcements. The core never moves.

⚠️ **One refinement to how Lasse phrased it.** He said *"we build the top 10
consensus into the new dApp frontends"*. It must be in the dApp's **contract**,
not its frontend — a frontend enforces nothing, and anyone can call a contract
directly with their own client. The frontend may *display* the top 10; only the
contract may *obey* it.

Consequence for the core: it must expose L-Share balances in a state layout
that a foreign contract can read and that we are willing to freeze forever,
because after the burn the layout is permanent public API. Verify this before
the real deploy — a dApp-unreadable layout is unfixable afterwards.

## Time-travel testing — BUILT 2026-08-21 (`contract/state/timeline_test.go`)

A mint lives up to 1,215 days, or 2,280 with Good Accounting. Nobody can watch
that, so the long tail is tested by jumping the clock.

**What licenses jumping** is that emission and yield are closed-form functions
of height, settled as a difference. `TestTimeTravelIsPathIndependent` verifies
that rather than trusting it: the same three years are lived by three chains —
settled daily, monthly, and in one single leap — and all three must end
byte-identical. It doubles as a real guarantee: an account nobody touches for
years is not cheated, and a busy account is not paid extra for being busy.
**If that test fails, every other long-horizon result is fiction.**

`TestMintLifeAtEveryBoundary` names the days where an off-by-one costs someone
money — creation, day 1, halfway, 1094, maturity, grace start/end, mid-bleed,
one day from zero, liquidation, long past it — rather than sampling. A test
that checked day 500 and day 700 would pass while maturity was broken.

It found the matured-mint yield question on its first run (open question 6).

## ⚠️ THE EMPTY-VS-NIL BUG — FOUND 2026-08-20, THE REASON TEST DEPLOYS EXIST

**A missing key on MAGI reads as a NON-NIL POINTER TO AN EMPTY STRING.**
It does not read as nil. `MemStore` used to return nil, and that one difference
bricked the first live deploy.

```go
func IsInit(s Store) bool { return s.Get(keyInit) != nil }   // WRONG on-chain
```

On MemStore a virgin contract looked uninitialised → 40 tests green.
On MAGI the same contract reported **"already initialised"** → `init` could
never be called → the deployment was **permanently unusable from birth**.

The tell was in the SDK all along: its own `StateGetU64` reads
`if val == nil || *val == ""`. The vendored code knew; our code did not.

**Had the owner keys already been burned, LasseCash would have been
unrecoverable** — no update path, no admin key, 10 HBD spent on a dead
contract. This single find justifies every test deploy that will ever be made.

### The fix — three parts, all of them load-bearing

1. **`state/codec.go` `get(s, key)`** — the ONLY sanctioned way to read state.
   Collapses empty to absent. Exact, not a heuristic: nothing in this contract
   ever deliberately stores an empty value. All 16 read sites go through it.
2. **`MemStore.Get` now returns `&""` for a missing key** — the fake is
   deliberately as awkward as the chain. A test double kinder than production
   is not a test double, it is a way of not finding out.
3. **`TestMissingKeysBehaveTheWayMagiReportsThem`** pins both. If it ever
   fails, do not soften `MemStore` — fix the caller.

**Rule going forward: never test a state key with `!= nil`.** Use `get()`.
The same trap applies to any future contract built on this SDK.

WASM after the fix: 74,484 bytes (was 72,351).

### How it was found — repeat this before the real deploy

`simulateContractCalls` is a **read-only GraphQL query: no HBD, no RC, no
broadcast, no wallet.** It executes the deployed WASM and returns
`success` / `err_msg` / `gas_used` / `state_diff`. Every entrypoint should be
exercised through it against a test deployment before anything is frozen.

Verified call shape (the schema is fussy and the errors are unhelpful):

| Field | Value |
|---|---|
| `required_auths` | a BARE string, `hive:account` — not a JSON array |
| `required_posting_auths` | **omit entirely**; `""` is rejected |
| `payload` | a plain `String` — our pipe-delimited args go straight in |
| `rc_limit` | **1 … 100,000**, hard limit |

**This also settles the open question about `vscCallContract` payload
encoding**: the wire format is a plain string, so pipe-delimited positional
args work unchanged. Confirmed by the contract's own parser rejecting `init`
with `usage: <genesisHeight>` and accepting `transfer` as `alice|100000000`.

Measured gas (uninitialised contract, so these are floors):

| Call | gas_used |
|---|---|
| `nonexistent_entry` | 302 (function-not-found, never entered) |
| `init` | 155,389 |
| `transfer` | 2,357,786 |
| `mint` | 3,158,401 |

## MAGI devnet — the free testing environment (TibFox, Discord 2026-08-21)

TibFox: *"you don't need to deploy a contract in order to test it"* — and
confirmed **deploy fees are paid from the L1 balance** (matches our preflight).
docs.magi.eco → "Setup a development testnet": a fully LOCAL VSC — HAF Hive
testnet (docker) + `go-vsc-node` built with `make` (`devnet-setup`, `magid`
×5, `genesis-elector`). We already have go-vsc-node cloned/buildable in
`~/.lassecash-deployer/src`, and the `tests/devnet/` harness we have been
reading all week is the client for exactly this environment.

**What it buys:** free deploys (testnet HBD), no RC scarcity, resettable —
the right place to measure `migrate_batch` gas at 50 accounts, full curation
drains at `MaxCurationDrain`, and to rehearse the full 6,039-broadcast
migration without parking real RC. Set it up BEFORE the production-rehearsal
deploy; keep throwaway #3 for anything needing real mainnet behaviour.
Caveat: infrastructure is heavy (HAF node + Mongo + 5 nodes) — an evening of
downloads; treat "devnet says X" as strong evidence but confirm consensus-
critical behaviour (like the slash-key bug) against mainnet, since witnesses
there may run different versions.

## SESSION 2026-08-22 (afternoon/evening) — decisions and new mechanics

### ✅ SNAPSHOT CRITERIA: "C6" — DECIDED (supersedes the Hive-OR-LasseCash rule)

**An account migrates if and only if it SIGNED a LASSECASH operation on
Hive-Engine within 6 months of the snapshot block.** The Hive L1 limb is gone
from the decision — it is still read and recorded for the audit trail, but
being alive somewhere on Hive no longer qualifies anyone.

Lasse: *"its better to have real users that are a small group than to have
fake users that are a huge group, which is the opposite of what 99% of crypto
does."* Thousands hold LASSECASH only because he gave it away for seven years
— at HiveFest, in comment threads. Doing nothing with it for six months is an
answer.

**Result: 262 accounts, 10,557,431.61534174 LC migrating, 20,436,766.06 to
hive:null, founder 68.85%.** Accepted knowingly: *"I dont mind that, thats a
consequence of stupid people not holding and supporting, not my greed."*

**Fail OPEN on unresolved data.** `apply_criteria.py` ignored
`search_truncated` and burned accounts whose history walk hit
MAX_HISTORY_PAGES — 198 accounts, 669k LC, including deep-history *posters*
(@master-lamps: 6,000+ payout entries burying any signed op). Now an
unresolved search counts as ALIVE, reason `truncated_unresolved`. Never burn
on missing data; the claim deadline removes the genuinely gone anyway.

### 🐛 TWO SCANNER BUGS — seven years of activity was invisible

1. **Wrong operation names.** `HE_USER_OPS` asked for `tokens_unstake` and
   `tokens_undelegate`. Those do not exist — the real names are
   `tokens_unstakeStart`, `tokens_unstakeDone`, `tokens_undelegateStart`. The
   server-side filter silently matched nothing, so **every powerdown and
   undelegation since 2019 was invisible to the scan.** @cedricguillas signed a
   100,000 LC powerdown on 2026-08-05 and read as "never touched it".
2. **The authorship fallback was always true.** `he_authorized_by` fell back to
   `entry.account == account`, but `account` is simply WHOSE HISTORY YOU
   QUERIED — it matches on every row regardless of who acted. Now authorship is
   read per operation; `tokens_unstakeDone` (the automatic weekly instalment)
   never counts.

Rescan: **1,859 records changed**, accounts with LASSECASH activity 2,635 →
2,911. Old data in `activity.pre-heops-fix.json`.

**Also verified, do not re-litigate:** `stake` and `pendingUnstake` are
DISJOINT on Hive-Engine (the whole unstake quantity leaves `stake` at
initiation), so summing them is correct — proven against @cedricguillas to the
base unit. And `pendingUndelegations` is NEVER read: 3 accounts carry a
NEGATIVE ghost there (@lasseehlers −1.4M, @bait200 −270k, @pjansen.ctp −98.96)
from an old Hive-Engine bug; zero accounts carry a positive value, so ignoring
the field loses nothing.

**⚠️ hive.blog's "Active X ago" measures POSTING ONLY.** @lovejuice reads
"Active 7 years ago" while moving tens of thousands of HIVE monthly. The
announcement must say so — people will check it and get the wrong answer.

### ✅ ANTI-ZOMBIE CHECK on liquidity — BUILT (eviction, NOT a bleed)

Dormant liquidity draws its slice of the 25% emission forever. On Hive-Engine
52 of 125 LASSECASH LPs had not touched either chain in over a year.

**180 days without a claim → anyone may EVICT the position, and the owner gets
their LASSECASH and HBD back WHOLE.** Claiming is the proof of life and resets
the clock. `TrancheDormantDays=180`, `TrancheWarningDays=90`, `Tranche.LastTouch`
(codec field 6, append-only), `SweepTranche` permissionless and paying the
caller nothing, `sweep_tranche` entrypoint.

**The first design BLED the shares away to the remaining LPs. Lasse killed it
and he was right:** an LP is never PAID for a term the way a minter is paid up
to 1.5x for pledging one, so taking their capital is the one thing a critic
could accurately call theft. Eviction achieves the same goal — dead capital
stops drawing rewards — and confiscates nothing. It also reuses the audited
`RemoveLiquidity` path and introduces no new rounding surface.

**The single most dangerous line:** `closeTranche` pays the OWNER, never
`ctx.Sender`. Get it wrong and a permissionless sweep becomes permissionless
robbery. Pinned by `TestDormantLiquidityIsEvictedNotConfiscated`.

UI is GOLD, not red: CLAUDE.md reserves red for value actively being lost, and
nothing is lost here. Using alarm colours for a non-loss trains people to
ignore red where it IS real.

### ✅ PROVABLY-ALIVE SUPPLY — engine primitives built

`engine.IsAlive` / `AlivePct`, reported over **three windows (90d / 1y / 2y)**
because "alive" is a judgement and showing how the answer moves with the
threshold is more honest than picking the flattering number.

**No chain can say how much of its supply is lost.** Bitcoin cannot — a coin
unmoved for fifteen years is indistinguishable from one held patiently. Every
"circulating supply" figure in crypto is a guess. LasseCash can answer it,
because every action is a signed transaction with a known sender and height,
and `required_auths` is exposed on `TransactionRecord`. **Computed entirely
off-chain from public history: zero gas, no contract change, verifiable by
anyone.** Remaining work is the indexer walk + a `/chain` panel.

### ❌ BALANCE DEMURRAGE — PROPOSED AND REJECTED, do not re-propose blind

Bleeding dormant *wallet balances* into the reward pools. Lasse's reframe was
fair — it is escheat, not Gesell demurrage, and the vault analogy holds. It was
still dropped:

- **Escheat is reclaimable; this would not be.** Value distributed to others
  has no one to claim it back from.
- **It removes human tokens, not bot tokens.** A script sending 1 LC to itself
  yearly is immortal; the people who bleed are ordinary holders who do not
  automate. Inverse of the intent.
- **A hard-money asset you must touch twice a year cannot be inherited or
  cold-stored.** @angeloextreme and @daneamanda are Lasse's children's
  accounts, held for a future where LasseCash is big. This mechanism would
  destroy exactly what he built them for.
- **Exchanges and custodians break**, killing CMC/CoinGecko readiness.
- **Mints and LP tranches are contracts; a balance is property.** Both of the
  former were opted into and PAID for the commitment. A holder was promised
  nothing.
- The problem it aimed at is already solved: unclaimed migration positions
  sweep at day 150, and C6 burns the dead before they arrive.

The good idea that came out of it is the alive-supply metric above — the
transparency without the confiscation.

### ✅ BIGGER-PAYS-BETTER defaults 10,000/100,000 → 1,000/50,000

Measured on the real C6 set: at the old defaults only **40 of 241 accounts**
would ever see any volume bonus and only **13** could reach the 1.50x ceiling.
**201 accounts — 83% — could never touch the mechanic**, and 164 hold under
1,000 LC. A bonus most of the community can never reach is not an incentive,
it is concentration with extra steps. **Defaults only — the bounds are frozen
and unchanged**, so the top-10 median can still tune inside them.

### ✅ ACTIVE_OPS: all four permissionless sweeps are POSTING-key

`sweep_mint`, `sweep_curation`, `claim_curation` and `sweep_tranche`. None can
move the CALLER's money — each pays its subject, never the trigger, and each
refuses unless the position is already dead. Demanding an active key would add
friction to exactly the altruistic action the protocol wants. `sweep_tranche`
was briefly added to `ACTIVE_OPS`, which left the four inconsistent; removed.
**This list is frozen at the key burn — the four must stay consistent.**

### 📊 ECONOMIC ANALYSIS — the shape of the launch

- **92.3% of migrating supply arrives STAKED** (9,739,588 LC as 30-day
  migration mints); only 7.7% liquid, and non-founder liquid is **541,683 LC
  across 240 accounts** — average 2,257 each. There is almost no free-floating
  LASSECASH at launch, and that constrains every game.
- Era-1 yields: **L-Share 8.6% APY** (833,333 / 9.74M shares); **Pool ~1,225%**
  (833,333 / ~68k seeded LC). The pool number is the bootstrap magnet working —
  a quarter of emission subsidising a pool worth ~$140 is what pulls outside
  HBD in. **The bottleneck is HBD, not LASSECASH**: his users hold the token,
  not the pair.
- **⚠️ If Lasse is the sole LP at launch he captures the entire 25% pool
  slice** — with 68.85% of L-Shares that is roughly **42% of all emission**
  before any PoB. Self-corrects as others join, but it is the first thing a
  critic computes. He plans to address it in a post/video pre-emptively.
- **The day-30 cliff is the real launch.** Every migration mint matures the
  same day; active shares fall to ~zero and whoever re-mints first divides
  833,333 LC/yr among almost nobody. All voting power expires simultaneously,
  so the top-10 is briefly whoever signs first.
- Scale check: era-1 emission is 3,333,333 LC ≈ **$3,433/year** at the opening
  price. Every percentage is real; every dollar figure is small.

### Launch plan (Lasse's call)

**Announce AFTER Sept 1**, so the monthly PoB mint — the one behaviour that
cannot be compressed, because TESTWINDOWS shrinks days but not calendars — is
observed on a THROWAWAY before the production contract is frozen. Roll call one
week; snapshot Sat 29 Aug 12:00 UTC (block 109,447,319), genesis 18:00 UTC (block 109,454,519), key burn day 40 = Thu 8 Oct (block 110,606,519).
Draft: `docs/ANNOUNCEMENT-DRAFT.md` (technical parts written; Lasse's voice and
closing line to add; criteria section still says 12 months and five months —
update to 6 and seven).

## STATE OF PLAY — end of 2026-08-22 session (read this first)

- **Site is LIVE: https://lassecash.pages.dev** (Cloudflare Pages, project
  `lassecash`, root `web`, build `npm --prefix ../api ci && npm run build`,
  auto-deploys on push to `main`). Env points at throwaway #5 with
  `VITE_TESTWINDOWS=1`. Custom domain lassecash.com: Lasse adds it in the
  dashboard. **Launch switch = change `VITE_CONTRACT_ID`, delete
  `VITE_TESTWINDOWS`.** Verified by curl: SSR feed/post pages with canonical,
  about, robots, sitemap, llms.txt, `.md` endpoints, engine WASM.
- **Contract is a production candidate**, but three changes landed AFTER
  throwaway #5 and are unproven on mainnet: weight-0 unvote; ordinary calls
  retire at most `UserRetireBudget=50` (advance carries the rest);
  `MaxRetirePerWalk=50` (DECIDED: a day-30 slice ≈ 6,500 RC fits any fresh
  account — the crowd crosses the migration day, ~32 calls). → **throwaway
  #6** (10 HBD) for a last soak, a fresh 500k fuzz on that exact build, then
  the production deploy.
- **Day-30 mechanics**: the site plans `advance` slices from `acc_day` and
  `explc_<day>` counts (`LasseCashClient.catchUp`) and bundles them ahead of
  mint/claim/settle in the same confirm (`SubmitOptions.preCalls`); if the
  user's own call would still be refused for lag, only the slices are sent
  and the user is told to press again. Devnet measurement in
  docs/DEVNET-MATURITY-DAY.md.
- **Open**: curation `settleOwed` as side calls (it would prompt Keychain
  today); announcement + Hive-Engine token-info texts (Lasse's voice);
  snapshot pipeline rehearsal; Sept 1 monthly PoB mint on #5 (57 LC pending
  for @lasseehlers); Good Accounting arm / bleed / sweep_mint on the clock.
- **Lasse's standing notes**: keep HBD on MAGI on @lasseehlers — it IS the RC
  meter (never spent); ~200 HBD that week lets him clear day 30 alone.
  Screenshots only when something looks wrong; text otherwise.
- Background: a 500k fuzz started 08:20 on pre-change code
  (scratchpad/fuzz500k.log) — a regression run, not the final one.

## THROWAWAY #5 — 2026-08-22 morning: the pool and first-vote registration on mainnet

`vsc1BjLaDa5zFWPC8g61uL6mN84m2FSeeLKBpY`, genesis 109,238,176, TESTWINDOWS,
real snapshot root committed. **Every user-reachable entrypoint has now run
on mainnet with a real wallet.** The contract is a production candidate; what
remains is observation on the clock (monthly mint Sept 1, bleed, Good
Accounting in grace, sweep_mint), then the final fuzz and the real deploy.

**Custody round trip, exact to the milli:** add 2,000 LC + 2 HBD (ledger
−2000 milli, `transfer.allow` 2.000) → sell 100 LC (+95; engine owed 0.095238,
paid 0.095, dust stays in custody) → buy 0.05 HBD (−50) → withdraw (+1954,
plus 28.5 LC of LP rewards — the first LP payout ever). Custody ≥ ledger held
throughout.

**A FRESH account can claim.** @daneamanda (untouched meter: 10,000/10,000
free RC, 250k staked, took a board seat) claimed at rc_limit 9,500 —
CONFIRMED. This is the launch-day case for nearly every holder. @angeloextreme
failed the same claim earlier only because his meter was still frozen from
seven calls on #4 (thaw = 5 days). **Runbook rule: claim FIRST; do nothing
else on MAGI before the claim.**

**First-vote registration, live:** a PeakD post tagged `lassecash` by
@lasseehlers (Hive reputation −12.6 → "grayed") was registered by a vote:
record created at the vote's height, viral, default split. Findings:
- **Hive's tag listings (`get_ranked_posts`, `get_discussions_by_created`)
  silently omit grayed authors.** `get_post`/`get_account_posts` include
  them. Discovery = tag listing ∪ per-author sweep of `gov_board` members;
  any other grayed author's post works by direct URL and joins the feed on
  its first vote. (LasseCash does not inherit Hive's downvote hiding.)
- Discovery must also read `vote` call targets — a vote-registered post has
  no `post` call.
- Tagged posts older than the viral window, or pre-genesis, are not offered
  (a first vote opens a FRESH window).
- **A LasseCash vote also casts the Hive vote at the same weight in the same
  transaction** (Lasse: tribe consistency). Hive refuses an identical re-vote,
  which then blocks the bundled contract call — reported as Hive's reason.
- The contract has no unvote (weights 1..100): a vote is REPLACED by
  re-voting, never removed. Slider remembers the last weight per browser.

## WALLET EVENING on mainnet — throwaway #4, 2026-08-22 (02:00–06:30)

| | |
|---|---|
| Contract id | `vsc1BoLgTEZhcQKSGi9vCZN12yVjmM4mnvWrLB` (TESTWINDOWS 240x, production code of 02:36) |
| Genesis | 109,233,230 · real snapshot root `f22793d7…e9af2` committed |
| Accounts | @lasseehlers (claimed 267,113 liquid + 7.0M mint), @angeloextreme (1,025 + 250k) |

**All three "unverified until a live wallet" items are CLOSED.** Keychain
passes our pipe-delimited payload untouched (a 940-byte proof included);
`transfer.allow` intents are accepted; image upload works once the challenge
is sent as hive.blog sends it — `{"type":"Buffer","data":[…]}` of
`"ImageSigningChallenge"+bytes` (Keychain hashes the bytes it is handed; a hex
digest made it sign the wrong thing).

**Verified exact on the real chain:** claim (both accounts, board seat
contention), mint (shares to the base unit of the preview), post, vote
(rshares = shares × power spent, meter 90% after), payout 75/25 and 20/80 to
the base unit, comment, promote (100 LC landed at `hive:null`), claim at
maturity = principal + accumulator yield **exactly as simulated**
(7,001,561.63340842), board re-ranking after the claim.

### Bugs the real chain found (simulator could not) — all fixed same night

1. **HBD custody unit — CONTRACT, would have been fatal after the burn.**
   The SDK moves HBD in MILLI-units; the adapter passed engine 1e8 units
   (2 HBD → 200,000,000 against an allowance of 2,000). `engine.HbdDrawMilli`
   (rounds UP: custody ≥ ledger) / `HbdPayMilli` (rounds DOWN) + pinned test.
   `MemAssets` speaks our unit, so no local test could see it. **Pool paths
   are untested on mainnet until throwaway #5.**
2. Keychain's "ok" only means Hive ACCEPTED the custom_json; the contract
   runs it 30–90 s later and may refuse. The page now follows every call to
   its verdict (`Backend.txStatus` — `findTransaction byId` + the output DAG's
   `errMsg`), shows refusals in red, and re-reads the account until it
   changes. Banner pinned to the viewport.
3. **Static RC limits fail on the real chain**: a mint hit `cost limit
   exceeded` at 4,000 when a day-step landed inside it (mainnet weighs writes
   19x; the simulator does not). Every wallet call now DRY-RUNS on the node
   first: limit = max(table, 3× simulated gas), capped at 30k and at the
   account's available RC; a call the chain would refuse never opens the
   wallet. A fresh account's free 10,000 RC carries one claim + a few actions
   per 5 days — @angeloextreme ran dry after claim + 4 mints.
4. Posting-key calls name their signer in `required_posting_auths`, not
   `required_auths` — discovery was blind to every real post and vote.
5. MAGI views never fetched content from Hive (bare permlinks), hardcoded
   vote power 0, tranches [], hbd 0 (then wrong unit: node = milli);
   `can_arm_good_accounting` still carried the superseded 7-days-before rule
   in TypeScript — now from the engine (`trancheView` bridge added;
   `engine.PoolRewardsOwed` is pure and shared).
6. Mint form let an over-balance amount reach the wallet; the "rate moved"
   check fired on every real call because the ratchet moves per height
   (tolerance 0.1% now).

### Decisions made during the evening (Lasse)

- **ONE wallet confirm to publish**: the Hive `comment` and the `vsc.call`
  registration travel in ONE Hive transaction (`signAndBroadcastTx`), atomic.
  Same for replies. `AiohaWallet.broadcastWithCall/broadcastCalls`.
- **Tagged posts from any Hive frontend count, like the old tribe, with the
  threshold caveat**: shown on LasseCash if the AUTHOR holds the viral
  threshold; **the first vote registers it** (`vote` on an unregistered
  `author|permlink` calls `registerForAuthor`: author's stake checked, ALWAYS
  viral, default split). **Tag = viral; deep only from our Write page** — no
  `lassecash-deep` tag (rejected: "if they want deep they come to our
  frontend"). No "register this post" button, ever.
  `TestFirstVoteRegistersAnOutsidePost`. Frontend half (reading Hive for
  tagged posts by eligible authors) — being built.
- **Payout settlement without a cron or a bot**: every signed action carries
  up to `MaxSideCalls = 2` pending `payout`s in the same transaction
  (`SubmitOptions.sideCalls`; the client keeps the payable list from the
  feed). "Settle payout" button remains as the manual path. Lasse: the
  immutable design must not depend on a job on his PC. NOTE: no signed call
  is ever silent on a real wallet — `settleOwed` will prompt too; the
  side-call pattern is the answer for curation as well (TODO).
- Write page: **Link field** (short address) separate from the headline; lands
  on the post after publishing; tags split on space/comma, **20 + lassecash
  first**, post page shows 10 with "+N more"; Ctrl+V / drop / button image
  upload on Write AND comments (comment images capped 320px).
- Tags decide NOTHING about visibility on LasseCash — registration does.

Pending on this deploy: Sept 1 monthly PoB mint (57.08 LC pending), mint #2
maturity, Good Accounting arm in grace, a bleed, `sweep_mint`. Needs #5: the
pool, first-vote registration live, a PeakD-tagged post earning.

## On-chain verification log — throwaway #3, 2026-08-21

Every row is a REAL broadcast whose state was READ BACK and checked to the
base unit. This is the evidence base for calling the economics production-true.

| Flow | Result |
|---|---|
| init | readable state; TESTWINDOWS stamp in ret |
| migrate 10,000 LC | `bal_` readable, `sup_migrated` exact |
| mint 5,000 LC / 30d | record readable: 5,066.26092409 shares; accrual walking (`acc_day` advancing) |
| transfer 1 LC | recipient balance readable |
| post + 100% vote | rshares = shares × weight, exact |
| payout (42 min later) | author 20/80 split EXACT (liquid×4 = pending); 75/25 author/curator EXACT |
| claim_curation | pot drained to 0; 20/80 on the curator side EXACT; pot fully conserved |
| claim_mint at maturity | **paid EXACTLY the simulated figure to the base unit** (5,304.41399353: principal + accumulator yield); shares left account and active total |
| (armed) bleed observation | mint #2, 1,000 LC × 1 day, deliberately abandoned: matures +6min, grace ends +3h, bleeds to zero over 9h — claim mid-bleed and verify the slash sweeps to the L-Share pool |

Pending are anchored to epoch 24320 — the monthly mint fires when the
calendar month turns. Mint #1 matures ~3h after creation (240x clock); claim,
grace and bleed observations follow the same day.

## Fuzzer verdict — 2026-08-21: 500,000 economies, ZERO failures

`TestFuzzEconomy` (contract/state/fuzz_economy_test.go) ran 500,000 randomized
economies over 2h09m — random mints/claims/transfers/burns/posts/votes/payouts/
early-ends/good-accounting across up to ~40 simulated years each, with
`auditEconomy` checked after EVERY operation. No supply leak, no invariant
break. This is the standing regression net: rerun after any change to money
paths (`FUZZ_ROUNDS=100000 go test -run TestFuzzEconomy -timeout 12h`,
`FUZZ_SEED` replays a failure).

## Third test deploy — THE ONE THAT WORKS — 2026-08-21

| | |
|---|---|
| Contract id | `vsc1BqLfLpKdMSfmHCe4o15ssWMiWJZw3yoZ8C` |
| Build | **TESTWINDOWS 240x + flat keys** (init ret is stamped) |
| Genesis | 109,204,939 |
| WASM | 76,619 bytes |

**FIRST READABLE STATE IN THE PROJECT'S HISTORY.** After the real `init`:
`cfg_init="1"`, `cfg_genesis`, `cfg_settled` all read back via `getStateByKeys`,
and the output's `state_merkle` is a real CID — not the empty root. The
flat-key fix is proven against mainnet consensus, end to end.

Pinned in `tools/chain-test/call.js`, `sequence.sh`, `web/.env.magi`. All
lifecycle testing happens HERE: a "day" is 6 minutes, so a 30-day mint matures
in 3 hours and the full mint→grace→bleed→liquidation arc fits in half a day.
Emission and the ratchet run on REAL time, so observed values are true.

### Gas→RC economics — MEASURED 2026-08-21 (constants from the node source)

**100,000 gas cycles = 1 RC**, and IO gas weights writes 19x reads
(`CYCLE_GAS_PER_RC`, `WRITE_IO_GAS_RC_COST`). With measured gas:

| call | gas | RC |
|---|---|---|
| transfer | 28M | ~280 |
| init | 40M | ~400 |
| migrate | 65M | ~650 |
| mint (small walk) | ~245M | ~2,500 — `gas_limit_hit` at rc_limit 1500 |
| full 1200-day accrual walk | 5.85B | **~58,500 (≈58 HBD) — unpayable in one call** |

Consequences, both implemented:
- `sequence.sh` sizes rc_limit per step (mint gets 6000).
- **`advance` now takes an optional `maxDays` argument** (`AccrueSteps`), so a
  long accrual gap is closed in affordable slices — 50 days ≈ 2,500 RC —
  instead of demanding one impossible 58k-RC call. Claim paths still require
  accrual current and tell the user to call advance.

### ✅ Staked-power migration mints — BUILT 2026-08-21 (Lasse caught the gap)

The spec's "Staked Power Conversion" was missing from the contract: everything
was credited as liquid balance. Lasse spotted it on the admin dashboard ("they
get 6 months mints for the lassecash power, so your numbers dont add up").
Now implemented and this would have been UNFIXABLE after the key burn:

- Each snapshot account migrates as TWO figures: liquid balance → balance,
  staked LASSECASH POWER → a **182-day migration mint** whose L-Shares equal
  the staked amount **1:1** (`engine.NewMigrationMint`). 182 days mirrors the
  Hive-Engine unstaking cooldown the stake was already under.
- **1:1 means no multipliers and no share rate** — legacy stake is not a new
  voluntary commitment, so it keeps the weight it had, nothing more. A
  voluntary 182-day mint of the same size would get Longer-Pays-Better and
  yield MORE than 1:1; the migration mint must not
  (`TestMigrationMintConvertsStakedPowerOneToOne`).
- Migration mints go through `registerMint` (the ONE way) with the **genesis
  height**, not the broadcast height — batches land over hours but every
  position matures on the same day.
- The "flush out legacy liquidity / purge dead weight" mechanic is just the
  ordinary lifecycle: dead accounts' migration mints mature, bleed, and
  recycle into the reward pool.
- Wire format changed: `migrate` takes `<account>|<liquid>|<staked>`;
  `migrate_batch` takes `<account>,<liquid>,<staked>|…` (split each triple at
  its last two commas). `tools/migrate.py` and the dev-node seeder send the
  split from `migration_set.json`'s per-account `liquid`/`staked` fields.
- Verified on the reseeded node: total unchanged (19,068,736.06104624), e.g.
  lasseehlers = 221,413.56699780 liquid + 7,001,274.99037966 as mint #1.
  Network total L-Shares at genesis: 13,880,507.75663314 (= total staked).
- WASM: 78,808 bytes mainnet / 78,840 TESTWINDOWS.

### ✅ migrate_batch — BUILT AND REHEARSED same day (was the 🔴 blocker below)

`migrate_batch` (entrypoint 23, owner-only, genesis-only): up to
`MaxMigrateBatch = 50` accounts per call, wire format
`hive:a,100|hive:b,200`. **Atomic** — everything validates before anything
writes, a failing batch applies nothing — and **idempotent** — already-
migrated accounts are skipped, so resending a crash-straddling batch is safe.
`tools/migrate.py` batches accordingly: full 6,039-account rehearsal runs in
121 batches, exact to the base unit, and survives a deleted progress file.
Real-chain RC: ~121 calls at measured cost instead of 6,039.
### ✅ Batch gas MEASURED on the local devnet 2026-08-21 (was unmeasured)

**A 50-account batch of STAKED accounts cannot execute — ever.** `rc_limit`
is capped at 100,000 and 100,000 gas = 1 RC, so 10B gas is the hard per-call
ceiling. First measurement was SUPERLINEAR (`6.1M·n² + 226M·n`): every mint
re-read and rewrote the 20-seat board even when unchanged, and appended to
the same expiry chunk one at a time. Fixed (bulk `registerMints`, board
writes only on change, one null credit per burn batch) — now LINEAR:
`gas ≈ 215M + 324M·n` for staked accounts (ceiling ~30 with realistic
stakes), `≈ 45M·n` for liquid-only migrations and burns. Everyday: `mint`
2,401 RC, `transfer` 285 RC (= mainnet), `advance` no-op 100 RC. Real
broadcasts agree with `simulateContractCalls` to ~1%.

`MaxMigrateBatch` stays 50 as the contract's iteration bound (an oversized
batch fails atomically); **`tools/migrate.py` sizes batches per kind: 20 for
staked, 50 for liquid-only and burns**, and sets rc_limit from the measured
cost +20%. Projected real migration at the 3-month set: ~248 calls, **~8.8M
RC** — which is the planning problem: RC capacity is MAGI HBD in milli-units
(+10k free) thawing over 5 days, so finishing in a day needs ~9,000 HBD
parked on MAGI temporarily, or the run spreads over weeks. Decide before
launch. ⚠️ The devnet charges ACTUAL RC used; mainnet freezes the full
rc_limit — validate budgets on mainnet, gas on the devnet.

Devnet facts: `tools/devnet/{up,down,reset,devnet,prove}.sh`, README there;
data in `~/.lassecash-devnet/`; GraphQL `localhost:18080–18083`. The two
"upstream bugs" first reported were NOT bugs (TibFox): MAGI's repo pulls
untagged `:latest` images and today's drifted; our local copy is patched to
cope. Suggest upstream pin tags.

### ~~🔴 blocker~~ (RESOLVED above) — original note for context

The real migration is 6,039 `migrate` calls, and MAGI freezes each call's FULL
`rc_limit` for the 5-day thaw. Even at a lean 300 RC per call that is ~1.8M RC
(≈1,800 HBD parked) to run singly. **Add `migrate_batch` (bounded, ~50
accounts per call → ~121 calls) before the production freeze** and teach
`tools/migrate.py` to use it. This must be designed and tested on throwaway #3
— after the burn it is exactly the kind of thing nobody can add.

## Night run 2026-08-21 (02:00–05:00) — real-chain facts and new tooling

Everything below was measured against the REAL chain or rehearsed end to end
while Lasse slept. Standing permission for the night: RC-only broadcasts to the
throwaway contract via `tools/chain-test/call.js` (the contract id is pinned
inside it; the allow rule in `.claude/settings.local.json` should be removed
once the throwaway phase ends).

### The real broadcast pipeline — WORKS

`vsc.call` custom_json on Hive L1, ACTIVE key, json =
`{net_id:"vsc-mainnet", contract_id, action, payload, rc_limit, intents}`
(format lifted from go-vsc-node's own devnet harness). `tools/chain-test/call.js`
broadcasts it; the REAL `init` executed on MAGI and its contract output reads
`"initialised at height 109200956", ok: true`.

### MAGI facts measured tonight

- **RC economics, decoded from the node source (rc-system/):**
  capacity = **MAGI HBD balance in milli-units + 10,000 free** per hive:
  account (12 HBD ⇒ 22,000 RC). Consumed RC **thaws linearly over 5 days**.
  ⚠️ **THE TRAP: admission charges and freezes the full `rc_limit`, not the RC
  actually used.** Six calls at rc_limit=100,000 froze @lassecashmagi to
  0 available (reading: 6/10,000) and locked it out for days — and the state
  of the one call that reported ok:true was **silently discarded at
  settlement** while its output still read success. NEVER trust an output's
  ok:true until the state is readable; NEVER set rc_limit above what you are
  willing to lock for 5 days. Defaults lowered to 1,500 in both
  `tools/chain-test/call.js` and `AiohaSigner`.
- **Failed outputs hide their errors from GraphQL** — `results{ok ret}` is the
  whole type, but the raw DAG (`getDagByCID(output.id)`) carries `errMsg`.
  That is how the RC lockout was diagnosed; it is the debugging tool of last
  resort for any on-chain failure.
- **`simulateContractCalls` caps at 10 calls per simulation**, state never
  persists between simulations, **a failed call aborts the rest of the batch**,
  and there is NO time travel — a payout window can never close inside a
  simulation. Anything time-dependent needs real broadcasts (slow) or the
  TESTWINDOWS build (fast).
- **Contract outputs carry only `{ok, ret}`** — no error text on-chain. The
  same failure diagnosed in simulation shows `err_msg`; diagnose there.
- ~~State finalization lags contract outputs~~ — WRONG, corrected same night:
  the state never landed because of the rc_limit freeze above. The
  `state_merkle` on every output stayed at the deploy-time value; reads were
  fine.
- **`transfer.allow` intent shape confirmed by the node**:
  `{type:"transfer.allow", args:{token:"hbd", limit:"1.000"}}` — accepted where
  its absence errored `no caller intent for: hbd`. Known trap from the node
  source: **`rc_limit` reserves HBD** (`PullBalance` reserves rc_limit−free_rc),
  so HBD-drawing calls need a LOW rc_limit or they starve their own draw.
  `AiohaSigner` now attaches exact-sized intents for `add_liquidity` and
  `swap_hbd_lc` (`HBD_DRAW_OPS`), rounding the limit UP to the milli-HBD.

### Migration executor — BUILT AND FULLY REHEARSED (`tools/migrate.py`)

6,039 non-zero accounts (703 of the 6,742 qualifiers hold 0 LC and are
skipped), credited against a virgin dev chain: **on-chain migrated supply
equals the snapshot total to the base unit** (1,906,873,606,104,624). Atomic
resume file; deterministic order; total verified before AND after.

**The contract now enforces ONE migration credit per account** (`mig/<acct>`
marker). Found by hostile rehearsal: deleting the progress file re-credited 8
accounts and the chain accepted all of them — an operator file must never be
the last line of defence. The executor treats "account already migrated" as
confirmation, so a lost progress file self-heals instead of stopping the run.

### TESTWINDOWS build — `./build.sh wasm-test`

`-tags testwindows` makes a "day" 6 minutes (240x): a 30-day mint matures in
3 hours, grace 3h, bleed 9h, viral payout 42min. **Emission and the 7%/yr
ratchet stay pinned to mainnet time** (HeightsPerYear/Era are now literals,
not multiples of the day), so observed VALUES are real — only the waiting
compresses. Init output is stamped `[TESTWINDOWS BUILD 240x]` so a deployment
can never be mistaken for the real one. Artifact:
`contract/artifacts/main-testwindows.wasm`. Costs 10 HBD to deploy; worth it —
it turns a week of lifecycle soak into one evening.

### Indexer — `MagiBackend.chain()` and `.account()` WIRED

Assembled from raw `getStateByKeys` reads; every derived figure goes through
the engine WASM. The bridge gained `entitlement(shares, accStart, accEnd)`
because mint yield now needs accumulator readings — the division lives in Go,
never TypeScript. Verified end to end against the real contract (mechanically:
well-formed views; the state itself was still awaiting finalization).
`api/src/real-read.e2e.ts` re-runs that check by hand.

## Second test deploy — SUCCEEDED 2026-08-20, `init` VERIFIED ON-CHAIN

The contract that matters. Carries the empty-vs-nil fix, the accrual rewrite,
and the unified `registerMint`.

| | |
|---|---|
| Contract id | `vsc1BeDGyQ9VK7C8yzFfLr8BWm4CtNFWSUFm7J` |
| Code CID | `bafkreihks63qzuexziwehc4u24bj755xd4qtdcqcbwrcu5si5wnfbqn24a` |
| WASM | 76,225 bytes |
| tx | `fe2898110851114423f1781d65b53e22f4499a3e` |

**Verified via `simulateContractCalls`, all free:** `init` succeeds on a virgin
contract ("initialised at height …") — the empty-vs-nil fix is proven against
real MAGI, not just MemStore. Full chain init→migrate→mint→advance→transfer all
succeed in one simulated tx.

**Measured gas (this contract):**

| Call | gas_used |
|---|---|
| `init` | 36M |
| `migrate` | 61M |
| `transfer` | 28M |
| `advance` (no-op) | 3.2M |
| `advance` (10-day walk) | 129M |
| full 1200-day walk | **5.85B** (~5M/day) |

⚠️ `rc_used` reports a flat 100 in every simulation — the gas→RC mapping is
unknown and needs observing on a real broadcast before trusting rc_limit
budgets.

**Bug found by the gas numbers, fixed locally (in 76,399-byte WASM, NOT yet
deployed):** `mint` silently absorbed the full catch-up walk (5.85B gas ambush
on an innocent user), and worse, a mint stamped while accrual lagged joined the
denominator for days predating it — the late-minter dilution reopened through
the lag window. Now `CreateMint`/`SettlePending` check accrual is current
BEFORE any money moves and refuse with "call advance" otherwise. The
before-money ordering matters: the first version refused after debiting and ATE
THE PRINCIPAL — caught by `TestMintIsRefusedWhileAccrualIsBehind` immediately.
The deployed throwaway has the old behaviour; fine for measuring, do not copy.

## First test deploy — SUCCEEDED 2026-08-20

The pipeline works end to end. This retires the largest unknown in the project:
the contract builds, uploads, passes witness storage proof, and MAGI accepts it.

⚠️ **The contract deployed by this transaction is BRICKED** — see the
empty-vs-nil bug above. It can never be initialised. That is not a failure of
the deploy; it is the deploy doing its job.

| | |
|---|---|
| Contract id | `vsc1BhcH9JyH8VGHJHpHF6XFAxyiAnXkWXHDy8` |
| Owner | `hive:lassecashmagi` |
| Code CID | `bafkreifj6j2fsbljayndaplypptop7wiebjrauzevee3q3p5u5muxbltwe` |
| Creation height | 109,200,956 |
| WASM | 72,351 bytes, 21 entrypoints |
| Cost | 10 HBD |

⚠️ **THROWAWAY.** Not the production contract. Its owner key still exists, its
state is not the migration, and no real user should be pointed at it. The
production deploy is a separate contract whose keys are burned (see
"Immutability").

The id lives in `web/.env.magi`, NOT `web/.env`, so it takes an explicit
`npm run dev -- --mode magi` to activate. `VITE_CONTRACT_ID` flips the frontend
into wallet mode, and the default should stay the local simulator.

**What this deploy does NOT prove**, and must still be tested against it:
- `vscCallContract` payload encoding — our entrypoints take one pipe-delimited
  `*string` and Aioha types the payload `any`. Deployed ≠ callable.
- Image-upload signing against real Keychain/PeakVault.
- `MaxCurationDrain = 20` against real gas, via `simulateContractCalls`.
- Whether the L-Share state layout is readable by a foreign contract — the
  🔴 blocker in "Open questions", and the reason to iterate here before burning
  anything.

## Deploying to MAGI — operational notes (`deploy.sh`)

Learned the hard way on 2026-08-20/21. Read before the next deploy.

**The deploy is three steps and they fail independently:**

1. Upload the WASM to the data-availability layer (libp2p → witnesses) → CID
2. Collect a signed storage proof from witnesses
3. Broadcast a Hive L1 transaction paying 10 HBD

Steps 1–2 succeeding tells you **nothing** about step 3. The first attempt got
a valid CID and a signed storage proof, then died on authority. No HBD is spent
unless step 3 broadcasts, so a failed deploy is free apart from RC.

**Preflight — `./deploy.sh preflight`, also run automatically by `deploy`:**

`tools/preflight.py` checks, in the order these fail in practice:

| Check | Why it is first |
|---|---|
| Config key really is the account's ACTIVE key | The only check that has ever caught anything |
| ≥10 HBD on **Hive L1**, not MAGI | The fee is an L1 transfer; MAGI HBD cannot pay it |
| RC not exhausted | MAGI has no fees, so RC is the entire cost |

The authority check matters most: MAGI's error is
`Missing Active Authority <account>`, which reads like a permissions bug but is
almost always the wrong key pasted from the wrong wallet window. When the key is
wrong, preflight names which role it actually is (owner / posting / memo /
another account entirely) so the fix is obvious rather than a hunt.

Pure standard library, including secp256k1 point multiplication — a deploy
preflight that needs `npm install` is one more thing to break at the moment you
least want it to. Verified against `@hiveio/dhive`: two independent
implementations derive the same public key.

⚠️ **Never print or echo the private key.** It sits in plaintext in
`deploy-data/config/identityConfig.json` because that is how the upstream tool
works. Diagnostics derive the *public* key and compare — the private value is
never displayed, logged, or sent anywhere. Keep it that way.

**Two Docker gotchas, both already fixed in `deploy.sh`:**
- `--network host` is required. The deployer runs libp2p and needs the inbound
  side of the witness handshake; on Docker's default bridge it silently hangs.
- `--user "$(id -u):$(id -g)"` and `-e HOME=/tmp`, or `-init` writes the config
  as root and you cannot edit the file you must put your key in.

**Do not edit `deploy.sh` while it is running.** Bash reads scripts
incrementally, so an edit mid-run produces a bogus
`unexpected EOF while looking for matching '"'` at a line that is perfectly
valid. That error in the 2026-08-20 log was this, not a real syntax bug.

**The deployer exits 0 even when the broadcast fails.** `deploy.sh` therefore
greps its output and exits non-zero itself. Do not trust the exit code alone.

## Resolved

- ✅ **Trading pair** → `LASSECASH:HBD`. Magi routes all pools through HBD.
- ✅ **Block time** → heights are 3s (Hive), MAGI blocks every 10th height (30s).
- ✅ **Historic issuance "contradiction"** → not a contradiction. The original
  model budgeted 20M of inflation for the *first 10 years* from the 2019
  launch. Migrating in 2026 means only ~7 years of that were actually paid
  out; the unpaid remainder still sitting in `@lassecash` is what gets burned.
- ✅ **Prior Gemini codebase** → deliberately discarded. 3–4 sessions across 3
  repos, judged not worth the tokens or the distraction. Do not go looking for
  it. The gap list in "Note: L Shares and stuff" is the only thing salvaged.

## Legacy chain facts — QUERIED LIVE 2026-08-20

From the Hive-Engine `tokens` contract (`api.hive-engine.com/rpc/contracts`):

| Field | Value |
|---|---|
| `precision` | **8** — confirms the 8-decimal standard |
| `maxSupply` | **51,000,000.00000000** |
| `supply` | **31,000,000.00000000** (fully issued: 11M founder + 20M inflation) |
| `circulatingSupply` | 30,584,121.04046988 |
| `issuer` | `lasseehlers` |
| `unstakingCooldown` | 182 days |
| balance rows | ~10,500 accounts that ever touched LASSECASH |

**The hardcap resolves exactly:** 31M already issued + 20M new emission cap
= 51M precisely. The design saturates the cap with nothing left over.

`@lassecash` holds **7,431,834.35 LC** — issued but never distributed. This is
the "remainder" that burns at migration. (The 20M *was* fully issued; what was
never *paid out* is what burns. Wording in the spec should say "undistributed",
not "unissued".)

⚠️ Migrated-supply totals must be recomputed under the NEW liveness criteria
(see below) — the old 769-account figure used the superseded rules.

## Snapshot liveness criteria — REVISED 2026-08-20

The original criteria (activity within 90 days **AND** ≥100 LC held) are
**superseded**. Problems: `last_vote_time`/`last_post` are satisfied by
posting-key bots, and the 100 LC floor excludes real humans for no good reason
(only ~10,500 accounts ever touched LasseCash — the set is small enough that
pruning by size is counterproductive).

**New rule: prove a human holds the ACTIVE key.** Bots run on the posting key;
transfers, delegations and account updates require active authority.

Qualifying operations (Hive layer), via `account_history_api` with
`operation_filter_low = 572849853039644`:

| Op | ID |
|---|---|
| `transfer` | 2 |
| `transfer_to_vesting` | 3 |
| `withdraw_vesting` | 4 |
| `account_update` | 10 |
| `transfer_to_savings` | 32 |
| `delegate_vesting_shares` | 40 |
| `account_update2` | 43 |
| `recurrent_transfer` | 49 |

Server-side filtering means **one request per account** returns the most recent
active-authority op — ~10,500 requests total, which is tractable.

Also counted: LASSECASH activity on the Hive-Engine layer (token transfers,
stakes) — proves engagement with LasseCash specifically rather than just Hive.

**No minimum balance.** Dropped deliberately.

### ⚠️ CRITERIA BUG FOUND 2026-08-21 — results below are INVALID, rescan running

Lasse caught it from @albinogaluppini's PeakD history: the scanner counted
operations that merely INVOLVE an account — received dust transfers, power-ups
paid by someone else, third-party stakes, buyers filling old sell orders,
automatic distribution payouts. None prove the holder is alive. Fixed in
`fetch.py`: only ops the account itself SIGNED count (`from` = account for
transfers/stakes, the account for updates, `delegator` for delegations;
Hive-Engine walk filtered server-side via `ops=` to skip the
`distribution_checkPendingDistributions` flood). Two API traps handled: hive
`get_account_history` requires `start >= limit-1` when paging near history
start; truncated searches are recorded as `search_truncated`, never as "dead".

Ground truth from the fixed scanner: @albinogaluppini has NEVER signed an
active-authority op (his only two filtered ops were signed by others);
@signumpizza's last signed action on either chain is May 2022 — the #2 holder
(1.3M LC, all liquid) is 4+ years silent and burns in any reasonable window.
**RESCAN COMPLETE 2026-08-21 (signed-ops-only). Corrected table:**

| Window | Migrating | Liquid | Staked | Total | To hive:null |
|---|---|---|---|---|---|
| 3 mo | 2,263 | 1.29M | 11.42M | 12,715,326.62 | 17,047,832.63 |
| 6 mo | 2,909 | 1.82M | 12.06M | 13,877,685.48 | 15,885,473.76 |
| 9 mo | 3,511 | 1.93M | 12.29M | 14,218,628.43 | 15,544,530.82 |
| **12 mo (current set)** | **4,075** | 2.32M | 12.90M | **15,225,074.83** | **14,538,084.41** |
| 24 mo | 5,828 | 3.09M | 13.73M | 16,819,786.07 | 12,943,373.18 |

Full snapshot total 29,763,159.24433197 is window-independent (owners + null).
The buggy scan had 6,742 / 19.07M at 12mo — 2,667 "alive" accounts were
fake-alive. Founder share at 12mo: 47.43%. @signumpizza burns at every window
(silent since 2022); @albinogaluppini burns at ≤12mo. `migration_set.json` is
the corrected 12-month set; `migration_set.pre-signed-fix.json` and
`activity.pre-signed-fix.json` are the buggy originals, kept for comparison.
### ✅ WINDOW DECIDED 2026-08-21: 3 MONTHS, with an announced roll call

Lasse's reasoning, in his words: LasseCash *"is not just money like bitcoin,
its a social media DEFI NFT product, which justify that you need to be active
and pay attention"*; many holders got free tokens and mocked the project;
*"people that snooze lose, supporters that used it gets their tokens."*

**The roll call is what makes it earnest:** the migration is ANNOUNCED, and
anyone inactive for more than 3 months has **one week** to sign a single
active-key operation (or a LASSECASH action) to keep their stake. Nobody is
burned without an opportunity. (Claude suggested two weeks as cheap insurance
against "I never saw it" — Lasse's call.)

**This SUPERSEDES open question 2's retroactive genesis rule.** The snapshot
height now comes AFTER the announcement + roll-call window, not two weeks
before it. The only thing "gameable" is saving your own tokens, which is the
definition of being alive. Re-run `fetch.py activity` (resumable, ~1h) right
before the snapshot height so the roll call counts.

Founder ownership by window (corrected data): 3mo **56.80%** of supply /
61.29% of L-Shares; 6mo 52.05%; 12mo 47.44%; 24mo 42.94%. Accepted as a
one-month condition, since migration mints are now 30 days (below) and Lasse
intends to mint only ~500k–1M voluntarily afterwards.

`apply_criteria.py` defaults to 3 months.

**SECOND SNAPSHOT GAP FIXED 2026-08-22 (Lasse: "I would not think it would
be 600,000").** The 609k "lost" under the cap was NOT dust: **553,160.29 LC
in the SWAP.HIVE:LASSECASH Diesel pool (125 LPs, each owning
shares/totalShares of the reserve) and 50,355.25 LC in open SELL orders on
the Hive-Engine market** — owned, but held by contracts, not balances.
`fetch.py balances` now reads `marketpools` pools + liquidityPositions and
`market` sellBook and credits both to their owners as LIQUID (`pooled`,
`onOrder` fields). Full snapshot: **30,994,197.67245149 LC** — genuinely
lost dust is **5,802.33 LC** against Hive-Engine's 31M issued. Corrected
3-month set: 2,260 accounts, 13,728,741.07919908 LC migrate;
17,265,456.59325241 LC to hive:null; founder 52.94% (he is an LP too).
Root `f22793d7…e9af2`. Executor re-pinned. Lesson: the only honest check
of a snapshot is reconciling to the token's ISSUED supply, to the base
unit, and explaining every gap by name.

**SNAPSHOT GAP FIXED 2026-08-21 (Lasse's "waiting on hive engine" remark):**
the scan counted only `balance + stake`. Two more buckets hold owners' real
tokens: `pendingUnstake` (93 accounts, 525,759.59 LC mid-cooldown) and
`delegationsOut` (57 accounts, 101,733.30 LC — a delegation leaves the
delegator's `stake` figure but is still theirs; `delegationsIn` is NOT the
receiver's and is never counted). Both were under lock, so both count as
STAKED → the 30-day migration mint. 24 accounts carry NEGATIVE Hive-Engine
dust (`pendingUnstake "-0.00000027"`, old unstake-code rounding); clamped to
zero per field. **Corrected 3-month set: 2,263 accounts, 13,301,866.36997268
LC migrate; 17,088,785.76217672 LC to hive:null; full snapshot
30,390,652.13214940 LC. Hardcap: + 20M = 50,390,652.13 < 51M, headroom only
609,347.87 LC** — the "lost dust" gap to Hive-Engine's 31M shrank from 1.24M
to 0.61M. Founder share 54.29%. Dev chain reseeded and verified;
`tools/migrate.py` EXPECTED_TOTAL re-pinned. Re-run the full pipeline
(`fetch.py balances` + `activity`, `apply_criteria --write`, re-pin) right
before block X.

### ✅ MIGRATION MINTS ARE 30 DAYS — DECIDED 2026-08-21 (spec said 6 months)

`engine.MigrationMintDays = 30`. Everyone is liquid at day 30 and decides
fresh what to mint; dead stake bleeds to zero by day 150 (30 lock + 30 grace
+ 90 bleed = five months) and recycles. Limits the founder's unchosen 61% of
migration shares to one month of pool draw (~35k LC in era 1 instead of
~209k over six months). WASM 81,445 bytes.

### Snapshot results — FULL SCAN COMPLETE 2026-08-20 (⚠️ superseded, see above)

All 11,236 accounts scanned across both chains (35 min). Raw data in
`tools/snapshot/data/`. Re-run `apply_criteria.py` to retune instantly — never
re-scrape.

| Window | Migrating | Migrated supply | Burned |
|---|---|---|---|
| 3 mo (old spec) | 3,624 | 16,785,198.07721682 | 12,977,961.16711515 |
| 6 mo | 5,820 | 18,176,163.03033675 | 11,586,996.21399522 |
| **12 mo (recommended)** | **6,742** | **19,068,736.06104624** | **10,694,423.18328573** |
| 24 mo | 8,012 | 19,636,954.27328576 | 10,126,204.97104621 |
| 36 mo | 9,851 | 20,437,468.51059389 | 9,325,690.73373808 |

**Key insight: the window is no longer the bot filter — the auth level is.**
Bots run on the posting key and cannot produce active-authority ops at all, so
they are excluded regardless of window. That means the window can be generous
without readmitting bot distortion. A 3-month window burns 3,118 accounts and
2.28M LC belonging to plausibly-live humans, for no bot-filtering benefit.

**Protocol burn (2 accounts, 7,847,713.31 LC):**
`@lassecash` 7,431,834.35 + `@null` 415,878.96

**HARDCAP VERIFIED at 12 months:**
```
migrated supply       19,068,736.06104624
+ max future emission 20,000,000.00000000
= maximum ever        39,068,736.06104624
historic hardcap      51,000,000.00000000
headroom              11,931,263.93895376   OK
```

**Dual-signal design validated:** 175 accounts qualified via LASSECASH activity
alone and would have been wrongly burned by a Hive-only check.

Founder concentration at 12mo: `@lasseehlers` holds 7,222,688.56 LC = **37.88%**
of migrated supply (next largest: `@signumpizza` 6.84%, `@tibfox` 2.76%).

## Open questions — resolve before the affected code is written

1. ⚠️ **Reduction rate not chosen.** DECIDED: keep spec's −50%/era (year 75).
   See "Longevity" below.
2. ⚠️ **Genesis height not chosen — but the RULE is now fixed.** Lasse: set it
   to a height **2 weeks BEFORE the migration is publicly announced**, i.e. the
   snapshot is retroactive. Nobody can farm qualification after learning the
   height, because it already passed.
   Tradeoff, accepted: someone who buys LASSECASH in that final fortnight is
   not captured. Low impact — balances migrate 1:1 and the liveness test looks
   back 12 months, so there is little to game either way.
   The value is chosen only after the migration is built and test-deployed to
   MAGI (~10 HBD per deployment, unadvertised).
3. ✅ ~~Early-end penalty curve ambiguous.~~ RESOLVED — linear 50%→100%
   recovery. See "LasseMint rules".
4. ✅ ~~Good Accounting conflicts with the 4-month bleed.~~ RESOLVED — it
   changes `GraceDaysFor()` to 1095 days and nothing else.
5. ✅ ~~2.25x multiplicative or 2.0x additive?~~ RESOLVED — **multiplicative,
   2.25x maximum**, both 1.5x ceilings hardcoded.
6. ✅ **DECIDED 2026-08-21: yield ENDS AT MATURITY.** Lasse: *"yes yield ends
   at maturity for sure"*. A matured mint stops drawing from the L-Share pool;
   grace becomes the pure safety net CLAUDE.md always described, rather than a
   30-day bonus that everyone rationally farms while diluting minters who are
   still locked. **Not yet implemented** — it lands with the yield-accounting
   rewrite in item 8, which is the only place there is to put it.
7. ✅ ~~L-Share state layout must be frozen deliberately.~~ FROZEN 2026-08-21 —
   see "Public state ABI". Pinned by `public_abi_test.go`.

## L-Share yield accrual — REWRITTEN 2026-08-21 (was a launch blocker)

**The bug.** Yield was claimed as `pool * myShares / totalShares` at the moment
of claiming. Nothing recorded WHEN a mint began earning, so a mint created one
second ago had the same claim on a year of accumulated emission as one locked
for that year. Two identical 30-day mints, alice first:

| | alice | bob |
|---|---|---|
| before — alice alone | 78,493.15 | — |
| before — bob mints as she matures | **44,344.81** | **112,641.49** |
| **after the rewrite** | **78,493.14855978** | **78,493.14855993** |

The incentive was to claim LAST, not to lock LONGEST. Now alice is unaffected by
bob's arrival and bob earns the same as she does for the same commitment.

**The fix — cumulative reward-per-share** (`engine/accumulator.go`,
`contract/state/accrual.go`):

```
yield = shares * (acc[maturityDay] - acc[creation]) / AccScale
```

`acc` only ever rises, so the subtraction is exactly the emission that arrived
while those shares were live. Two reads: a 1-day mint and a 1095-day mint cost
the same to settle, which matters because gas is charged to the caller's RC.

**How HEX does it, and why we differ.** HEX stores per-day payout figures and
its `stakeEnd` LOOPS over every day the stake was active — correct, but it is
why ending a long HEX stake is expensive. Storing the running TOTAL instead of
the per-day amount turns that loop into a subtraction. HEX's rising share rate,
which makes later stakers earn fewer shares per token, LasseCash already had as
the 7%/yr ratchet.

### Design points that must not be undone

- **Yield STOPS AT MATURITY** (Lasse's call, open question 6). The mint's shares
  leave the active denominator and its accumulator reading is frozen at its
  maturity-day checkpoint. Grace is a safety net again, not a farmable bonus.
- **`shares/<account>` and `shares/total` deliberately differ.** Held shares
  vote; active shares earn. A matured mint keeps governance weight until it is
  claimed but earns nothing.
- **Recycled value flows through the accumulator** (`Recycle`). The pool balance
  alone grants nobody a claim, so penalties added without raising the
  accumulator would sit unclaimable forever.
- **`accAt/<day>` is written ONLY on days where mints mature** — the only days a
  historical reading is ever needed. Every day would be 27,375 dead rows.
- **Pool credits are written once per walk, not once per day.** An ordinary day
  in the walk costs ONE state read.
- **`AccumulatorStep` distributes a whole inflow or none of it.** An earlier
  version carried the floored remainder forward, which advanced the accumulator
  a second time on value already counted and made claims exceed the pool.
  Caught by `TestAccumulatorConservesValue`.
- **`MinSharesForAccrual` is an OVERFLOW GUARD, not policy.** A dust share base
  makes each step enormous; the inflow is held and distributed in full once a
  real share base exists.

### ⚠️ Second bug in the same rewrite, caught pre-deploy 2026-08-21

`pob.go` carried its own copy of the mint-registration tail (its comment even
claimed it "routes through the ordinary mint path" — it did not). The accrual
rewrite therefore never reached the monthly PoB mint: its `AccStart` stayed 0,
entitling it to the ENTIRE accumulator history since genesis, and its shares
never left the active denominator at maturity. A PoB mint created in year 3
would have claimed three years of everyone else's emission.

Fixed by extracting **`registerMint()` — now the ONE way a mint enters state**
— and calling it from both paths. `TestPoBMintEarnsExactlyLikeACapitalMint`
pins the parity: identical amount, moment and duration must earn identically,
whether the principal came from capital or from Proof-of-Brain earnings.

**The lesson, again: duplicated tails are where rewrites silently miss.** Found
by grepping for `putMint`/`NewMint` call sites after the rewrite — do that
after any change to mint lifecycle, and check `ACTIVE_OPS` after any new
entrypoint, for the same reason.

### New entrypoint: `advance` (22 total)

Permissionless, pays nothing. Every ordinary transaction advances the
accumulator anyway; this exists only because the walk is capped per call, so
after a long silence a claim can find it still behind its maturity day. No
bounty, deliberately — a reward here would create an incentive to keep the chain
quiet.

⚠️ **`MaxAccrualDays = 1200` IS A GUESS AND MUST BE MEASURED**, like
`MaxCurationDrain`. 1200 covers a maximum-length mint so a three-year position
is always claimable in one transaction. Measure a full-length walk with
`simulateContractCalls` against a test deployment.

WASM after the rewrite: 76,225 bytes.

## Public state ABI — FROZEN 2026-08-21

After the key burn these keys are permanent. Future dApps derive the governing
top-10 by reading them from core state with `sdk.ContractStateGet`. Nobody will
ever be able to rename them, so they were reviewed and pinned on purpose rather
than inherited from whatever the code did.

⚠️ **RE-KEYED 2026-08-21, same night: SLASHES DO NOT PERSIST ON MAGI.**
Proven empirically against the throwaway: a contract whose keys contain `/`
has every write silently dropped (the node's DataBin treats `a/b` as a nested
directory, and the deployed mainnet version loses nested leaves at save —
outputs still report ok:true, `metadata.currentSize` still grows, and the
state merkle stays at the empty-root CID `QmX4ymp…`). Working mainnet
contracts (`hive_hbd_lp` etc.) all use FLAT keys, and their flat keys read
fine. **Every key in this contract is now flat, `_`-separated** — safe because
Hive account names cannot contain `_` and keys are constructed, never parsed
(the one parser, the simulator's post scan, splits at the FIRST `_`).
Report the node bug to the VSC devs; do not reintroduce `/` even if fixed —
deployed witnesses lag the repo.

| Key | Value | Meaning |
|---|---|---|
| `gov_board` | `hive:a\|hive:b\|…` | up to 20 candidate accounts, pipe-separated |
| `shr_<acct>` | `"123456789"` | **held** L-Shares, 1e8-scaled, plain decimal |
| `bal_<acct>` | `"376600000000"` | liquid balance, same encoding |

`<acct>` is the **fully qualified** address exactly as the SDK renders the
sender — `hive:alice`, never bare `alice` — so a `did:pkh:…` account can never
collide with a Hive one. Tested with a `did:` holder taking seat 0.

**How a dApp derives the top 10:** read `gov_board`, read `shr_` for each name,
pass the pairs to **`engine.ConsensusGroup`** — the same Go package, imported.
21 bounded reads, zero re-implemented ranking. That is the golden rule applied
across contracts: the tie-break (shares desc, then name asc) and the zero-share
drop live in one place.

**`shr_` is LIVE voting weight — SUPERSEDED 2026-08-21.** It used to include
matured-but-unclaimed mints; since "ALL voting power ends at maturity" the
accrual walk retires a mint's shares from `shr_` on its maturity day, so
`shr_` and the active total now agree. A dApp reading `shr_` sees exactly the
figure core governance uses, and a dead account cannot haunt the top-10.

`public_abi_test.go` is the executable form of this table: a `foreignReader`
that uses nothing but raw key reads must reproduce `ConsensusMembers` exactly,
and the key strings and encodings are pinned as goldens. **If it fails, the ABI
moved. After launch that is impossible, so it must not move before.**

Everything NOT in this table — mint records, `acc/*`, `exp/*`, pools, the
curation queue — is internal and may change freely on a throwaway deploy.

## Source documents

- [docs/LasseCash Core Migration to MAGI.md](docs/LasseCash%20Core%20Migration%20to%20MAGI.md) — the main spec
- [docs/Note: L Shares and stuff.md](docs/Note:%20L%20Shares%20and%20stuff.md) — gap list from the discarded Gemini build
- [docs/old about page LasseCash.md](docs/old%20about%20page%20LasseCash.md) — pre-migration tokenomics (2019 launch, 51M cap, 20M/10yr)
- [docs/DAPPs build on LasseCash in the future possibly.md](docs/DAPPs%20build%20on%20LasseCash%20in%20the%20future%20possibly.md) — future scope, explicitly NOT in core migration (no NFTs)

`.md` files are generated from the `.odt` originals. If an `.odt` is updated,
regenerate rather than editing the `.md` by hand.

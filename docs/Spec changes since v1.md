# Spec changes since v1

**What this is.** A complete, ordered list of everything decided since
`LasseCash Core Migration to MAGI.odt` was written, so the `.odt` can be brought
current in one sitting. Every entry gives the original spec text, the rule that
replaces it, the date and reasoning, and whether it is built and tested or only
decided.

**How to read it.** Where CLAUDE.md and the spec already agree, the entry says
so and asks only for a wording tightening — those are cheap edits, do them.
Where an item was never in the spec at all it is marked **not in spec (new)**;
those are additions, not corrections.

**The last section lists what is STILL CORRECT.** Do not touch those numbers.

Sources: `CLAUDE.md` (the decision log) and the code it describes
(`engine/`, `contract/state/`), verified against the source while writing.

---

## Migration & snapshot

### 1. Liveness test is now "did this account SIGN an active-key operation"

**Spec says** (§1, *Criteria (a): Recent Activity & Engagement*):
"An account must show verifiable chain activity (such as a post, comment, or
vote) within the last 3 months (90 days), OR be designated as an active core
platform account. Implementation: Cross-references the Hive condenser API for
`last_vote_time` and `last_post` timestamps."

**Now:** an account qualifies only if it **itself signed** an operation
requiring **ACTIVE authority** on Hive, or signed a **LASSECASH action** on
Hive-Engine, inside the window. Qualifying Hive operations (via
`account_history_api`, `operation_filter_low = 572849853039644`): `transfer` (2),
`transfer_to_vesting` (3), `withdraw_vesting` (4), `account_update` (10),
`transfer_to_savings` (32), `delegate_vesting_shares` (40), `account_update2`
(43), `recurrent_transfer` (49).

**Operations that merely INVOLVE the account do not count** — received
transfers, power-ups paid by someone else, third-party stakes, a buyer filling
your old sell order, automatic distribution payouts. The test is `from` =
account for transfers and stakes, the account itself for updates, `delegator`
for delegations.

**Decided:** 2026-08-20 (auth level), corrected 2026-08-21 (signed-only).
Posts, comments and votes are signed with the POSTING key, which bots hold;
active authority is the thing a human keeps. Lasse caught the "involves"
bug himself from @albinogaluppini's PeakD history — an account with zero signed
active ops was being scored as alive because two operations signed by other
people mentioned it.

**Status:** built and tested. Full rescan of all 11,236 accounts complete
(`tools/snapshot/`, ~1h, resumable). Ground truth from the fixed scanner:
@signumpizza — the #2 holder, 1.3M LC — has not signed anything on either chain
since May 2022 and burns at every window.

---

### 2. No minimum balance

**Spec says** (§1, *Criteria (b): Minimum Token Holding Threshold*):
"An account must hold a combined total of at least 100.0 LASSECASH (liquid
balance plus staked power combined) … Ensures dust accounts and empty wallets
are filtered out."

**Now:** **there is no minimum balance.** Criteria (b) is deleted entirely.
Liveness is the only test; the "both of the following qualifying criteria"
sentence in §1 becomes a single criterion.

**Decided:** 2026-08-20. Only ~10,500 accounts ever touched LASSECASH — the set
is small enough that pruning it by size costs real humans their tokens for no
technical benefit. The auth level, not the balance, is what excludes bots.

**Status:** built and tested. (703 of the qualifying accounts hold exactly 0 LC
and are simply skipped by the migration executor — nothing to credit.)

---

### 3. Window is 3 months, with an ANNOUNCED one-week roll call — and the snapshot happens AFTER the announcement

**Spec says** (§1): "Announced 2 weeks prior (but noticed already August 12,
2026 in a public post on LasseCash), any account completely inactive for 3
months is omitted."

**Also supersedes** an internal decision that never reached the spec: the
genesis height was to be set **2 weeks BEFORE** the public announcement, making
the snapshot retroactive and unfarmable.

**Now:**
- Window: **3 months** of signed activity.
- The migration is **announced**, and anyone inactive for longer than 3 months
  has **one week** to sign a single active-key operation (or any LASSECASH
  action) to keep their stake.
- The **snapshot height comes AFTER the announcement and after the roll-call
  week**, not before it. `fetch.py activity` is re-run immediately before the
  snapshot height so the roll call counts.

**Decided:** 2026-08-21. In Lasse's words, LasseCash *"is not just money like
bitcoin, its a social media DEFI NFT product, which justify that you need to be
active and pay attention"*; many holders got free tokens and mocked the project;
*"people that snooze lose, supporters that used it gets their tokens."* The roll
call is what makes a hard window earnest — nobody is burned without an
opportunity, and the only thing "gameable" is saving your own tokens, which is
the definition of being alive. (Claude proposed two weeks as cheap insurance
against "I never saw it"; one week is Lasse's call.)

**Status:** built and tested. `apply_criteria.py` defaults to 3 months;
`migration_set.json` is the 3-month set; dev chain reseeded and verified.

---

### 4. Snapshot results at the chosen window — **not in spec (new)**

The spec quotes no figures. These are the ones to put in it, if any:

| | |
|---|---|
| Accounts migrating (3-month window) | **2,263** |
| Migrating to their owners | **12,715,326.61552232 LC** (1.29M liquid + 11.42M staked) |
| Credited to `hive:null` | **17,047,832.62880965 LC** |
| Full snapshot total (window-independent) | **29,763,159.24433197 LC** |
| Founder share at 3 months | **56.80%** of supply, **61.29%** of L-Shares |

Hardcap arithmetic: 29,763,159.24 migrated + 20,000,000 maximum future emission
= **49.76M**, against the 51M historic hardcap. Headroom ~1.24M.

Founder concentration by window, for reference: 3mo 56.80% / 6mo 52.05% /
12mo 47.44% / 24mo 42.94%. Accepted as a **one-month** condition, because
migration mints are now 30 days (item 5) and Lasse intends to mint only
~500k–1M voluntarily afterwards.

**Status:** measured and rehearsed end to end. The migration executor
(`tools/migrate.py`) has credited the full set against a virgin dev chain with
the on-chain total matching the snapshot to the base unit.

---

### 5. Staked LASSECASH POWER becomes a **30-day** migration mint, not a 6-month one

**Spec says** (§1, *Staked Power Conversion*): "Old staked power is translated
directly into Migration L-Shares 1 to 1. These are automatically placed into a
**6-month** migration mint to flush out legacy liquidity and purge past dead
weight."

**Now:** **30 days** (`engine.MigrationMintDays = 30`). Everything else in that
sentence stands:
- L-Shares **exactly 1:1** with the staked amount — **no Longer-Pays-Better, no
  Bigger-Pays-Better, no share rate**. Legacy stake is not a new voluntary
  commitment, so it keeps the weight it already had and nothing more. A
  voluntary 30-day mint of the same size would earn *less*; a voluntary 182-day
  one would earn *more*. The migration mint gets neither.
- Every migration mint is stamped with the **genesis height**, not the height of
  the batch that credited it, so batches landing over hours all mature on the
  same day.
- The "flush out legacy liquidity / purge dead weight" mechanic is just the
  ordinary lifecycle: a dead account's migration mint matures at day 30, bleeds,
  and is fully recycled into the reward pool by **day 150** (30 lock + 30 grace
  + 90 bleed).

**Decided:** 2026-08-21. Lasse caught that the contract had no staked-power path
at all ("they get 6 months mints for the lassecash power, so your numbers dont
add up"), and then shortened the lock: six months would let the founder's
unchosen 61% of migration shares draw the L-Share pool and dominate governance
for half a year (~209k LC in era 1 versus ~35k at 30 days). One month resets the
system fast — everyone is liquid at day 30 and decides fresh what to mint. It is
also shorter than the 182-day Hive-Engine unstaking cooldown the stake was
already under, so nobody is locked longer than the rules they staked beneath.

**Status:** built and tested (`TestMigrationMintConvertsStakedPowerOneToOne`).
Would have been **unfixable after the key burn** had Lasse not caught it.

---

### 6. Burns credit `hive:null` and stay visible forever — nothing is destroyed

**Spec says** (§1, *The Clean Burn*): "The remaining undistributed reserve
sitting in @lassecash … is permanently burned (0% migrated) (by being moved to
@null at migration)." And in the Note on Exceptions: "Official protocol sink and
burn addresses (such as @lassecash) are explicitly omitted from migration, with
their unmigrated balances permanently directed to @null."

**Now:** the *direction* is right; the *accounting* changes.

- At migration, **everything that does not migrate is credited to `hive:null` as
  a LIQUID balance in one aggregate** — protocol accounts *and* non-qualifying
  holders, LASSECASH *and* POWER alike. Never as a mint. The contract refuses to
  let `null` stake, so it can never vote and never recycle.
- Hive's `null` has no keys, so `hive:null` is **provably unspendable** on MAGI.
- `burn()` is the one way value is ever burned anywhere in the system (the user
  `burn` entrypoint, and the PoB burn payout mode). `TotalBurned()` is simply
  `Balance(hive:null)`. The old `sup_burned` counter key is retired and must
  never be reused.
- **The supply identity is now: `sum of all holdings = migrated + emitted`.**
  Nothing is subtracted, nothing disappears; burns are visibly quarantined.
- **Consequence for the spec's numbers: migrated supply is the FULL snapshot,
  29,763,159.24433197 LC, including the null credit** — not just the 12.72M that
  reaches live owners.

**Decided:** 2026-08-21. Lasse's reasoning: the null account keeps the tokens
*"so we always can see how much is burned in the future"*. A counter can drift;
a balance anyone can query cannot.

**Status:** built and tested; verified on the dev chain.

---

### 7. The 51M hardcap is enforced in code at the one place supply enters

**Spec says** (§1): "The ecosystem strictly adheres to the historic 51M absolute
token hardcap."

**Now:** unchanged as policy, but worth stating as a mechanism —
`CreditMigration` is the **only** point at which supply enters from outside, and
it enforces `migrated_supply + 20,000,000 <= 51,000,000`, i.e.
`migrated_supply <= 31,000,000 LC`. A global `auditSupply` invariant runs in
every contract test and after every operation in the fuzzer.

**Decided:** 2026-08-20 (invariant), reaffirmed throughout.

**Status:** built and tested — 500,000 randomized economies fuzzed over 2h09m
with zero supply leaks or invariant breaks.

---

### 8. Migration is executed in batches — **not in spec (new)**, operational only

`migrate_batch` credits up to **50 accounts per call**; the full run is ~121
calls instead of 6,039. Atomic (a failing batch writes nothing) and idempotent
(the contract marks each account migrated once, so a resent batch is safe).
Both entrypoints are owner-only and genesis-phase-only.

**Decided:** 2026-08-21. MAGI freezes each call's full `rc_limit` for a 5-day
thaw, so 6,039 single calls would park roughly 1.8M RC (≈1,800 HBD).

**Status:** built and fully rehearsed. Include in the .odt only if you want the
mechanics documented publicly; it changes no economics.

---

## LasseMint rules

### 9. Early-end recovery: linear 50% → 100% — **spec already correct, tighten the wording**

**Spec says** (§4): "Breaking a time-lock contract early results in forfeiting
all accrued yield and a structural slash on the principal based on remaining
time (linear curve 50% at day 1, and 100% when the mint is mature). 100% of
penalties are swept instantly into the active reward pool."

**Now:** exactly this, stated precisely. Recovery of **principal** rises
linearly from **50% at creation** to **100% at maturity**; **all accrued yield
is forfeited** on any early end regardless of when. The slashed principal sweeps
into the L-Share reward pool — and, importantly, it flows **through the
accumulator** (item 18), so it becomes claimable rather than sitting in a pool
nobody has a claim on.

**Decided:** 2026-08-20 (this resolved the spec's original ambiguity — it did
not say whether the curve applied to principal, yield, or both).

**Status:** built and tested. Only wording to fix: "50% at day 1" reads as if
day 1 is special; the floor is at **creation** and it is already rising by day 1.

---

### 10. Post-maturity timeline: 30-day grace, then a 90-day bleed, applying to principal AND rewards

**Spec says** (§4, *Post-Maturity Expiry & The 4-Month Bleed Mechanic*): "Grace
Period (Month 1 / 30 Days): Yield generation stops at maturity; principal and
rewards remain 100% safe. Linear Bleed Phase (Months 2, 3, and 4) … Total
Liquidation (Month 4 / Day 120)."

**Now:** unchanged in shape, with one clarification the spec left open —
**the bleed applies to principal AND accrued rewards together**, linearly per
height, from 100% at day 30 to 0% at **day 120** after maturity. Everything bled
sweeps to the L-Share reward pool through the accumulator.

```
maturity ──30d grace (nothing happens)──► ──90d bleed 100%→0%──► day 120: zero
```

**Decided:** 2026-08-20. Grace exists so that illness or forgetfulness costs
nothing; the bleed enforces a promise the minter was paid up to 1.5x to make.

**Status:** built and tested at every boundary (`TestMintLifeAtEveryBoundary`
names creation, day 1, halfway, 1094, maturity, grace start/end, mid-bleed, one
day from zero, liquidation, and long past it).

---

### 11. Yield STOPS at maturity — **spec already says this; it is now actually implemented**

**Spec says** (§4): "Yield generation stops at maturity" (grace bullet), and
"When a mint hits maturity, it stops earning yield but remains locked in an
Unclaimed/Matured state" (Good Accounting bullet).

**Now:** the spec was right and the code has caught up. At maturity the mint's
shares **leave the active earning denominator** and its accumulator reading is
frozen at its maturity-day checkpoint. A matured, unclaimed mint earns exactly
zero from then on.

**Decided:** 2026-08-21. Lasse: *"yes yield ends at maturity for sure"*. The
alternative — earning through grace — turns a safety net into a 30-day bonus
that everyone rationally farms, diluting the minters who are still locked.

**Status:** built and tested. This was open question 6 and it landed with the
yield-accounting rewrite (item 18).

---

### 12. Good Accounting: owner-only, armed only during the 30-day grace AFTER maturity, extends grace to 3 years

**Spec says** (§4, *Tax Deferral via "Good Accounting"*): "Users can toggle
'Good Accounting Mode' on individual minters. When a mint hits maturity, it stops
earning yield but remains locked in an 'Unclaimed/Matured' state, allowing the
user to delay the realization event to a preferred calendar year."

**Now, precisely:**

| | |
|---|---|
| Who may arm it | **The owner only.** No third-party arming, ever. |
| When it may be armed | **From maturity until the end of the ordinary 30-day grace** — i.e. the moment before the bleed would start. Never before maturity; never once bleeding. |
| What it changes | **One constant: the grace period, 30 days → 1,095 days (3 years).** Nothing else. |
| What happens after | The ordinary **90-day bleed** runs. Full liquidation at **day 1,185** after maturity. |
| Yield | Still zero from maturity. Good Accounting defers *realization*, it does not extend earning. |

**Decided:** the 3-year extension 2026-08-20; the arming window moved to the
post-maturity grace on 2026-08-21 (**this supersedes an earlier internal rule of
"the final 7 days before maturity"** which never reached the spec). The owner is
then looking at a matured position with a real decision in front of them, and
the anti-abuse property holds by construction: arming is only possible **before
any bleed**, so nobody can watch themselves lose value and retroactively opt
out. HEX arms after maturity too — but unlike HEX this stays strictly
owner-only, because a stranger must not be able to reshape someone's tax
position.

**Why 3 years and not 1:** tax years are annual everywhere, so a one-year window
offers only a single year-end to choose from. Deferral is usually about reaching
a low-income or loss year, rarely next year specifically. Three years gives four
tax years to pick from.

**Why finite at all:** an infinite hold would strand the principal of anyone who
lost their keys, permanently starving the recycling engine that funds the reward
pool after emission ends in year 75.

**Status:** built and tested (`TestGoodAccountingArmWindow`,
`TestGoodAccountingExtendsGraceToThreeYears`).

---

### 13. ALL voting power — governance AND post voting — ends 100% at maturity

**Spec says** (§4): "L-Shares determine your voting power in the proof of brain
for the reward pool and serve as your Voting Power for decentralized protocol
governance." The spec does not say when that power ends; the working assumption
was that held shares vote until the mint is claimed.

**Now:** **all voting power ends at maturity, for all mints, both kinds.** A
matured, unclaimed mint votes with **nothing** — not on posts, not on
parameters. Grace is a claim safety net, not a voting extension.

Mechanically: each mint registers into its maturity day's expiry schedule at
creation; the accrual walk drains that schedule when it crosses the day,
retiring the shares from the owner's holding exactly as it already retired them
from the active earning total. A close that beats the walk (early end, or a
claim on the maturity day) releases its own shares. The public `shr_` key is
therefore **live voting weight**, so any dApp reading it inherits the correct
set and no dead account can haunt the top-10.

**Decided:** 2026-08-21. Lasse: *"the governance voting power and the post
voting power should end 100% at maturity for all mints!!"*

**Status:** built and tested (`TestVotingPowerEndsAtMaturity`,
`TestExpiryDrainResumesAcrossWalkCalls` — the migration day, with thousands
maturing together, is crossed over several calls rather than one impossible one).

---

### 14. Dead positions can be swept — `sweep_mint` — **not in spec (new)**

**Now:** anyone may call `sweep_mint(owner, id)` on a mint whose owner is owed
**exactly zero** — a fully-bled position. It is **permissionless**, it **pays
the caller nothing**, and it runs through the same settlement path as a claim,
so it can only ever touch positions already worth nothing. It recycles the
principal into the reward pool and releases the governance weight.

**Decided:** 2026-08-21. Claiming used to be the only path that recycled a
mint's value, so a fully-bled, never-claimed position stranded its principal
outside the reward pool **forever** and kept its governance seat forever — a
zombie nobody could evict after the key burn. No bounty, deliberately: a bounty
would create an incentive to lobby for shorter expiries.

**Status:** built and tested (`TestSweepMintReleasesDeadPositions`,
`TestSweepMintRespectsGoodAccounting`).

---

### 15. Multipliers are MULTIPLICATIVE — 2.25x maximum — and only the amounts are governable

**Spec says** (§4, *LasseCash Tokenomics Rules*): duration 1.0x → 1.5x over
1–1,095 days; volume 1.0x → 1.5x over 10,000 → 100,000 LASSE. The spec never
says how the two combine.

**Now:** they **multiply**. 1.5 × 1.5 = **2.25x maximum** for a maximum-size,
maximum-duration mint. Both 1.5x ceilings are **hardcoded and immutable** —
there is no governance path to either. Only the **amounts** that trigger Bigger
Pays Better are governable (defaults 10,000 and 100,000 LC, bounded to
100–50,000 LC for the start and 1,000–5,000,000 LC for the end).

The duration ramp is entirely immutable, endpoints and ceiling alike.

**Decided:** 2026-08-20 (this was open question 5: multiplicative 2.25x versus
additive 2.0x).

**Status:** built and tested. Every step of the share computation floors, so a
minter can never receive more shares than the formula allows.

---

### 16. The minting formula in §4 is wrong and contradicts §4's own multiplier table

**Spec says** (§4): "Minting Formula: L-Shares = (Amount minted / shareRate) *
(Minting Days / 1,095 days)".

**Now:**

```
L-Shares = (principal / shareRate)
         × DurationMultiplier(days)      // 1.0 at 1 day → 1.5 at 1095 days
         × VolumeMultiplier(principal)   // 1.0 at ≤start → 1.5 at ≥end
```

The spec's `(days / 1095)` would give a 1-day mint 1/1095th of the shares of a
3-year one — that is not Longer Pays Better, that is a proportional split, and
it disagrees with the "Summary Table" three lines below it. **Replace the
formula line.**

**Decided:** implicit in the 2026-08-20 multiplier decisions; flagged here
because the .odt still carries the contradiction.

**Status:** built and tested (the implemented formula is the one above).

---

## Yield & emission

### 17. Emission is defined **per HEIGHT** (3-second Hive block) and paid every **10th** height (30-second MAGI block)

**Spec says** (§2): "Tokens are issued per block (1 block = 3 seconds) with a
50% halving every 3 years (31,536,000 blocks)", and the table's last column is
"Approx. Per-Block Reward: ~0.317 LC".

**Now — verified from the chain, not assumed:**
- `Env.BlockHeight` is the **Hive block height**, advancing every **3 seconds**.
  Measured: height 109,189,570 → 13:02:24, height 109,189,590 → 13:03:24.
- **MAGI produces a block every 10th height = every 30 seconds.** The witness
  schedule slot spacing is a constant 10, verified across heights 100,000,000 →
  109,190,000. A round is 120 slots = 1 hour.
- Therefore the spec's `31,536,000 blocks = 3 years` is **correct when read as
  heights** — do not change that number. What is wrong is the phrase
  "per-block reward": real payouts land every 10th height, in chunks **10×
  larger**.

**Replace the emission table with this** (exact, 8dp, produced by the engine's
own tests):

| Era | Years | 3-year budget | LC per height (3s) | LC per MAGI block (30s) |
|---|---|---|---|---|
| 1 | 1–3 | 10,000,000 | 0.31709791 | 3.17097910 |
| 2 | 4–6 | 5,000,000 | 0.15854895 | 1.58548950 |
| 3 | 7–9 | 2,500,000 | 0.07927447 | 0.79274470 |
| 4 | 10–12 | 1,250,000 | 0.03963723 | 0.39637230 |
| … | … | … | … | … |
| 26 | 76+ | — | **0** | emission ends |

**Decided:** 2026-08-20, measured from the live chain.

**Status:** built and tested.

---

### 18. Yield is a cumulative reward-per-share accumulator, not a snapshot division

**Spec says** (§4, *xReward Distribution*): "Payout Formula: User Reward = Pool
Rewards Accrued * (User's L-Shares / Total Network L-Shares)".

**Now:**

```
yield = shares × (acc[end] − acc[start]) / AccScale
```

where `acc` is a running total of reward-per-share that only ever rises, `start`
is the reading at the moment the mint was created, and `end` is the reading at
its maturity day.

**Why the spec's formula had to go — it was a launch blocker.** As written, the
division happens at the moment of claiming, and nothing records *when* a mint
began earning. A mint created one second ago had the same claim on a year of
accumulated emission as one locked for that year. Worked example, two identical
30-day mints with alice first:

| | alice | bob |
|---|---|---|
| spec formula — alice alone | 78,493.15 | — |
| spec formula — bob mints as she matures | **44,344.81** | **112,641.49** |
| **accumulator** | **78,493.14855978** | **78,493.14855993** |

The old incentive was to claim **last**, not to lock **longest** — the opposite
of what LasseMint is for.

Two further properties worth stating in the spec:
- **Recycled value (slashes, bleed, liquidation) flows through the accumulator.**
  Adding it to the pool balance alone would leave it unclaimable forever.
- **A 1-day mint and a 1,095-day mint cost the same to settle** — two reads, not
  a loop. This is where LasseCash differs from HEX, whose `stakeEnd` loops over
  every day the stake was active and is why ending a long HEX stake is
  expensive.

**Decided / rewritten:** 2026-08-21.

**Status:** built and tested. Path-independence is pinned:
`TestTimeTravelIsPathIndependent` lives the same three years three ways — settled
daily, monthly, and in one leap — and requires byte-identical end states. An
account nobody touches for years is not cheated, and a busy account is not paid
extra for being busy.

---

### 19. Nothing accumulates per tick — everything is closed-form in height, settled by an accrual walk

**Spec says** — nothing on this; it implies per-block accrual throughout.
**Not in spec (new).**

**Now:** emission and yield are **never** accumulated per tick. They are
closed-form functions of height, settled as the **difference** between the last
settled height and the current one. A contract may run irregularly, or not at
all for long stretches, and the math must not care.

Practical consequences worth one sentence in the spec:
- Anyone may call the permissionless **`advance`** entrypoint to walk the
  accrual forward; it pays nothing (a bounty would create an incentive to keep
  the chain quiet). Every ordinary transaction advances it anyway.
- A long silence is closed in affordable slices — `advance` takes an optional
  maximum-days argument, because a full 1,200-day catch-up walk in one call
  would cost roughly 58,500 RC (~58 HBD) and is not payable in a single
  transaction.
- Claim paths **refuse** while the accrual is behind, and say so, rather than
  ambushing an innocent user with the whole catch-up bill or mis-dating their
  shares.

**Decided / built:** 2026-08-21.

**Status:** built and tested; the gas figures above are measured against a real
deployment.

---

### 20. Emission ends in year 75; total ever issued is 19,999,994.01840000 LC

**Spec says** (§2): "Future inflation is strictly capped at 20,000,000 LASSECASH
forever", with a −50% halving every 3 years.

**Now:** the schedule is kept exactly as specified. Stating its consequences
precisely:
- Emission reaches zero in **era 26, year 76** — i.e. it **ends in year 75**.
- Total ever issued: **19,999,994.01840000 LC**. The 5.9816 LC shortfall is
  stranded by integer flooring and is **correct and intentional** — rounding
  always floors, so the chain under-issues and can never breach a cap.
- **A hard cap and perpetual new issuance are mathematically incompatible.**
  "Forever" comes from **recycling**, not issuance: the early-end slash, the
  90-day bleed and day-120 liquidation all sweep into the reward pool, are not
  new issuance, never touch the cap, and can pay out indefinitely after year 75.
  Emission is the bootstrap; recycling is the perpetual engine.

**Decided:** 2026-08-20 — keep the spec's −50%/era. Lasse's call: 75 years is
longer than the internet has existed, so optimising the year-2100 tail is false
precision. Design for the full 75-year run: *"no I dont [intend a hardfork], its
a possibility maybe the migration tokenomics will run for 50 years like
bitcoin."* (For reference, Bitcoin's issuance ends ~2140.)

**Known limitation, accepted deliberately and worth stating honestly:**
penalties, bleed and liquidation feed **only the L-Share pool**, so after
emission ends the Proof-of-Brain and Liquidity pools have no funding source. The
penalty destination is a single named constant, so a future hardfork could
redirect it without restructuring anything.

**Status:** built and tested; verified by `tokenomics_check.py`, which must be
re-run after any change to emission code and whose failure is a launch blocker.

---

### 21. The share rate starts at 1 LASSECASH per L-Share — **not in spec (new)**

**Spec says** (§4): "The cost to mint 1 L-Share is governed by a worldwide
shareRate … goes up forever with 7% per annum." It never states the starting
value.

**Now:** **`GenesisShareRate` = 1.00000000 LASSECASH per whole L-Share** at
migration. Full years compound at 7%; the fraction of the current year is
interpolated linearly, so there is no anniversary cliff a minter could game by
waiting a day. Over 75 years this compounds to roughly **164x**, so a late
minter receives about 1/164th the shares per LASSECASH that a genesis minter
did — the intended early-adopter reward, announced in advance.

**Status:** built and tested. The 7%/yr ratchet itself is **unchanged** from the
spec and is immutable.

---

## Governance & immutability

### 22. Median governance — no proposals, standing preferences, lower median on even parity

**Spec says** (§4): "Top-10 Minter Consensus: The 10 accounts holding the highest
number of active L-Shares automatically form the consensus group responsible for
governing dynamic protocol parameters." The spec does not say how they decide.

**Now:**
- **There are no proposals**, and no inflation slice for proposals or onboarding.
- Each of the top 10 keeps a **standing preferred value** for each parameter,
  changeable at any time. The **median** of those ten preferences is the value in
  force, **continuously**. No quorum, no voting round, no tallying job, nothing
  to time or snipe.
- **Even parity uses the LOWER median** — exact integer arithmetic, no rounding,
  so every node computes the same value.

Worked example (a hypothetical dApp fee): members prefer 0.1, 0.2, 0.4, 0.5, 0.2, 0.3,
0.8, 0.9, 0.6, 0.7 → sorted 0.1 0.2 0.2 0.3 0.4 | 0.5 … → **0.4% in force**.

**Decided:** 2026-08-20. Lasse designed proposals early and discarded them: you
cannot verify on-chain that a funded proposal was ever delivered, and an
immutable protocol should not pretend otherwise. Median rather than mean or
majority because **extreme votes are self-neutralising** — a member voting
10,000% moves the outcome no further than one voting a notch above the median,
whereas an average would let a single absurd vote drag the result.

**What the median does NOT defend against** is one entity holding several of the
ten seats. Accepted deliberately; the hardcoded bounds (item 23) are what limit
the damage — a test asserts that even 6-of-10 seats captured cannot push a value
outside its bounds. The About page should describe the top 10 as a **tweaking
committee**, not a check on the founder.

**Also removed:** the **20% weight cap** from earlier drafts no longer applies.
Under median governance each seat contributes exactly one number; L-Shares buy
you a seat, not extra influence within it, so there is no weight to cap.

**Status:** built and tested.

---

### 23. What is governable is a closed, bounded list — everything else is hardcoded

**Spec says** (§4/§5): "governing dynamic protocol parameters" and "The top 10
L-share holders decide these specific posting thresholds for both viral and deep
content", without listing what else is in scope.

**Now — this is the load-bearing table and the spec should carry it verbatim:**

| IMMUTABLE (hardcoded, no governance path) | GOVERNABLE (bounded registry) |
|---|---|
| 51M historic hardcap | Bigger-Pays-Better start amount (default 10,000 LC; bounds 100 – 50,000) |
| 20M emission cap + halving curve | Bigger-Pays-Better end amount (default 100,000 LC; bounds 1,000 – 5,000,000) |
| 1.5x Longer-Pays-Better ceiling | Viral posting threshold (default 1,000 L-Shares; bounds 0 – 100,000) |
| 1.5x Bigger-Pays-Better ceiling | Deep posting threshold (default 10,000 L-Shares; bounds 0 – 100,000) |
| 0% swap fee on LASSECASH:HBD | *(closed — nothing else)* |
| +1%/day LP loyalty bonus, 90-day cap | |
| 3-year maximum mint duration | |
| 7%/yr share-rate ratchet | |
| 50/25/25 block split | |
| 75/25 author/curator split | |
| Early-end curve, grace, bleed periods | |

Three rules attached to it:
- **Every governable parameter carries hardcoded min/max bounds.** The top 10 can
  move a value inside its bounds and can never leave them. The bounds are
  hardcoded *because* they must be un-negotiable — a bounds table that was itself
  governable would be no bounds at all, since the top 10 would widen the bound
  first and move the value second.
- **The governable column is CLOSED.** The registry is not a general extension
  point: a registry row is only meaningful if deployed code reads that key, and
  after the key burn the code is frozen. Writing a new key into core state would
  change nothing anywhere.
- **Parameter changes affect FUTURE mints only.** Shares are computed once, at
  creation, and frozen. Governance can never retroactively dilute an existing
  minter.

**Decided:** 2026-08-20; the "registry is not an extension point" correction and
the posting-threshold defaults on 2026-08-21 (defaults are Lasse's call).

⚠️ **Open thinking task, deliberately deferred to Lasse:** static share-count
bounds may age badly as the LASSECASH price moves, so he wants to explore
posting-threshold bounds that are **dynamic against the HBD price** rather than
handing the top 10 a wide static range. Nothing is designed yet, and it should
not be invented without him — a price oracle inside a frozen contract is a hard
problem (who feeds it, and what stops the top 10 gaming the feed). Revisit before
the bounds are frozen for the real deploy.

**Status:** built and tested.

---

### 24. The keys are burned at launch — the core contract is permanently immutable

**Spec says** — nothing. **Not in spec (new), and it is the most consequential
decision in the project.**

**Now:** after the core contract is deployed and the migration executed, the
owner account's keys are **destroyed**. MAGI resolves a contract update against
the owner's active authority; with no key in existence, no update can ever be
queued for this contract. Not "we promise not to" — *nobody can*.

| Wish | After the burn |
|---|---|
| Fix a bug in the core contract | **Impossible.** Only a chain-level hardfork. |
| Add a parameter the code doesn't already read | **Impossible.** |
| Add an entrypoint | **Impossible.** |
| Change a bound | **Impossible.** |
| Move a governable value inside its bounds | Fine — median governance still runs. |

**Decided:** 2026-08-21, in Lasse's words: *"No, it's necessary to claim it's
real blockchain immutable, no admin keys. If I want to change anything in the
future it's a real hardfork. I think I will burn the keys at launch and say it's
100% immutable — that's more earnest than having 100% admin keys for 12 months.
That's disingenuous."*

There is no staged rollout and no "12 months of admin keys just in case" — that
was explicitly rejected as dishonest. **The pre-launch test deploys are therefore
the entire safety margin.**

**Status:** decided; the burn itself happens at launch. (Three test deploys have
already been made, and the second one found a bug that would have bricked the
contract permanently had the keys already been burned.)

---

### 25. Future dApps are separate contracts that READ core state — **not in spec (new)**

**Now:** a future dApp of any kind does **not** extend
the core. It is **its own contract with its own owner and its own bounded
registry**, and it *reads* core state to derive the same governing top 10:

```
   dApp contract  ──ContractStateGet──►  core contract state
   (own owner,                            (frozen, read-only to everyone)
    own fee row,
    own bounds)     reads: L-Share balances → derives the top 10
```

The dApp keeps its owner key, so it can iterate forever behind timelocks and
announcements. The core never moves.

**One refinement to how Lasse phrased it** (*"we build the top 10 consensus into
the new dApp frontends"*): it must live in the dApp's **contract**, not its
frontend. A frontend enforces nothing — anyone can call a contract directly with
their own client. The frontend may *display* the top 10; only the contract may
*obey* it.

**Standard dApp fee band: 0.1%–1%** (versus Uber's 20–30%). This is a **norm for
dApp authors to follow**, not something the core contract can enforce.

**Consequence, already handled:** the core must expose L-Share balances in a
layout a foreign contract can read and that we are willing to freeze forever.
That layout is now **frozen public API**: `gov_board` (up to 20 candidate
accounts, pipe-separated), `shr_<acct>` (held L-Shares, 8dp), `bal_<acct>`
(liquid balance, 8dp), where `<acct>` is fully qualified — `hive:alice`, never
bare `alice`.

**Decided:** 2026-08-21.

**Status:** built and tested; pinned by `public_abi_test.go`, which reproduces
the consensus group using nothing but raw key reads.

---

## Pool

### 26. The pair is LASSECASH:HBD — the spec names two different pairs and both are wrong

**Spec says** — in **§3**: "25.0% — Pool Rewards: Automated yield for DEX
liquidity providers supporting the main trading pair **LASSECASH:BTC**."
And in **§6**: "the main liquidity pool is created: **LASSECASH:HIVE**."

**Now:** **LASSECASH:HBD**, in both places. Magi routes **every** pool through
HBD as the single base asset (BTC → HBD → ETH); there is no LASSECASH:HIVE or
LASSECASH:BTC option. The migration pool and the 25% liquidity reward pool are
the same LASSECASH:HBD pool.

**Decided:** 2026-08-20, confirmed by TibFox and verified against the node.

**Status:** built and tested.

---

### 27. We build the AMM ourselves; the contract custodies real HBD — **not in spec (new)**

**Spec says** (§6): "The pool functions similarly to Diesel pools on Hive
Engine."

**Now:** true, and worth saying why it had to be built rather than used. The
MAGI contract SDK exposes **no** pool, swap or liquidity primitives, and Magi's
native pools pair *mapped* assets (BTC/ETH/SOL) against HBD — LASSECASH is a
contract-managed token and cannot enter one. But `hbd` **is** a first-class SDK
asset, so the contract custodies **real HBD** on one side and its own LASSECASH
ledger on the other.

- **Constant product** (x·y=k), the same shape as Diesel pools.
- Every swap **floors in the pool's favour**, so `k` can only ever grow.

**Opening price** — a method, not a fixed number, and it must be **re-measured
at launch**. Measured 2026-08-20: LASSECASH last traded at 0.02500000 SWAP.HIVE
with HIVE at $0.04120439, implying ≈ $0.00103, i.e. **≈ 0.00103 HBD per
LASSECASH** — about 1,030 HBD alongside 1,000,000 LASSECASH. The first
`add_liquidity` call sets the price, so it should be Lasse's, at a deliberate
ratio.

**Status:** built and tested; the contract's real HBD custody is asserted
against its own bookkeeping on every pool test.

---

### 28. Swap fee is ZERO, hardcoded, with no governance path

**Spec says** (§6): "There are only the swapping fees on MAGI layer and
transactions rely on Magi Resource Credits and Hive Resource Credits."

**Now:** **the LASSECASH:HBD pool takes a 0% swap fee.** There is no fee
parameter and no governance path to a non-zero one. And the surrounding sentence
needs correcting too: **MAGI has no fees at all** — RC is the entire cost of
everything, and gas is metering charged against RC, not a currency. The spec's
"only the swapping fees on MAGI layer" should become "there are no fees on
either layer; transactions cost only Magi and Hive Resource Credits".

**Decided:** 2026-08-20, Lasse's call. The reasoning, worth keeping:
- LPs are paid from the **25% inflation slice**, which grows with the product's
  success. Trading-fee income would be noise beside it — Hive-Engine Diesel pools
  are the worked example of fee income never being meaningful.
- **Arbitrage keeps the price honest for free.** Bots realign the pool against
  any external venue because the spread is the profit; they need no fee rebate.
  A fee would only widen the no-arb band — i.e. give LASSECASH holders *worse*
  prices.
- **A lever that exists eventually gets pulled.** Deleting it makes "0% swap fee"
  a promise the code enforces rather than a default a future top-10 could quietly
  walk back.

**Status:** built and tested, by two tests: the engine's swap output must equal
the bare constant-product formula to the base unit, and a contract test fails if
any fee key is ever re-registered.

---

### 29. Loyalty bonus: +1%/day, linear, capped at 90 days = 1.90x — **spec already correct, add the mechanics**

**Spec says** (§6): "There is a bonus of 1% per day in the pool, up to a maximum
of 90 days. Each time a person provides liquidity, a new tranche is created —
meaning different tranches can have different maturity lengths."

**Now:** confirmed exactly — **linear, not compounding**: day 1 → +1%, day 10 →
+10%, day 30 → +30%, day 90 → **+90% (1.90x)**, and flat thereafter. Two
mechanics to add:
- **Tranches are exited individually by id**, exactly like mints. Nothing is
  consumed oldest-first behind the user's back, so a partial exit can never
  silently destroy their most-matured loyalty position.
- **Claiming rewards re-registers the tranche**: it removes the tranche's weight
  and its slice of the pool together, then re-adds the weight at the tranche's
  current age. This conserves exactly; an untouched tranche under-earns rather
  than over-earns.

(Note for consistency: the **old About page** says "1% per day up to 30 days,
capping at 30% extra". That is the same rule with a shorter cap and is
superseded — the spec's 90 days is the live figure.)

**Decided:** confirmed by Lasse 2026-08-20.

**Status:** built and tested.

---

## Proof-of-Brain / LasseMedia

### 30. PoB payouts do NOT create mints directly — they accumulate into ONE monthly mint on the 1st

**Spec says** — nothing; §5 implies rewards simply arrive. **Not in spec (new),
and it is a required change, not a preference.**

**Now:**

```
block reward
  └─ 50% Proof-of-Brain
       ├─ 25% VIRAL  (7-day payout,  7-day vote regen)
       └─ 75% DEEP  (30-day payout, 30-day vote regen)
            each: 75% author / 25% curators
                 └─ 20% liquid immediately
                    80% → pending balance → ONE mint on the 1st
```

Rules:
- Pending is **one integer per account**, not a row per payout.
- On the 1st of each calendar month the whole pending balance becomes **one**
  mint, at the duration from the user's settings (sliding scale 1–1,095 days,
  default 3 years).
- Balances under **1.00000000 LASSECASH roll over** rather than minting dust.
- **Pending carries NO voting power.** L-Shares are voting power; pending is not
  yet L-Shares.
- **Curation is treated identically to author rewards** — same pending balance,
  same monthly mint.
- An account's **first ever** earnings anchor that month and mint the next, so
  nobody mints a partial first month.
- Claim Mint stays **manual**. The bleed is the teacher.

**Why:** protocol-generated payouts need no user transaction, so they have no
natural rate limit. One real lassecash.com post carried **201 votes** = 201
curation payouts. At ~20 posts/day that is ~1.5M mint records per year in
contract state — chain death. Manual capital minting has no such problem (every
mint costs a signed transaction plus RC on both chains) and stays immediate and
direct: steady state ~11,000 mints/year, ~33,000 open, which is fine.

**Known and accepted:** Bigger Pays Better gives post rewards a 1.0x volume
multiplier unless a month's earnings are large. Capital commitment *should* pay
better, and the bonus range is small enough not to matter.

**Decided:** 2026-08-20.

**Status:** built and tested, including that a PoB mint earns **identically** to
a capital mint of the same amount, moment and duration.

---

### 31. Author payout modes: default 20/80, power up, or burn — **not in spec (new)**

**Now:** the author chooses at publication, and the choice is frozen with the
post:

| Mode | Effect |
|---|---|
| `0` default | **20% liquid now, 80% into the monthly mint** |
| `1` power up | **100% into the monthly mint** |
| `2` burn | **credited to `hive:null`** — visibly burned, never destroyed |

Two rules inside this:
- **It applies to the AUTHOR's reward only.** Curators always take the standard
  split — one person's choice must never dictate how someone else is paid.
- Burns go to `hive:null` (item 6), so declined rewards can never silently
  inflate what is claimable and the supply audit cannot drift.

**Decided:** 2026-08-20 (modes), burn destination revised 2026-08-21.

**Status:** built and tested; the 20/80 split and the 75/25 author/curator split
were both verified **exact to the base unit** on a real on-chain payout.

---

### 32. Curation is paid AUTOMATICALLY — a curator who never opens the site is still paid

**Spec says** (§5): "25.0% of post rewards go to curators, while 75.0% go to
authors" — with no claiming mechanics. **Not in spec (new).**

**Now:** nobody has to claim anything.

The split-claim design exists for **one** reason: paying 201 curators inside the
payout transaction is unbounded iteration — whoever settled a popular post would
pay for every curator in RC, and past a few thousand votes the post would exceed
the gas limit and become **permanently unpayable**. So `payout` pays the author
and **parks** the curator pot on the post record with a snapshot of total vote
weight; each curator's share is one O(1) sum, `pot × myWeight / totalWeight`,
with both figures decremented together so the pot can never be overdrawn.

That was a gas necessity leaking into UX, and two changes fixed it:
1. **`claim_curation` is PERMISSIONLESS.** The reward always goes to the named
   curator, never to the caller.
2. **The chain remembers what you are owed.** Every account's first vote on a
   post appends to a per-account queue, which is drained before the balance is
   read — so curation claimed this month lands in this month's mint.

Who calls it, in order of how much it matters:
1. **Piggyback on the voter's own transaction** (3 entries per vote). They are
   already sending a transaction and paying RC, so it costs almost nothing, and
   an active curator never builds a backlog at all. Kept small deliberately:
   voting must stay cheap.
2. **When the calendar month turns** — which is exactly when there is something
   to settle, because that is when the monthly mint fires. Fire-and-forget;
   housekeeping the user did not ask for must never raise an error dialog. (The
   trigger is the month, not sign-in: Hive users stay signed in for months —
   Lasse: *"I am logged in on hive sites like LasseCash forever"*.)
3. **Anyone, for anyone.** A script can settle for dormant accounts — but the
   **caller pays the RC**, so this is a real cost someone must choose to bear.

Bounded at **20 entries per call** so the gas problem cannot return through the
fix for it. Background settling is also guarded: it stops while a comfortable
majority of the user's RC meter is intact and says "paused, nothing is lost",
because spending a user's RC on background work could leave them unable to post
or transfer with no idea why.

**Decided:** 2026-08-20.

**Status:** built and tested (`TestCuratorNeverClaimsAndIsStillPaid`; re-voting
queues once not twice; a manual claim followed by a drain pays once; a stranger
settling for you cannot collect your reward). Verified on-chain: the pot drained
to exactly zero and was fully conserved.

---

### 33. Unclaimed curation expires after ONE YEAR, measured from the actual payout

**Spec says** — nothing. **Not in spec (new).**

**Now:** unclaimed curation returns to the L-Share reward pool **one year** after
a post pays out. `sweep_curation` is **permissionless** and **pays the caller
nothing** — a bounty would create an incentive to lobby for a shorter expiry, and
this must only ever touch genuinely abandoned rewards.

**The clock runs from the ACTUAL payout, not from when the window closed.**
Payout is permissionless and can happen late; measuring from the window close
would rob curators of however long settlement was delayed.

A year is deliberately generous: three layers already keep an active curator's
queue near empty, so reaching expiry means twelve months of total silence.

**No bleed on curation, deliberately.** The mint bleed enforces a promise the
minter made and was paid up to 1.5x for making. Curation is wages already
earned; confiscating it for inaction would punish something that costs the
protocol nothing.

**Decided:** 2026-08-20.

**Status:** built and tested.

---

### 34. Content lives on Hive; the contract tracks only the money — **not in spec (new)**

**Now:** the contract stores only `author + permlink + window + payoutMode +
rshares` — no title, no body — keyed exactly like the old Hive tribe. Publishing
is genuinely two steps and the order matters: **write the article first, then
register it** with the contract to open the payout window. If registration fails
you have an unregistered article, which is recoverable; the reverse would open a
payout window over content that does not exist.

Images use **Hive's own image server** (`images.hive.blog`), signed with the
POSTING key — every existing Hive post depends on that infrastructure staying up,
so it is maintained far beyond what we could justify hosting ourselves.

**Status:** built. Image-upload signing is the one piece still awaiting
confirmation against a real Keychain/PeakVault wallet.

---

### 35. Posting thresholds: defaults 1,000 (viral) and 10,000 (deep) L-Shares

**Spec says** (§5): "Accounts need a minimum amount of L-shares to unlock the
ability to post. Top-10 Consensus Control: The top 10 L-share holders decide
these specific posting thresholds for both viral and deep content."

**Now:** unchanged in shape, with the numbers filled in — **1,000 L-Shares to
post viral, 10,000 for deep**, and the top 10 tune from there inside the
hardcoded bounds in item 23 (0 – 100,000 L-Shares each).

**Decided:** 2026-08-21, Lasse's call. See the deferred open question in item 23
about making the *bounds* dynamic against the HBD price.

**Status:** built and tested.

---

## Wording corrections

### 36. "Undistributed", not "unissued"

**Spec says** (§1): "The remaining undistributed reserve sitting in @lassecash
(the remainder of the 20M inflation for the first 10 years)". This is correct —
but the same idea is described elsewhere in project material as *unissued*, and
that is wrong.

**Now:** the 20M **was** fully issued (Hive-Engine reports `supply` =
31,000,000.00000000 against `maxSupply` = 51,000,000.00000000, fully issued as
11M founder + 20M inflation). What was never **paid out** is what is credited to
`hive:null`. **Always say "undistributed".**

Related, and worth a sentence in the spec since it reads like a contradiction
otherwise: the original model budgeted 20M of inflation for the **first 10
years** from the 2019 launch, and migrating in 2026 means only ~7 years of it
were actually distributed. That is why @lassecash holds **7,431,834.35 LC** at
snapshot.

---

### 37. "Per height", not "per block"

**Spec says** (§2 heading and §3 heading): "issued per block ($1\text{ block} =
3\text{ seconds}$)", "Approx. Per-Block Reward", "The Per-Block Allocation
Breakdown", "Every block reward is distributed evenly…".

**Now:** the 3-second unit is a **height** (a Hive block); a **MAGI block** is
every 10th height, 30 seconds. Rewrite the emission column as "LC per height"
and add a "LC per MAGI block" column (item 17). §3's "Per-Block Allocation" is
fine conceptually — the 50/25/25 split applies to every reward — but call it
"per-height allocation" or "allocation of every block reward" so it cannot be
read against the wrong clock.

**Do not change** `31,536,000` or "50% halving every 3 years": both are correct
when the unit is read as heights.

---

### 38. `@null` → `hive:null`

**Spec says** (§1): balances "permanently directed to @null", "by being moved to
@null at migration".

**Now:** the destination is the MAGI address **`hive:null`**, and the operation
is a **credit** on the new chain, not a transfer on Hive. Nothing is destroyed —
see item 6. Also correct the scope: it is not only "official protocol sink and
burn addresses"; it is **everything that does not migrate**, protocol accounts
and non-qualifying holders alike, liquid balances and staked power together, in
one aggregate liquid credit.

---

### 39. §1's "both of the following qualifying criterias"

With criteria (b) deleted (item 2) there is only one criterion. Rewrite the
sentence, and fix the two typos while you are in there: "fullfill" → "fulfil",
"criterias" → "criteria".

---

### 40. §4's "Good Accounting Mode on individual minters"

Should read **"on individual mints"** — a minter is a person, a mint is a
position. Same paragraph carries the substantive change in item 12.

---

### 41. §4's heading "xReward Distribution & End-of-Mint Payouts"

Stray `x`. Should be "Reward Distribution & End-of-Mint Payouts".

---

### 42. §4's "Immutable Staking Units" bullet

"L-Shares determine your voting power in the proof of brain for the reward pool
and serve as your Voting Power for decentralized protocol governance" — keep,
but append the maturity rule from item 13: **both kinds of voting power end at
maturity.** Without that sentence the spec reads as though a matured, unclaimed
mint still votes, which it does not.

---

### 43. §6's "There are only the swapping fees on MAGI layer"

See item 28. There are **no fees on either layer**; RC is the entire cost. Our
pool's own swap fee is **0%**, hardcoded.

---

### 44. §4's "Yield Source: Funded by the 25% from the inflation emission pool"

Correct, and worth extending by one clause: the L-Share pool is funded by the
25% emission slice **plus all recycled value** — early-end slashes, the bleed,
day-120 liquidations, swept dead positions and expired curation. That recycling
is what lets the pool keep paying after emission ends in year 75 (item 20).

---

## Still correct — do NOT touch these

Everything below survives the rewrite unchanged. Several were re-verified against
the live chain or pinned by tests, so changing them would break code.

| Spec statement | Section | Status |
|---|---|---|
| **51,000,000 LC historic hardcap**, absolute, covering everything ever issued | §1 | Verified against Hive-Engine (`maxSupply`). Enforced in code. |
| **20,000,000 LC post-migration emission cap**, forever, asymptotic | §1, §2 | Unchanged. Verified: 31M issued + 20M = exactly 51M. |
| **50% halving every 3 years**, era = 31,536,000 heights = 1,095 days | §2 | Correct when read as *heights*. Reduction rate deliberately kept at −50%. |
| Era budgets **10M / 5M / 2.5M / 1.25M** | §2 | Exact. |
| **50% / 25% / 25%** — Proof-of-Brain / L-Share yield / Pool rewards | §3 | Unchanged and immutable. |
| **75% author / 25% curator** split of post rewards | §5 | Unchanged and immutable. Verified exact on-chain. |
| **Viral: 7-day payout, 7-day vote regen, 25% of the PoB pool** | §5 | Unchanged. |
| **Deep: 30-day payout, 30-day vote regen, 75% of the PoB pool** | §5 | Unchanged. |
| **A full vote costs 10% of an account's vote power** | §5 | Unchanged. |
| **Linear reward curve, parameter 1.0**, for both post and curation rewards | §5 | Unchanged. |
| **1.5x Longer Pays Better** at 1,095 days; 1.0x at 1 day; linear between | §4 | Unchanged, hardcoded, immutable. Composes to **2.25x** max (item 15). |
| **1.5x Bigger Pays Better** at the top amount; 1.0x at the bottom; linear between | §4 | Ceiling hardcoded; only the *amounts* are governable. |
| Bigger-Pays-Better defaults **10,000 → 100,000 LASSECASH** | §4 | Unchanged as defaults. |
| **3-year (1,095-day) maximum mint duration**; 1-day minimum | §4 | Unchanged and immutable. |
| **7% per annum upward-only share-rate ratchet**, never decreases | §4 | Unchanged and immutable. |
| **8-decimal precision** (`1 LC = 100,000,000` base units) | implied | Confirmed against Hive-Engine (`precision` = 8). |
| **Top-10 L-Share holders form the consensus group** | §4 | Unchanged — *how* they decide is item 22. |
| **1:1 liquid balance migration** for qualifying accounts | §1 | Unchanged. |
| **Staked power → Migration L-Shares 1:1** | §1 | Unchanged — only the *lock length* changed (item 5). |
| **30-day grace / 90-day bleed / day-120 liquidation** | §4 | Unchanged. |
| **100% of penalties sweep instantly into the reward pool** | §4 | Unchanged (now routed through the accumulator). |
| **Rewards paid at end of mint via Claim Mint**, manual | §4 | Unchanged. |
| **Pool rewards come from the 25% inflation slice** | §6 | Unchanged. |
| **1% per day liquidity bonus, 90-day maximum**; one tranche per deposit | §6 | Unchanged and immutable (item 29 adds the mechanics). |
| **Pool functions similarly to Hive-Engine Diesel pools** (constant product) | §6 | Unchanged. |
| **We build our own frontend swap page** rather than relying on third parties | §6 | Unchanged — built, four pages live. |
| **Transactions rely on Magi RC and Hive RC** | §6 | Unchanged and now verified: RC is the *entire* cost. |
| The golden rule — **one Go engine everywhere**, the chain is the only source of truth | preamble | Unchanged and enforced by a test that runs identical inputs through the browser WASM and the chain and requires byte-identical output. |

---

## Added 2026-08-21 (evening) — the migration is CLAIM-based

### 45. Holders claim their own migration with a Merkle proof; the owner commits one root

**Spec says** (§1, *Migration*): the migration is executed by crediting every
qualifying account (implicitly a push by the issuer).

**Now:** the owner commits ONE Merkle root of the whole snapshot at genesis
(`set_snapshot`); every holder claims their own leaf (`claim_migration`) with a
short proof, paying their own free RC. The full tree — every account, qualifying
and burned, with liquid and staked figures — is published in the GitHub repo and
its root in a Hive post, so who held what is provable forever. Burned leaves
cannot be claimed; anyone may record their receipt on-chain (`record_burn`).
The burn total is credited to `hive:null` at genesis.

**The claim is the mint, on a shared clock from genesis:** claim before day 30 →
liquid + a 30-day migration mint (earns and votes from the claim onward); day
30–60 → liquid + the full minted amount as liquid; day 60–150 → the surviving
fraction, the bled part to the L-Share pool; after day 150 → closed, and
`sweep_unclaimed` recycles everything unclaimed (stake AND liquid) into the
L-Share reward pool. Identical economics to the push model; nobody earns or
votes before claiming.

**Decided:** 2026-08-21. The push model needs ~8.8M RC (thousands of HBD parked
on MAGI for weeks); Lasse: *"I dont even have this kind of money right now"*.
On the record: *"The tree itself is the record. THAT IS SO GOOD."* Pool over
null for the unclaimed remainder: *"pool for consistency, I take that."*

**Status:** built and tested (contract, tree tool, Claim panel, simulator);
gas being measured on the devnet. Production contract: 26 entrypoints, no push
path (`migrate`/`migrate_batch`/`burn_batch` remain only behind `-tags push`).

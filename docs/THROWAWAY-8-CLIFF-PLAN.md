# Throwaway #8 — the two remaining confidence tests, live on mainnet

Prepared 2026-08-25 evening. Nothing below has run yet; the meters were frozen.

## What is being proven

1. **`UserRetireBudget = 25` live** (commit 3940bf4, never deployed). When a
   day with ≥ 26 same-day maturities is crossed, an ORDINARY transaction
   retires exactly one chunk (25 entries) and stops with the cursor stored;
   a dedicated `advance` retires two chunks (50).
2. **The board regression** (`TestNewcomerCanSeatAfterMassUnclaimedMaturity`):
   19 dead seats zeroed by the walk (not by `offer()`), one live small seat in
   the tail, then a newcomer above every dead entry but below the survivor
   must be seated automatically, and `promote` must also work.

Both come from the same cliff, so one scenario serves both.

## Blockers found 2026-08-25 (state at 19:30 UTC)

| what | value | consequence |
|---|---|---|
| @lassecashmagi HBD on **Hive L1** | **1.800** | deploy needs 10 — short **8.2 HBD** |
| @lassecashmagi RC on MAGI | 0 of 60,790 available (frozen since 18:52) | thaws ~12,160/day → ~25k by Aug 27 20:00, full Aug 30 19:00 |
| 20 test accounts RC | ~50 of 10,000 each (frozen since ~18:37) | thaw 2,000/day → 3,000 by Aug 27 05:00, 6,000 by Aug 28 19:00 |
| @lasseehlers | 0 HBD L1; 40.8 HBD on MAGI, 19,425 RC | the only account with HBD to withdraw — Lasse's key |

RC formula, from the node (`modules/rc-system`): `available = HBD_milli +
10,000 − frozen`; frozen is ABSOLUTE and restarts its whole 5-day clock on
every new call; a call refused for RC still freezes its declared limit (the
15,000 `sweep_mint` on #7 at 18:52 failed with "RCs available: 0" and froze
anyway). **Parking 1 HBD on MAGI = +1,000 RC immediately, no waiting.**

Measured on #7 by simulation (`cliff.js sim`): transfer 290 RC, promote 432,
advance no-op 1,397, mint **6,105** (a 238-day-old contract; re-measure on
the fresh one — expected much lower).

## Money needed from Lasse

- **8.2 HBD to @lassecashmagi on Hive L1** (deploy fee; the 1.8 there counts).
  Route: `vsc.withdraw` 10 HBD from @lasseehlers' MAGI balance → L1, then a
  plain L1 transfer to @lassecashmagi. Costs @lasseehlers' MAGI RC once.
- Optional, to start before the thaw: ~30 HBD parked on @lassecashmagi's
  MAGI balance (= +30k RC). Otherwise wait until ~Aug 27 evening, which the
  test accounts need anyway.

## Roles (21 accounts, all keys on disk except @lasseehlers)

| role | accounts | mint |
|---|---|---|
| 19 cliff seats | lcgov01, lcthresh01–12, acash, angelocash, ivoteonheroes, lassecashwitness, lassemusic, nftlassecash | 10,000 LC × 1 day each |
| survivor (tail seat) | ancaptest | 1,500 LC × 1095 days |
| extra cliff entries (to pass 25) | @lassecashmagi | 7 × 1,000 LC × 1 day → 26 same-day entries |
| newcomer | @lasseehlers via the site (or ancaptest #2 if he prefers) | 500 LC × 30 days |
| promote check | any account: `promote hive:<newcomer2>` | — |

Seeding: the throwaway is a `-tags "testwindows push"` build
(`contract/artifacts/main-testwindows-push.wasm`, 100,151 bytes) so the owner
credits all 21 accounts with ONE `migrate_batch` (liquid-only, ~45M gas per
account ≈ 9,500 RC) instead of 21 transfers + a claim.

## Sequence (every step: sim → RC check → broadcast → `tx` verdict → `state`)

```
export CONTRACT=<new id>
# 0. deploy   WASM=contract/artifacts/main-testwindows-push.wasm ./deploy.sh deploy
# 1. init at the current height (day 0 starts now)
node tools/chain-test/cliff.js call lassecashmagi init <height>
node tools/chain-test/cliff.js state cfg_init cfg_genesis
# 2. seed: one migrate_batch (owner). Balances readable before anything else.
node tools/chain-test/cliff.js call lassecashmagi migrate_batch 'hive:lcgov01,1000000000000,0|…'
# 3. just after a day boundary (genesis + k*120), all mints inside ONE 6-minute day:
#    19 × mint 1000000000000|1, ancaptest mint 150000000000|1095, magi 7 × mint 100000000000|1
#    verify: gov_board has 20 entries; explc_<day+1> = 2 (26 entries → 2 chunks)
# 4. wait for day+1 to pass (6 min), send ONE ordinary tx from magi (transfer 1 LC):
#    expect explp_<day+1> = 1, explc_<day+1> = 2, 25 shr_ zeroed, 1 left, acc_day = day (stuck)
# 5. second ordinary tx: expect the list drained, acc_day advanced.
#    (variant to pin the 50: rebuild the cliff and send `advance` instead — one call drains both)
# 6. newcomer mints 50000000000|30 → gov_board must contain them; then
#    promote hive:<newcomer2> from any account → seated.
```

The maturity day is `DayOf(created + days*120)`, so every creation must land
in the same 6-minute day or the entries split across days. Broadcast the
mints in parallel from a script right after a boundary; check `explc_` counts
before relying on them.

## RUN 1 — 2026-08-26 18:10–19:10 UTC+2: deployed, seeded, cliff crossed; 25-boundary NOT reached

Contract **`vsc1BVAmFAEyzxxcC7Tko9h7LRqZFW7SYX6dMc`**, deploy tx `71dd19c8…`,
`init` at genesis **109368102** (day = 120 heights). Seed: ONE `migrate_batch`
of 21 liquid-only accounts, `migrated 21 of 21`, CONFIRMED — **31,324 RC
simulated (not the 9,500 guessed)**; cliff.js froze 39,200 of @lassecashmagi's
meter for it.

### What was proven live
- The accrual walk crossing a maturity day **drains the day's expiry list and
  zeroes `shr_` for every same-day mint** (eight accounts → 0, list key gone),
  while the one 1095-day position (@ancaptest, 2,261.47447905 shares) is
  untouched. Board entries stay listed (shares are re-read live) — the exact
  "dead seats" shape. A single `advance` (1,925 RC) crossed two days at once.
- 2-day mints created on day 1 and 1-day mints created on day 2 land on the
  SAME expiry list (`explc_3`) — the multi-day trick works, so a 26-entry day
  never has to be crammed into one 6-minute window.

### What blocked the 25-chunk and board-regression checks
**Same-block mints exceed their own simulation.** 23 mints were broadcast in
parallel; each one simulated at 2,700–5,600 RC against the PRE-block state,
but every mint that lands in a MAGI block makes the next one in that block
dearer (board rewrite + expiry-chunk append). In every block the first ~4
succeeded and the rest failed `gas_limit_hit / cost limit exceeded` — **and a
failed call still freezes its full rc_limit** (5,000 each). Net: 14 of 26
entries on day 3, board 9 of 20, and all 20 test accounts + @lassecashmagi at
~0 RC (@lassecashmagi cap 127,733, frozen ≈ all of it).

Launch relevance: the site's dry-run limit (max(table, 3× simulated), cap
30k) already covers this; `cliff.js`'s 1.25× and hand-set limits do not.
**Rule for scripted mints: sequential, wait for the MAGI block, limit ≥ 1.5×
sim.** Consider raising the site's floor for `mint` on the migration day.

### Cliff 2 — what it costs to finish (decision for Lasse)
26 sequential mints (19 seats + 7 second mints; 3/2/1-day durations over
three days so all mature together) ≈ 26 × 5,400 RC, plus 7 `claim_mint`
(zero-liquid seats must recover principal first) ≈ 12k → **≈ 155k RC**.
Thaw supplies ~40k over the next day; the rest is **≈ 115 HBD parked on the
test accounts** (vsc.transfer from @lassecashmagi's 127.7 HBD on MAGI, sent
back afterwards — parking is reversible the same day; only RC freezes on the
test accounts are not). Newcomer = @lassecashmagi (500 LC × 30d) once its
meter thaws, or @lasseehlers via the site; `promote` check = the other one.
Alternative: accept the devnet measurement of the 25-budget
(docs/DEVNET-MATURITY-DAY.md) — the drain path it sits on is now proven live.

Tooling: `cliff.js` gained `transfer <from> <to> <amount>` (vsc.transfer) and
loads dhive from `tools/chain-test/node_modules` (was `/tmp`, wiped).

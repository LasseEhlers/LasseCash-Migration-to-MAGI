# The three untested sweeps — a plan, and the clock that makes it possible

**Status 2026-09-30 15:20 CPH: DEPLOYED, NOT YET INITIALISED.**
Throwaway #13 is `vsc1BUBuo8NmjoJB3VsxraE34VRuCMmv5DbW5r`, owner
`hive:lassecashmagi`, code `bafkreiblin7y3lygiruqipbfspfwumppici2r5u6dxdc6qobpksqbwouye`
(the fastwindows build), deploy tx `37fad761a5f61940378f20b688fffc48ec3fe7cc`,
10 HBD paid. **The clock only starts at `init`**, so it can sit untouched
indefinitely — Lasse's machine needed a reboot before the 2.5-hour run.
Resume by initialising at the then-current head and following step 2 below;
@lassecashmagi had 32,800 RC and 23 HBD on MAGI, which covers the whole run.

**Deadline ~6 Oct 2026** (a fix would need a 48-hour timelock before the key burn on the 10th).

## What is untested, and why it matters

`sweep_mint`, `sweep_tranche` and `sweep_curation` are the three permissionless
sweeps. Each pays the caller nothing, each refuses unless the position is
already dead, and together they are the recycling engine that funds the reward
pool after emission ends. **None has ever been broadcast on any chain** — they
exist in Go tests only.

They also cannot run on production before the keys are gone: the earliest is a
fully-bled mint around late March 2027, and expired curation in September 2027.
So a defect in them surfaces years after the last person who could repair it.

## Why the 240x build could not test them

| sweep | window it needs | at 240x | at 3600x |
|---|---|---|---|
| `sweep_mint` | 1-day mint + 90 grace + 90 bleed | 18 h | **72 min** |
| `sweep_tranche` | 180 dormant days | 18 h | **72 min** |
| `sweep_curation` | 7-day window + 365 days | 37 h | **2.5 h** |

Throwaway #11 proved what an 18-hour soak does: the accrual backlog grows a
simulated year every few real hours and the catch-up walk outruns what its RC
can pay. The test was abandoned, not failed.

## The clock — `./build.sh wasm-fast`

`engine/time_fastwindows.go`, build tag `fastwindows`, **a day is 8 heights =
24 seconds**. Artifact `contract/artifacts/main-fastwindows.wasm`, 105,101
bytes, CID `bafkreiblin7y3lygiruqipbfspfwumppici2r5u6dxdc6qobpksqbwouye`.
**Same 36 entrypoints as production — only the calendar differs**, and init is
stamped `[FASTWINDOWS BUILD 3600x]` so the deployment can never be mistaken.

**Eight heights is not a free choice; the suite picked it.** A day's emission is
split 50/25/25 and the PoB half again 25/75, and `MulDiv` floors both times.
Per-height emission is odd in every era, so:

- 2 heights/day → `auditSupply` FAILED, a few base units stranded per day.
- 4 heights/day → audit passed, but `TestTimeTravelIsPathIndependent` FAILED:
  `pool_deep` differed by 547 units over three years between settling daily and
  monthly. One floored unit per two days.
- **8 heights/day → both exact**, as the real 28,800 and the 240x build's 120
  also are. Both are multiples of 8.

### What the suite says about this build

- **mainnet clock: everything passes.** The production protocol is untouched.
- **240x: 2 failures** (`TestSeventyFiveYearRun`, `TestSettleIsPathIndependent`)
  — the existing, known baseline.
- **3600x: those same 2, plus `TestFirstEverCurationAnchorsThenMintsNextMonth`.**

All three are the same family and none is a code fault: **emission is pinned to
real time while days shrink**, so a compressed "day" earns a fraction of the
emission it would on the real chain. The 75-year test asks for a lifetime of
emission in 27,375 compressed days; the curation test's curator earns less than
the 1-LASSECASH dust floor, so the balance correctly rolls over instead of
minting. Both are the clock, and both are exactly what the 240x build already
does.

`TestFirstVoteRegistersAnOutsidePost` also failed on the fast clock and that
one WAS worth fixing: it paid out at "genesis + 8 days" for a post registered
by a vote at `genesis+10` HEIGHTS, which only clears while a day is far longer
than 10 heights. It now measures from the post's own record, the way the
contract does, and passes on all three clocks.

## The run, when the 10 HBD is there

1. `./deploy.sh preflight` then
   `WASM=contract/artifacts/main-fastwindows.wasm NAME="LasseCash throwaway 13 (sweeps)" ./deploy.sh deploy`
2. `init` at the current head. **Arm all three at once, immediately** — they run
   in parallel and the longest is the clock:
   - `mint <amount>|1` — a 1-day mint, abandoned deliberately. Dead at day 181.
   - `add_liquidity` — a tranche, never claimed. Sweepable at day 180.
   - `post` + `vote` from a second account, then `payout` after day 7. The
     curator never claims; sweepable 365 days after the payout.
3. Keep the accrual walk from falling behind: `advance <maxDays>` in slices,
   roughly every 20 minutes. Budget ~18,600 RC for a 372-day walk.
4. At ~2.5 hours, sweep all three and read the state back:
   - `sweep_mint <owner>|<id>` — must pay the OWNER nothing (already zero) and
     release the shares; `pool_lshare` takes the principal.
   - `sweep_tranche <owner>|<id>` — must return the LP's LASSECASH and HBD
     WHOLE to the owner, never to the caller. This is the single most dangerous
     line in the contract (`closeTranche` pays `owner`, not `ctx.Sender`).
   - `sweep_curation <author>|<permlink>|<curator>` — the pot returns to the
     L-Share pool; the queue entry must clear itself on the next drain.
5. Refusals to prove as well: each sweep before its window ("still owed",
   "not dormant", "not expired"), and a second sweep of the same position.

## If a sweep is broken

A fix is a contract update: 10 HBD, 48-hour timelock, so it must be queued by
**~6 October** to activate before the key burn. After that the behaviour is
permanent, whatever it is.

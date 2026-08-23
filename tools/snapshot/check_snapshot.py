#!/usr/bin/env python3
"""
Invariants the snapshot must satisfy. Exits non-zero if any fails.

WHY THIS EXISTS. Every serious defect found in this pipeline was found by a
human reading terminal output, which is not a control. On 2026-08-23 a resuming
balance scan double-counted ~74,000 LASSECASH and pushed the snapshot 81,150
over the 51,000,000 hardcap; the breach was printed by apply_criteria and would
have scrolled past unread on any less careful evening. The contract has a
fuzzer, a supply audit after every operation and mainnet soaks. The pipeline
that decides who owns what had one print statement.

These are the checks that print statement should always have been. Run before
committing a snapshot, and run again immediately before the real one:

    python3 tools/snapshot/check_snapshot.py

Every check is a property of data already on disk, so it costs nothing and can
be run as often as it is doubted.
"""
import json
import os
import sys
from datetime import datetime, timezone, timedelta

import apply_criteria as ac

HARDCAP = 51_000_000_00000000
EMISSION_CAP = 20_000_000_00000000
UNIT = 100_000_000

failures: list[str] = []
notes: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if detail:
        print(f"          {detail}")
    if not ok:
        failures.append(label)


def lc(units: int) -> str:
    return f"{units / UNIT:,.8f}"


def main() -> None:
    balances = json.load(open(ac.BALANCES))
    activity = json.load(open(ac.ACTIVITY))
    cutoff = datetime.now(timezone.utc) - timedelta(days=30 * 6)
    alive, dead, burned = ac.evaluate(balances, activity, cutoff)

    # 0. THE TWO FILES DESCRIBE THE SAME ACCOUNTS. `evaluate` treats a missing
    #    activity record as "dead" — burning on the most complete form of
    #    missing data there is. Found by two independent reviews on
    #    2026-08-23: remove 200 alive accounts' records and every other check
    #    in this file still passed, with 10.43M LC (99.9% of the migrating
    #    supply) silently moved to null. apply_criteria only compares COUNTS,
    #    which equal-and-different sets satisfy. Compare the sets.
    missing = sorted(set(balances) - set(activity))
    extra = sorted(set(activity) - set(balances))
    check(not missing, "every account with a balance has an activity record",
          f"{len(missing):,} missing: {', '.join(missing[:5])}{'…' if len(missing) > 5 else ''}" if missing else "")
    check(not extra, "no activity record for an account that has no balance",
          f"{len(extra):,} extra: {', '.join(extra[:5])}{'…' if len(extra) > 5 else ''}" if extra else "")

    #    And every record must come from a COMPLETE pass of the fixed scanner:
    #    one carrying the LASSECASH-only truncation flag. A record without it
    #    predates the 2026-08-23 fix and would fall back to the Hive-inclusive
    #    flag, letting the dropped Hive limb decide the account's fate.
    unflagged = sorted(a for a in balances if "he_search_truncated" not in (activity.get(a) or {}))
    check(not unflagged, "every activity record carries the LASSECASH-only truncation flag",
          f"{len(unflagged):,} records predate the scanner fix — rescan" if unflagged else "")

    claimable = ac.totals(alive)
    to_null = ac.totals(dead) + ac.totals(burned)
    snapshot = claimable + to_null

    print(f"\nsnapshot supply {lc(snapshot)} across {len(balances):,} accounts\n")

    # 1. THE HARDCAP. The one number that has never moved since 2019, and the
    #    only invariant whose failure is a launch blocker rather than a bug.
    check(snapshot + EMISSION_CAP <= HARDCAP,
          "snapshot + 20M emission cap <= 51M hardcap",
          f"{lc(snapshot + EMISSION_CAP)} vs {lc(HARDCAP)}, "
          f"headroom {lc(HARDCAP - snapshot - EMISSION_CAP)}")

    # 2. PARTITION. Every account lands in exactly one bucket. A name in two
    #    buckets would be credited twice; a name in none would be erased.
    names = set(balances)
    buckets = [set(alive), set(dead), set(burned)]
    overlap = set()
    for i in range(len(buckets)):
        for j in range(i + 1, len(buckets)):
            overlap |= buckets[i] & buckets[j]
    covered = buckets[0] | buckets[1] | buckets[2]
    check(not overlap, "no account is in two buckets",
          ", ".join(sorted(overlap)[:5]) if overlap else "")
    check(covered == names, "every account is in exactly one bucket",
          f"{len(names - covered)} uncovered" if covered != names else "")

    # 3. CONSERVATION. The buckets must sum to the whole, to the base unit —
    #    the arithmetic that a double-count breaks first.
    total_direct = sum(
        ac.to_units(b["balance"]) + ac.to_units(b.get("pooled", "0"))
        + ac.to_units(b.get("onOrder", "0")) + ac.to_units(b["stake"])
        + ac.to_units(b.get("pendingUnstake", "0"))
        + ac.to_units(b.get("delegationsOut", "0"))
        for b in balances.values()
    )
    check(total_direct == snapshot, "buckets sum to the balance file exactly",
          f"{lc(total_direct)} vs {lc(snapshot)}" if total_direct != snapshot else "")

    # 4. NO NEGATIVES. Hive-Engine carries negative dust from an old unstake
    #    rounding bug and three accounts carry impossible negative
    #    pendingUndelegations. Anything negative reaching a bucket total means a
    #    clamp was missed and somebody's holding was silently reduced.
    negatives = [a for a, r in list(alive.items()) + list(dead.items())
                 if r["liquid"] < 0 or r["staked"] < 0 or r["total"] < 0]
    check(not negatives, "no account has a negative liquid, staked or total",
          ", ".join(negatives[:5]) if negatives else "")

    # 5. THE DRIFT IS A CONSTANT. This is the real control, and the first
    #    version of it was useless — proven by injecting the exact fault from
    #    2026-08-23 (72,023 LASSECASH of phantom balance) and watching every
    #    check pass, because there was 113,667 of hardcap headroom to hide in.
    #    The hardcap only caught the original bug by luck of magnitude.
    #
    #    Reason it through instead. If our capture is complete, then
    #        snapshot + undistributed = everything that exists,
    #    so
    #        recorded - snapshot - undistributed = recorded - exists,
    #    which is the Hive-Engine supply drift documented in
    #    docs/HIVE-ENGINE-SUPPLY-AUDIT.md. Nothing issues or burns LASSECASH on
    #    Hive-Engine any more — the token is fully issued and its issuer does
    #    not mint. So that number is a CONSTANT, and any movement in it means
    #    our capture changed: tokens counted twice, or a holding bucket missed.
    #
    #    Pinned tight on purpose. If this fails, do not widen the tolerance —
    #    find what moved. Re-baseline only with a written reason.
    DRIFT_BASELINE = -48511709796171     # measured 2026-08-23, full-pass scan
    DRIFT_TOLERANCE = 1000 * UNIT
    UNDISTRIBUTED = 59878408873677       # tokens.contractsBalances, distribution
    RECORDED = 31_000_000 * UNIT
    drift = RECORDED - snapshot - UNDISTRIBUTED
    moved = abs(drift - DRIFT_BASELINE)
    check(moved <= DRIFT_TOLERANCE,
          "Hive-Engine supply drift is unchanged (capture is complete)",
          f"drift {lc(drift)}, baseline {lc(DRIFT_BASELINE)}, moved {lc(moved)}")

    # 6. THE SNAPSHOT TOTAL DID NOT MOVE UNEXPLAINED. A second, blunter net
    #    under the same failure: the total is recorded here and any change must
    #    be deliberate. Tokens move between accounts constantly; the SUM over
    #    all accounts does not move at all unless the scan changed.
    TOTAL_BASELINE = 3088633300922494    # measured 2026-08-23, full-pass scan
    total_moved = abs(snapshot - TOTAL_BASELINE)
    check(total_moved <= 1000 * UNIT,
          "snapshot total matches the recorded baseline",
          f"{lc(snapshot)} vs {lc(TOTAL_BASELINE)}, moved {lc(total_moved)}")

    # 7. FAIL-OPEN IS ACTUALLY OPEN. An unresolved history walk must land the
    #    account in `alive`, never in `dead`. Burning on missing data destroys
    #    property because a scanner ran out of pages.
    wrongly_dead = [a for a, r in dead.items() if r.get("he_search_truncated")]
    check(not wrongly_dead, "no account burned on an unresolved history walk",
          ", ".join(wrongly_dead[:5]) if wrongly_dead else "")

    # 8. THE SPLIT IS BASELINED, NOT JUST THE TOTAL. Every check above is a
    #    sum over the whole snapshot, so moving every account from alive to
    #    dead changes none of them. Two independent reviews demonstrated it:
    #    zero out all 2,892 liveness timestamps and checks 1-7 all pass. So
    #    the claimable total and the alive count are pinned the same way the
    #    grand total is, and a move is a stop. Re-baseline only with a written
    #    reason — and a GROWING claimable set during the roll call is the
    #    expected direction, a shrinking one almost never is.
    CLAIMABLE_BASELINE = 1043726514400409   # measured 2026-08-23, 6-month C6
    ALIVE_BASELINE = 420
    moved_c = claimable - CLAIMABLE_BASELINE
    check(abs(moved_c) <= 2_000_000 * UNIT,
          "claimable total is within 2M of the recorded baseline",
          f"{lc(claimable)} vs {lc(CLAIMABLE_BASELINE)}, moved {lc(moved_c)}")
    check(len(alive) >= ALIVE_BASELINE * 0.8,
          "alive count has not collapsed",
          f"{len(alive)} alive vs baseline {ALIVE_BASELINE} — a fall below 80% means the "
          f"liveness data is stale, partial or mis-keyed" if len(alive) < ALIVE_BASELINE * 0.8
          else f"{len(alive)} alive")

    #    Liquid and staked are pinned SEPARATELY. The split decides whether a
    #    holder gets tokens immediately or a 30-day mint that bleeds to zero by
    #    day 210; swapping the two for every account conserves every total.
    liq = sum(r["liquid"] for r in list(alive.values()) + list(dead.values()) + list(burned.values()))
    stk = sum(r["staked"] for r in list(alive.values()) + list(dead.values()) + list(burned.values()))
    LIQUID_BASELINE = 1362680787375364     # measured 2026-08-23 full-pass scan
    STAKED_BASELINE = 1601833333035005
    check(abs(liq - LIQUID_BASELINE) <= 200_000 * UNIT,
          "liquid total matches its baseline", f"{lc(liq)} vs {lc(LIQUID_BASELINE)}")
    check(abs(stk - STAKED_BASELINE) <= 200_000 * UNIT,
          "staked total matches its baseline", f"{lc(stk)} vs {lc(STAKED_BASELINE)}")

    # 9. THE COMMITTED ARTIFACT IS WHAT WAS CHECKED. This file used to validate
    #    a fresh evaluation and never open migration_set.json — the file the
    #    Merkle tree is actually built from. On 2026-08-23 the two disagreed by
    #    1,999 accounts (a stale 3-month set on disk, a 6-month rule in the
    #    gate) and every check passed. Now the written set must be IDENTICAL to
    #    the evaluation: same accounts in each bucket, same liquid and staked
    #    for every one of them, same window.
    if os.path.exists(ac.OUT):
        ms = json.load(open(ac.OUT))
        same_window = ms.get("window_months") == 6
        check(same_window, "migration_set.json was written with the 6-month window",
              f"file says window_months={ms.get('window_months')}" if not same_window else "")
        diffs = []
        for name, mine, theirs in (("migrate", alive, ms.get("migrate", {})),
                                   ("burn_inactive", dead, ms.get("burn_inactive", {})),
                                   ("burn_protocol", burned, ms.get("burn_protocol", {}))):
            if set(mine) != set(theirs):
                diffs.append(f"{name}: {len(set(mine) ^ set(theirs))} accounts differ")
                continue
            for a, r in mine.items():
                t = theirs[a]
                if r["liquid"] != t["liquid"] or r["staked"] != t["staked"]:
                    diffs.append(f"{name}: @{a} liquid/staked differ")
                    break
        check(not diffs, "migration_set.json is byte-for-byte what this check evaluated",
              "; ".join(diffs[:3]) if diffs else "")
    else:
        check(False, "migration_set.json exists", "run apply_criteria.py --write first")

    for n in notes:
        print(f"\n  note: {n}")

    if failures:
        print(f"\n{len(failures)} CHECK(S) FAILED — do not commit this snapshot\n")
        sys.exit(1)
    print("\nall checks passed\n")


if __name__ == "__main__":
    main()

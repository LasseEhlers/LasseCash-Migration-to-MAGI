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

    for n in notes:
        print(f"\n  note: {n}")

    if failures:
        print(f"\n{len(failures)} CHECK(S) FAILED — do not commit this snapshot\n")
        sys.exit(1)
    print("\nall checks passed\n")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
A property-based fuzzer for the snapshot pipeline's pure functions.

WHY THIS EXISTS. test_pipeline.py has 29 tests, all fixed cases — the exact
shapes of the five bugs already found. That is the weakest kind of test: it
proves the bugs we already know about stay fixed, and says nothing about the
next one. The Go engine has had a 500,000-round fuzzer with a supply audit
after every operation since 2026-08-21. The Python pipeline that decides who
keeps their tokens had nothing like it until tonight.

WHAT IS FUZZED. Random, adversarial account records — extreme decimal
strings, scientific notation, huge amounts, negative dust, boundary
timestamps, malformed activity records, unicode-adjacent names — pushed
through to_units(), evaluate() and the invariants check_snapshot.py enforces.
Every property below must hold for EVERY random input, not just the ones a
human thought to write down.

Run:
    python3 fuzz_pipeline.py                 # a few thousand rounds, ~seconds
    FUZZ_ROUNDS=200000 python3 fuzz_pipeline.py
    FUZZ_SEED=12345 python3 fuzz_pipeline.py  # replay one failure exactly
"""
import os
import random
import string
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import apply_criteria as ac

UNIT = 100_000_000


def random_decimal_string(r: random.Random) -> str:
    """A string shaped like something Hive-Engine actually emits — including
    the awkward cases: scientific notation, all-zero, huge, tiny."""
    kind = r.randint(0, 6)
    if kind == 0:
        return "0"
    if kind == 1:
        # scientific notation dust, like Hive-Engine's own "2E-8"
        mant = r.randint(1, 99)
        exp = r.randint(-10, -1)
        return f"{mant}E{exp}"
    if kind == 2:
        # a plain negative — the old Hive-Engine ghost-dust shape
        return f"-{r.randint(0, 1000)}.{r.randint(0, 99999999):08d}"
    if kind == 3:
        # a huge value — bigger than the entire supply, deliberately
        return f"{r.randint(10**7, 10**12)}.{r.randint(0, 99999999):08d}"
    if kind == 4:
        return ""  # missing/empty field
    if kind == 5:
        return f"{r.randint(0, 10**6)}.{'0' * r.randint(0, 12)}{r.randint(0,9)}"  # odd precision
    return f"{r.randint(0, 10**6)}.{r.randint(0, 99999999):08d}"


def random_balance(r: random.Random) -> dict:
    # `balance` and `stake` are GUARANTEED present: fetch.py writes them on
    # every row, defaulting to "0" (fetch.py: `"balance": r.get("balance") or
    # "0"`). evaluate() is entitled to assume that. The optional fields are
    # genuinely optional in real data and randomly omitted here.
    b = {"balance": random_decimal_string(r), "stake": random_decimal_string(r)}
    for f in ["pendingUnstake", "delegationsOut", "delegationsIn", "pooled", "onOrder"]:
        if r.random() < 0.15:
            continue
        b[f] = random_decimal_string(r)
    return b


def random_activity(r: random.Random, now: float) -> dict:
    a = {}
    kind = r.randint(0, 5)
    if kind == 0:
        return {}  # no record at all
    if kind == 1:
        a["last_lassecash_ts"] = now - r.uniform(-86400, 3 * 365 * 86400)  # can be "in the future"
    if kind == 2:
        a["last_lassecash_ts"] = None
    if r.random() < 0.3:
        a["he_search_truncated"] = r.choice([True, False])
    if r.random() < 0.2:
        a["search_truncated"] = r.choice([True, False])
    if r.random() < 0.2:
        a["last_active_op_ts"] = datetime.now(timezone.utc).isoformat()
    return a


def random_name(r: random.Random) -> str:
    if r.random() < 0.05:
        return ""  # empty account name — must not crash
    n = r.randint(1, 20)
    return "".join(r.choice(string.ascii_lowercase + string.digits + ".-") for _ in range(n))


def check_properties(seed: int, accounts: int) -> str | None:
    """Build one random snapshot, run it through evaluate(), and assert every
    invariant check_snapshot.py enforces. Returns a failure description or
    None."""
    r = random.Random(seed)
    now = datetime.now(timezone.utc).timestamp()
    cutoff = datetime.now(timezone.utc) - timedelta(days=180)

    balances, activity = {}, {}
    names = set()
    for _ in range(accounts):
        name = random_name(r)
        # names must be unique keys in a real dict — collisions just overwrite,
        # which is fine and matches what a real JSON file would do
        names.add(name)
        balances[name] = random_balance(r)
        activity[name] = random_activity(r, now)

    try:
        alive, dead, burned = ac.evaluate(balances, activity, cutoff)
    except Exception as e:  # noqa: BLE001 — a crash on adversarial input IS the bug
        return f"evaluate() raised {type(e).__name__}: {e}"

    # PROPERTY 1: partition — every name in exactly one bucket.
    all_buckets = [set(alive), set(dead), set(burned)]
    overlap = (all_buckets[0] & all_buckets[1]) | (all_buckets[1] & all_buckets[2]) | (all_buckets[0] & all_buckets[2])
    if overlap:
        return f"account(s) in two buckets: {overlap}"
    covered = all_buckets[0] | all_buckets[1] | all_buckets[2]
    if covered != names:
        return f"accounts not covered by any bucket: {names - covered}"

    # PROPERTY 2: no negative liquid/staked/total ever escapes evaluate(),
    # regardless of how negative or malformed the source strings were.
    for bucket_name, bucket in [("alive", alive), ("dead", dead), ("burned", burned)]:
        for a, rec in bucket.items():
            if rec["liquid"] < 0 or rec["staked"] < 0 or rec["total"] < 0:
                return f"NEGATIVE holding in {bucket_name}: {a} -> {rec}"
            if rec["total"] != rec["liquid"] + rec["staked"]:
                return f"total != liquid+staked for {a}: {rec}"

    # PROPERTY 3: fail-open is actually open — a truncated LASSECASH search
    # (he_search_truncated=True) must NEVER land in `dead`.
    for a, rec in dead.items():
        act = activity.get(a) or {}
        if act.get("he_search_truncated"):
            return f"FAIL-OPEN VIOLATED: {a} burned despite he_search_truncated=True"

    # PROPERTY 4: pendingUnstake never contributes more than the single
    # in-flight instalment. staked - delegationsOut - stake(clamped) must not
    # exceed max(pendingUnstake - stake, 0) by more than rounding.
    for a, rec in list(alive.items()) + list(dead.items()):
        bal = balances[a]
        stake_u = ac.to_units(bal.get("stake", "0"))
        pending_u = ac.to_units(bal.get("pendingUnstake", "0"))
        delout_u = ac.to_units(bal.get("delegationsOut", "0"))
        expected_staked = stake_u + max(pending_u - stake_u, 0) + delout_u
        if rec["staked"] != expected_staked:
            return (f"pendingUnstake overlap formula violated for {a}: "
                   f"got {rec['staked']}, expected {expected_staked} "
                   f"(stake={stake_u} pending={pending_u} delOut={delout_u})")

    # PROPERTY 5: to_units never returns something that round-trips to a
    # DIFFERENT sign than the (clamped) source, and never raises on garbage
    # short of truly invalid Decimal syntax (handled separately below).
    for a, bal in balances.items():
        for f in ["balance", "stake", "pendingUnstake", "delegationsOut", "pooled", "onOrder"]:
            v = bal.get(f)
            if v is None:
                continue
            try:
                u = ac.to_units(v)
            except (InvalidOperation, ValueError):
                continue  # garbage in, loud failure — acceptable, not a silent-wrong bug
            if u < 0:
                return f"to_units returned NEGATIVE for {a}.{f}={v!r}: {u}"

    return None


def main() -> None:
    rounds = int(os.environ.get("FUZZ_ROUNDS", "5000"))
    fixed_seed = os.environ.get("FUZZ_SEED")
    seeds = [int(fixed_seed)] if fixed_seed else [random.randint(0, 2**31) for _ in range(rounds)]

    failures = 0
    for i, seed in enumerate(seeds):
        accounts = random.Random(seed ^ 0xBEEF).randint(1, 40)
        failure = check_properties(seed, accounts)
        if failure:
            failures += 1
            print(f"FAIL  seed={seed}  accounts={accounts}")
            print(f"        {failure}")
            print(f"        replay: FUZZ_SEED={seed} python3 fuzz_pipeline.py")
        if (i + 1) % max(1, rounds // 20) == 0:
            print(f"  {i+1:,}/{rounds:,} rounds, {failures} failures so far")

    print(f"\n{'FAILED' if failures else 'PASSED'}: {len(seeds):,} rounds, {failures} failures")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()

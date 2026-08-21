#!/usr/bin/env python3
"""
LasseCash migration snapshot — criteria application.

Reads the raw facts collected by fetch.py and decides who migrates. This is
pure local computation: change a threshold, re-run, see the answer instantly.
No network. Never put fetching in here.

Usage:
    python3 apply_criteria.py                 # default: 12-month window
    python3 apply_criteria.py --months 6
    python3 apply_criteria.py --compare       # show several windows side by side
    python3 apply_criteria.py --write         # emit migration_set.json
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_DOWN

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
BALANCES = os.path.join(DATA, "balances.json")
ACTIVITY = os.path.join(DATA, "activity.json")
OUT = os.path.join(DATA, "migration_set.json")

# Protocol accounts. Their balances go to @null rather than migrating; they are
# sinks and treasury, not users. See spec section 1.
BURN_ACCOUNTS = {"lassecash", "null", "lassecash.dao"}

UNIT = 10 ** 8  # 8 decimals, base units


def to_units(s):
    """
    Parse a Hive-Engine balance string into integer base units.

    Hive-Engine emits several formats for the same thing — "1234.5678",
    "0", and scientific notation like "2E-8" for dust. Decimal handles all
    of them exactly; float would not. This feeds the genesis ledger, so the
    conversion must be exact and must truncate rather than round.
    """
    s = (s or "0").strip()
    if not s:
        return 0
    try:
        d = Decimal(s)
    except InvalidOperation:
        raise ValueError(f"unparseable balance: {s!r}")
    # Scale to base units, truncating toward zero. ROUND_DOWN on a Decimal is
    # exact: no binary floating point is involved anywhere in this path.
    units = int((d * UNIT).to_integral_value(rounding=ROUND_DOWN))
    # Hive-Engine's old unstake code left a few accounts with NEGATIVE dust
    # (e.g. pendingUnstake "-0.00000027"). Nobody owns a negative balance;
    # the contract refuses one. Clamp at zero, field by field.
    return max(units, 0)


def fmt(units):
    return f"{units // UNIT:,}.{units % UNIT:08d}"


def parse_ts(v):
    """Accept ISO strings (Hive) and unix ints (Hive-Engine)."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v, tz=timezone.utc)
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).replace(
            tzinfo=timezone.utc)
    except ValueError:
        return None


def evaluate(balances, activity, cutoff):
    """
    Qualifying rule (see CLAUDE.md):

      An account migrates if it shows EITHER
        (a) a Hive active-authority operation, OR
        (b) a LASSECASH movement on Hive-Engine
      since `cutoff`.

    Rationale: (a) proves a human holds the active key — posting-key bots
    cannot forge it. (b) proves engagement with LasseCash specifically. Either
    is sufficient; requiring both would drop real users who are active on only
    one layer.

    There is deliberately NO minimum balance. Only ~11k accounts ever touched
    LasseCash, so pruning by size removes real humans to save trivial state.
    """
    alive, dead, burned = {}, {}, {}

    for account, bal in balances.items():
        # Everything the account OWNS. Found 2026-08-21: balance+stake alone
        # dropped 525k LC sitting in unstaking cooldowns and 101k LC delegated
        # out (a delegation leaves the delegator's `stake` figure but is still
        # theirs; the receiver's `delegationsIn` is NOT theirs and is not
        # counted). Both were under lock, so they migrate as staked power —
        # the 30-day migration mint — like any other LASSECASH POWER.
        # Liquid = balance + the account's LASSECASH in the Diesel pool + its
        # open sell orders (owned, but held by contracts — see fetch.py).
        liquid = (to_units(bal["balance"]) + to_units(bal.get("pooled", "0"))
                  + to_units(bal.get("onOrder", "0")))
        staked = (to_units(bal["stake"]) + to_units(bal.get("pendingUnstake", "0"))
                  + to_units(bal.get("delegationsOut", "0")))
        units = liquid + staked
        rec = {
            "liquid": liquid,
            "staked": staked,
            "total": units,
        }

        if account in BURN_ACCOUNTS:
            burned[account] = rec
            continue

        act = activity.get(account) or {}
        hive_ts = parse_ts(act.get("last_active_op_ts"))
        lc_ts = parse_ts(act.get("last_lassecash_ts"))

        by_hive = hive_ts is not None and hive_ts >= cutoff
        by_lc = lc_ts is not None and lc_ts >= cutoff

        if by_hive or by_lc:
            rec["reason"] = ("active_key" if by_hive else "") + \
                            ("+lassecash" if by_lc else "")
            rec["last_active_op"] = act.get("last_active_op_ts")
            rec["last_lassecash"] = act.get("last_lassecash_ts")
            alive[account] = rec
        else:
            rec["last_active_op"] = act.get("last_active_op_ts")
            rec["last_lassecash"] = act.get("last_lassecash_ts")
            dead[account] = rec

    return alive, dead, burned


def totals(d):
    return sum(r["total"] for r in d.values())


def report(balances, activity, months, verbose=True):
    cutoff = datetime.now(timezone.utc) - timedelta(days=30 * months)
    alive, dead, burned = evaluate(balances, activity, cutoff)

    a_t, d_t, b_t = totals(alive), totals(dead), totals(burned)
    grand = a_t + d_t + b_t

    if verbose:
        print(f"\n{'=' * 72}")
        print(f"MIGRATION SNAPSHOT — {months}-month liveness window "
              f"(cutoff {cutoff:%Y-%m-%d})")
        print("=" * 72)
        print(f"  {'':22}{'accounts':>10}{'LASSECASH':>26}{'share':>9}")
        print("  " + "-" * 66)
        for label, s, t in (("MIGRATES (alive)", alive, a_t),
                            ("burned (inactive)", dead, d_t),
                            ("burned (protocol)", burned, b_t)):
            pct = (t * 100 / grand) if grand else 0
            print(f"  {label:22}{len(s):>10,}{fmt(t):>26}{pct:>8.1f}%")
        print("  " + "-" * 66)
        print(f"  {'TOTAL':22}{len(balances):>10,}{fmt(grand):>26}")

        by_key = sum(1 for r in alive.values() if r["reason"].startswith("active_key"))
        only_lc = len(alive) - by_key
        print(f"\n  qualified via active key : {by_key:,}")
        print(f"  qualified via LASSECASH only : {only_lc:,}")

        print(f"\n  HARDCAP CHECK")
        print(f"    migrated supply        : {fmt(a_t)} LC")
        print(f"    + max future emission  : {fmt(20_000_000 * UNIT)} LC")
        print(f"    = maximum ever         : {fmt(a_t + 20_000_000 * UNIT)} LC")
        print(f"    historic hardcap       : {fmt(51_000_000 * UNIT)} LC")
        headroom = 51_000_000 * UNIT - (a_t + 20_000_000 * UNIT)
        ok = "OK" if headroom >= 0 else "*** BREACH ***"
        print(f"    headroom               : {fmt(headroom)} LC   {ok}")

    return alive, dead, burned


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=3,
                    help="liveness window in months (default 3 — DECIDED by Lasse 2026-08-21, with an announced one-week roll call before the snapshot)")
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(BALANCES):
        sys.exit("no balances.json — run `fetch.py balances` first")
    balances = json.load(open(BALANCES))
    activity = json.load(open(ACTIVITY)) if os.path.exists(ACTIVITY) else {}

    if not activity:
        sys.exit("no activity.json yet — run `fetch.py activity` first")
    if len(activity) < len(balances):
        print(f"WARNING: activity scan incomplete "
              f"({len(activity):,}/{len(balances):,}). Numbers are provisional.",
              file=sys.stderr)

    if args.compare:
        print(f"\n{'window':>10}{'migrating':>12}{'supply':>26}{'burned':>26}")
        print("-" * 74)
        for m in (3, 6, 12, 24, 36, 120):
            cutoff = datetime.now(timezone.utc) - timedelta(days=30 * m)
            alive, dead, burned = evaluate(balances, activity, cutoff)
            print(f"{m:>8}mo{len(alive):>12,}{fmt(totals(alive)):>26}"
                  f"{fmt(totals(dead) + totals(burned)):>26}")
        return

    alive, dead, burned = report(balances, activity, args.months)

    if args.write:
        json.dump({
            "generated": datetime.now(timezone.utc).isoformat(),
            "window_months": args.months,
            "migrate": alive,
            "burn_inactive": dead,
            "burn_protocol": burned,
        }, open(OUT, "w"), indent=1)
        print(f"\n  wrote {OUT}")


if __name__ == "__main__":
    main()

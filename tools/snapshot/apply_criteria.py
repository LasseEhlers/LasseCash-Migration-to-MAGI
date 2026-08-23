#!/usr/bin/env python3
"""
LasseCash migration snapshot — criteria application.

Reads the raw facts collected by fetch.py and decides who migrates. This is
pure local computation: change a threshold, re-run, see the answer instantly.
No network. Never put fetching in here.

Usage:
    python3 apply_criteria.py                 # default: 6-month window (C6)
    python3 apply_criteria.py --months 12
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
    Qualifying rule — "C6" (DECIDED by Lasse 2026-08-22, see CLAUDE.md):

      An account migrates IF AND ONLY IF it signed at least one LASSECASH
      operation on Hive-Engine (a transfer, stake, unstake, delegation or
      market order) since `cutoff`.

    Rationale, in Lasse's terms: LASSECASH is a product, not just a holding.
    Being alive somewhere on Hive proves a human exists; it does not prove
    they ever used LasseCash. Thousands of accounts hold LASSECASH only
    because Lasse gave it away for years. Signing a LASSECASH operation is
    the only bot-proof, on-chain proof that the holder engaged with
    LasseCash itself. Everything else people do on LasseCash (posting,
    commenting, voting, earning, holding a Diesel pool position) uses the
    POSTING key or no key at all, so it cannot be distinguished from a bot
    or from a gift.

    The Hive L1 active-authority signal (`last_active_op_ts`) is DROPPED
    from the decision entirely — this SUPERSEDES the old `by_hive OR by_lc`
    rule. It no longer makes anyone eligible, but it is still read and still
    written into every record, for the audit trail.

    Fail OPEN on an unresolved search. fetch.py records `search_truncated`
    (and, per-account, the fresher `he_search_truncated` merged in from a
    later rescan) when a LASSECASH history walk hit MAX_HISTORY_PAGES
    without resolving. A truncated search means "not found within the
    walked window", not "proven absent". An account whose LASSECASH search
    was truncated, and which is not otherwise shown alive by a LASSECASH
    timestamp inside the window, is treated as ALIVE — flagged
    "truncated_unresolved" for audit — rather than burned on missing data.
    The asymmetry is deliberate: including a possibly-dead account costs
    almost nothing (claim-based migration means they must still claim, and
    an unclaimed position sweeps to the reward pool on its own schedule),
    while excluding a possibly-alive one destroys their property because
    the scanner ran out of pages. Deep-history accounts — thousands of
    payout entries burying the one signed op, e.g. @master-lamps — are
    exactly the prolific-poster users this protects.

    There is deliberately NO minimum balance. Only ~11k accounts ever touched
    LasseCash, so pruning by size removes real humans to save trivial state.
    """
    alive, dead, burned = {}, {}, {}

    for account, bal in balances.items():
        # fetch.py guarantees "balance" and "stake" on every row (defaulting
        # to "0"). A corrupted or hand-edited file lacking them used to raise
        # a bare KeyError mid-evaluation — confusing, and it could happen
        # partway through a run rather than failing clearly upfront. Found by
        # fuzz_pipeline.py, 2026-08-23.
        if "balance" not in bal or "stake" not in bal:
            raise ValueError(
                f"balances.json entry for {account!r} is missing 'balance' or "
                f"'stake' — the file is corrupt or was hand-edited. Re-run fetch.py."
            )
        # Everything the account OWNS.
        #
        # ⚠️ `pendingUnstake` OVERLAPS `stake` — it is NOT a separate bucket.
        # This was recorded on 2026-08-21 as "verified disjoint against
        # @cedricguillas to the base unit" and the rehearsal gate proved that
        # wrong on 2026-08-23, on that same account, with live numbers:
        #
        #   powered down 100,000 in 26 instalments of 3,846.15; 2 paid so far
        #     stake            88,461.54   = 100,000 − 3 × 3,846 (2 paid + the
        #                                     next one pre-decremented)
        #     pendingUnstake   92,307.69   = 100,000 − 2 × 3,846 (the SCHEDULE)
        #     balance           7,692.31   = the 2 instalments paid out
        #
        #   balance + stake + pendingUnstake = 188,461   he never had that much
        #   balance + stake                  =  96,154   + one instalment in flight
        #
        # The model predicts both observed fields to the cent. Adding the
        # schedule on top of the stake credited every mid-cooldown account its
        # power-down TWICE: 93 accounts, 513,209 LC. It also explains most of
        # the "485,173 excess" in the published Hive-Engine supply audit —
        # that was largely us, not Hive-Engine.
        #
        # What IS real and must be counted once: the single instalment Hive-
        # Engine has already removed from `stake` but not yet paid into
        # `balance`. It is exactly max(pendingUnstake − stake, 0), and it is
        # still under lock, so it stays on the staked side.
        #
        # Delegations out are genuinely separate (a delegation leaves the
        # delegator's `stake` but is still theirs; `delegationsIn` is NOT
        # theirs and is never counted). Liquid = balance + Diesel-pool share +
        # open sell orders (owned, held by contracts — see fetch.py).
        stake = to_units(bal["stake"])
        pending = to_units(bal.get("pendingUnstake", "0"))
        in_flight = max(pending - stake, 0)
        liquid = (to_units(bal["balance"]) + to_units(bal.get("pooled", "0"))
                  + to_units(bal.get("onOrder", "0")))
        staked = stake + in_flight + to_units(bal.get("delegationsOut", "0"))
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
        # last_active_op_ts is read and carried into the record below for the
        # audit trail ONLY — it is no longer a qualifying signal (C6 dropped
        # the Hive L1 limb of the old rule entirely).
        lc_ts = parse_ts(act.get("last_lassecash_ts"))

        # `he_search_truncated` is the fresher, LASSECASH-only flag merged in
        # from the 2026-08-22 rescan; fall back to the older combined
        # `search_truncated` (Hive-leg-inclusive) when a per-account record
        # predates that merge.
        he_trunc = act.get("he_search_truncated")
        if he_trunc is None:
            he_trunc = act.get("search_truncated", False)
        he_trunc = bool(he_trunc)

        by_lc = lc_ts is not None and lc_ts >= cutoff

        rec["last_active_op"] = act.get("last_active_op_ts")  # audit only
        rec["last_lassecash"] = act.get("last_lassecash_ts")
        rec["he_search_truncated"] = he_trunc

        if by_lc:
            rec["reason"] = "lassecash_activity"
            alive[account] = rec
        elif he_trunc:
            # Fail open: the search never resolved, so we cannot prove this
            # account is dead. Never burn on missing data.
            rec["reason"] = "truncated_unresolved"
            alive[account] = rec
        else:
            rec["reason"] = "dead"
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

        by_lc = sum(1 for r in alive.values() if r["reason"] == "lassecash_activity")
        by_trunc = len(alive) - by_lc
        print(f"\n  qualified via signed LASSECASH op   : {by_lc:,}")
        print(f"  qualified via truncated_unresolved  : {by_trunc:,}")

        # The cap is measured against the WHOLE snapshot, not just the part
        # that migrates. Burned tokens are not destroyed: `set_snapshot`
        # credits the burn total to hive:null, and the supply identity is
        # "sum of all holdings = migrated + emitted". Verified on the chain
        # 2026-08-22 — right after set_snapshot, sup_migrated equalled the
        # burn total exactly. Measuring headroom against the migrating
        # portion alone reports ~20M of room when the real slack is ~5.8k.
        print(f"\n  HARDCAP CHECK")
        print(f"    claimable (migrates)   : {fmt(a_t)} LC")
        print(f"    + burned to hive:null  : {fmt(d_t + b_t)} LC")
        print(f"    = snapshot supply      : {fmt(grand)} LC")
        print(f"    + max future emission  : {fmt(20_000_000 * UNIT)} LC")
        print(f"    = maximum ever         : {fmt(grand + 20_000_000 * UNIT)} LC")
        print(f"    historic hardcap       : {fmt(51_000_000 * UNIT)} LC")
        headroom = 51_000_000 * UNIT - (grand + 20_000_000 * UNIT)
        ok = "OK" if headroom >= 0 else "*** BREACH ***"
        print(f"    headroom               : {fmt(headroom)} LC   {ok}")
        print(f"    (headroom is LASSECASH issued on the old chains and held")
        print(f"     by nobody — dust lost in the Steem-Engine years.)")

    return alive, dead, burned


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=6,
                    help="liveness window in months (default 6 — DECIDED by Lasse 2026-08-22 under the C6 rule: a signed LASSECASH op on Hive-Engine within the window, with an announced roll call before the snapshot)")
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(BALANCES):
        sys.exit("no balances.json — run `fetch.py balances` first")
    balances = json.load(open(BALANCES))
    activity = json.load(open(ACTIVITY)) if os.path.exists(ACTIVITY) else {}

    if not activity:
        sys.exit("no activity.json yet — run `fetch.py activity` first")

    # THE CONSUMER ENFORCES THE PASS, NOT JUST THE PRODUCER. fetch.py's pass
    # discipline is sound inside fetch.py, but this file used to read whatever
    # was on disk with a COUNT comparison as its only guard — which equal-sized
    # but different sets satisfy. On 2026-08-23 the on-disk file was a mix of
    # two passes (3,950 records from an earlier one) plus 1,650 records from
    # before the scanner fix, and `--write` would have emitted that set with
    # zero warnings. During the roll call, writing while a rescan is 75% through
    # burns every responder in the unscanned 25% — bug 2 reborn one file
    # downstream. So: refuse unless EVERY balance account has a record, every
    # record carries the LASSECASH-only flag, and every record comes from ONE
    # completed pass.
    missing = [a for a in balances if a not in activity]
    if missing:
        sys.exit(f"activity.json is missing {len(missing):,} accounts that hold a balance "
                 f"(e.g. {', '.join(missing[:4])}) — a missing record BURNS. Re-run fetch.py activity.")
    unflagged = [a for a in balances if "he_search_truncated" not in activity[a]]
    if unflagged:
        sys.exit(f"{len(unflagged):,} activity records predate the scanner fix "
                 f"(no he_search_truncated) — re-run fetch.py activity.")
    passes = {activity[a].get("pass") for a in balances}
    if len(passes) != 1 or None in passes:
        sys.exit(f"activity.json mixes {len(passes)} scan passes {sorted(str(p) for p in passes)[:3]} — "
                 f"not one completed run. Re-run fetch.py activity to completion.")
    if os.path.exists(os.path.join(DATA, "activity_pass.json")):
        sys.exit("a fetch.py activity pass is still IN PROGRESS (activity_pass.json exists) — "
                 "wait for it to finish, or it is not the set you think it is.")

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

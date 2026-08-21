#!/usr/bin/env python3
"""
Build the static data file behind the admin migration dashboard.

Reads the two snapshot artifacts that already decided who migrates and who
burns (tools/snapshot/data/migration_set.json) and the raw Hive-Engine
balance dump (tools/snapshot/data/balances.json), and writes a single,
frontend-ready web/static/admin-data.json.

Amounts are written as plain JSON integers in LASSECASH BASE UNITS (8dp,
1 LC = 100_000_000), never as floats and never pre-formatted — the page
converts them with the same $api Amount helpers every other page uses
(fromUnits/toUnits), so there is exactly one place in the whole codebase
that knows how to turn base units into a decimal string. See CLAUDE.md,
"Amounts are decimal strings, never numbers".

Every value here fits comfortably under Number.MAX_SAFE_INTEGER (the whole
51M hardcap is 5.1e15 base units, safe integers go to ~9.007e15), so plain
JSON integers do not lose precision. That is a fact about this specific
bounded dataset, not a license to use floats for money in general.
"""

from __future__ import annotations

import json
from decimal import ROUND_DOWN, Decimal, InvalidOperation
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
MIGRATION_SET = DATA_DIR / "migration_set.json"
BALANCES = DATA_DIR / "balances.json"
OUT = Path(__file__).parents[2] / "web" / "static" / "admin-data.json"

UNIT = Decimal(10) ** 8


def to_base_units(decimal_str: str) -> int:
    """Convert a Hive-Engine decimal-string amount to integer base units.

    balances.json is inconsistent in how it formats zero and tiny amounts
    (plain "0", scientific "2E-8", or a full 8dp string), so this parses with
    Decimal rather than assuming a fixed string shape.
    """
    try:
        # Negative Hive-Engine dust (see apply_criteria.to_units) clamps to 0.
        return max(int((Decimal(decimal_str) * UNIT).to_integral_exact()), 0)
    except InvalidOperation:
        raise ValueError(f"not a decimal amount: {decimal_str!r}")


def main() -> None:
    migration_set = json.loads(MIGRATION_SET.read_text())
    balances = json.loads(BALANCES.read_text())

    migrate = migration_set["migrate"]
    burn_inactive = migration_set["burn_inactive"]
    burn_protocol = migration_set["burn_protocol"]

    migrated = [
        {
            "account": account,
            "liquid": row["liquid"],
            "staked": row["staked"],
            "total": row["total"],
            "reason": row["reason"],
        }
        for account, row in migrate.items()
    ]

    all_accounts = [
        {
            "account": account,
            "liquid": (to_base_units(row["balance"]) + to_base_units(row.get("pooled", "0"))
                       + to_base_units(row.get("onOrder", "0"))),
            # POWER = own stake + unstaking cooldown + delegated out (still the
            # delegator's). Mirrors apply_criteria.py; delegationsIn excluded.
            "staked": (to_base_units(row["stake"])
                       + to_base_units(row.get("pendingUnstake", "0"))
                       + to_base_units(row.get("delegationsOut", "0"))),
        }
        for account, row in balances.items()
    ]

    burned = [
        {
            "account": account,
            "liquid": row["liquid"],
            "staked": row["staked"],
            "group": "inactive",
        }
        for account, row in burn_inactive.items()
    ] + [
        {
            "account": account,
            "liquid": row["liquid"],
            "staked": row["staked"],
            "group": "protocol",
        }
        for account, row in burn_protocol.items()
    ]

    # --- top-of-page stat tiles ------------------------------------------
    #
    # Founder ownership % is an economic-ish figure derived from chain-snapshot
    # data, so it is computed here (Python, once, with exact Decimal math) and
    # shipped as a ready string — never recomputed from raw ints in TypeScript.
    # See CLAUDE.md, golden rule: one engine, and a preview/display value is
    # never reimplemented in a second language.
    total_lassecash = sum(r["liquid"] for r in migrated)
    total_staked_power = sum(r["staked"] for r in migrated)
    combined_total = sum(r["total"] for r in migrated)
    assert total_lassecash + total_staked_power == combined_total, (
        "liquid + staked must equal each account's total exactly"
    )

    founder = migrate.get("lasseehlers")
    founder_total = founder["total"] if founder else 0
    founder_pct = (
        (Decimal(founder_total) / Decimal(combined_total) * 100).quantize(
            Decimal("0.01"), rounding=ROUND_DOWN
        )
        if combined_total
        else Decimal("0.00")
    )

    stats = {
        "migrated_accounts": len(migrated),
        "total_lassecash": total_lassecash,
        "total_staked_power": total_staked_power,
        "combined_total": combined_total,
        # Truncated to 2dp in Python, not rounded up in the browser — matches
        # format.ts's "never round up" rule for anything money-adjacent.
        "founder_ownership_pct": str(founder_pct),
    }

    out = {
        "generated": migration_set["generated"],
        "window_months": migration_set["window_months"],
        "stats": stats,
        "migrated": migrated,
        "all": all_accounts,
        "burned": burned,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))

    all_total = sum(r["liquid"] + r["staked"] for r in all_accounts)
    burned_total = sum(r["liquid"] + r["staked"] for r in burned)

    def lc(units: int) -> str:
        return f"{units / 10**8:,.8f}"

    print(f"migrated : {len(migrated):>7,} accounts   {lc(combined_total):>22} LC")
    print(f"  liquid : {lc(total_lassecash):>22} LC   staked (POWER): {lc(total_staked_power)} LC")
    print(f"  founder ownership: {founder_pct}%")
    print(f"all      : {len(all_accounts):>7,} accounts   {lc(all_total):>22} LC")
    print(f"burned   : {len(burned):>7,} accounts   {lc(burned_total):>22} LC")
    print(f"  (inactive: {len(burn_inactive):,}, protocol: {len(burn_protocol):,})")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

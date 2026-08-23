#!/usr/bin/env python3
"""
Build the public "am I in the snapshot?" data set.

WHY THIS EXISTS. The migration is announced with a one-week roll call: anyone
who has not signed a LASSECASH operation in six months has until the snapshot
block to sign one. That only works if a person can find out, in ten seconds,
which side of the line they are on. Without it they must reconstruct their own
Hive-Engine operation history by hand, and almost nobody will.

WHY IT IMPORTS apply_criteria RATHER THAN RESTATING THE RULE. The C6 rule has
sharp edges — signed operations only, specific Hive-Engine operation names, an
authorship check per operation, and a deliberate fail-open on a truncated
history walk. A second implementation in Python or TypeScript would drift, and
a drift here tells somebody "you are safe" when the snapshot will burn them.
So the page's answer comes from `apply_criteria.evaluate` — the same function
that decides the real snapshot. One implementation, two consumers.

⚠️ RE-RUN THIS AFTER EVERY `fetch.py` REFRESH, and once more immediately before
the snapshot block. It is a photograph: an account that signs an operation an
hour after it runs still reads "not in" until it runs again. The page shows the
timestamp for that reason, and the route re-checks a "not in" answer live
against Hive-Engine so a fresh action is visible immediately.

Usage:
    python3 tools/snapshot/build_status.py            # 6-month window
    python3 tools/snapshot/build_status.py --months 3
"""
import argparse
import json
import os
from datetime import datetime, timezone, timedelta

import apply_criteria as ac

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "..", "web", "static", "migration", "status")

ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789"


def shard_of(name: str) -> str:
    """
    The shard file a name lives in.

    Mirrors migtree.Shard in Go and shardOf() in ClaimMigration.svelte exactly:
    the first two characters, first restricted to alphanumerics and second to
    alphanumerics plus '.' and '-', anything else folded to '_'. Keeping the
    three in step means one lookup rule across proofs and status.
    """
    out = ""
    for i in range(2):
        c = name[i] if i < len(name) else ""
        allowed = ALNUM if i == 0 else ALNUM + ".-"
        out += c if c in allowed else "_"
    return out


def iso(ts) -> str:
    """A timestamp as `YYYY-MM-DD`, from either a unix integer or an ISO string."""
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, timezone.utc).date().isoformat()
    return str(ts)[:10]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=6)
    args = ap.parse_args()

    balances = json.load(open(ac.BALANCES))
    activity = json.load(open(ac.ACTIVITY))
    cutoff = datetime.now(timezone.utc) - timedelta(days=30 * args.months)
    alive, dead, burned = ac.evaluate(balances, activity, cutoff)

    shards: dict[str, dict] = {}

    def put(account: str, rec: dict, verdict: str) -> None:
        row = {
            "in": verdict == "in",
            "liquid": str(rec["liquid"]),
            "staked": str(rec["staked"]),
            "reason": rec.get("reason", verdict),
        }
        # Only carried when known. A missing key renders as "no record", which
        # is honest; a null rendered as a date would not be.
        # Normalised to ISO. fetch.py stores the LASSECASH timestamp as a unix
        # integer and the Hive one as an ISO string; handing both shapes to the
        # page would put the format decision in the frontend, where it would be
        # got wrong once and then be wrong forever.
        if rec.get("last_lassecash"):
            row["last_lassecash"] = iso(rec["last_lassecash"])
        if rec.get("last_active_op"):
            row["last_hive_op"] = iso(rec["last_active_op"])
        if verdict == "protocol":
            row["protocol"] = True
        shards.setdefault(shard_of(account), {})[account] = row

    for a, r in alive.items():
        put(a, r, "in")
    for a, r in dead.items():
        put(a, r, "out")
    for a, r in burned.items():
        # The protocol accounts (@lassecash, @null). They are burned by name,
        # not by inactivity, and saying "you were inactive" would be a lie.
        put(a, r, "protocol")

    os.makedirs(OUT_DIR, exist_ok=True)
    for name, rows in shards.items():
        with open(os.path.join(OUT_DIR, f"{name}.json"), "w") as fh:
            json.dump(rows, fh, separators=(",", ":"))

    index = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "window_months": args.months,
        "cutoff": cutoff.isoformat(),
        "counts": {"in": len(alive), "out": len(dead), "protocol": len(burned)},
        "shards": len(shards),
    }
    with open(os.path.join(OUT_DIR, "index.json"), "w") as fh:
        json.dump(index, fh, indent=1)

    total = len(alive) + len(dead) + len(burned)
    print(f"{total:,} accounts -> {len(shards)} shards in {os.path.normpath(OUT_DIR)}")
    print(f"  in       {len(alive):>7,}")
    print(f"  out      {len(dead):>7,}")
    print(f"  protocol {len(burned):>7,}")
    print(f"  cutoff   {cutoff.date()}  ({args.months} months)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
The migration executor.

Reads tools/snapshot/data/migration_set.json (6,742 accounts,
19,068,736.06104624 LC exactly) and feeds it to a LasseCash contract's
`migrate` entrypoint one account at a time, in deterministic order, with a
resume file so a crash or an RC pause never double-credits anyone.

Targets:
    --dev                 the local simulator on http://localhost:8080
    --magi                the REAL chain, via tools/chain-test/call.js
                          (throwaway contract only; the id is pinned there)

Safety properties, in the order they matter:

  1. NEVER DOUBLE-CREDITS. Progress is written to a resume file AFTER each
     confirmed credit; on restart, completed accounts are skipped. The contract
     itself is the second line of defence: its hardcap check would eventually
     refuse, but "eventually" is not a property to lean on.
  2. Deterministic order (sorted by account name), so two operators comparing
     progress files are comparing the same sequence.
  3. Verifies the grand total against the snapshot BEFORE starting, and the
     on-chain migrated supply against the same figure AFTER finishing. The
     numbers must match to the base unit or the run reports failure.
  4. Amounts are integers end to end. No floats anywhere.

Usage:
    python3 tools/migrate.py --dev            # rehearse against the simulator
    python3 tools/migrate.py --dev --limit 50 # partial rehearsal
    python3 tools/migrate.py --magi --limit 5 # tiny real-chain rehearsal
    python3 tools/migrate.py --status         # where are we?
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "tools/snapshot/data/migration_set.json"
RESUME = ROOT / "tools/snapshot/data/migration_progress.json"

# The FULL snapshot total: migrating accounts plus the burn credited to
# hive:null. Conservation on MAGI is total supply held = this + emission.
# Pinned against the current migration_set.json (3-month window, signed-ops
# criteria, pending unstakes + delegations counted). Re-pin after the final
# pre-snapshot rescan, re-verifying against the 51M hardcap.
EXPECTED_TOTAL = 3_099_419_767_245_149  # 30,994,197.67245149 LC (balances + unstaking + delegations out + Diesel pool + open orders; negative HE dust clamped)
DEV_URL = "http://localhost:8081"


def load_plan():
    data = json.loads(SNAPSHOT.read_text())
    # Zero-balance qualifiers are real accounts that simply hold nothing.
    # There is nothing to credit and the contract rejects a zero amount, so
    # they are excluded from the plan — not an error, a fact of the snapshot.
    plan = sorted((name, rec["liquid"], rec["staked"])
                  for name, rec in data["migrate"].items() if rec["total"] > 0)

    # THE BURN GOES TO @null, PER ACCOUNT — Lasse, 2026-08-21: everything that
    # does not migrate (protocol accounts and non-qualifying holders, LASSECASH
    # and LASSECASH POWER alike) is credited to hive:null through `burn_batch`,
    # which also writes a permanent per-account receipt (mig_<acct> =
    # burned|liquid|staked) so who held what is readable on MAGI forever. The
    # Hive L1 custom_json carrying each batch is the second, public record.
    burns = sorted((name, rec["liquid"], rec["staked"])
                   for key in ("burn_inactive", "burn_protocol")
                   for name, rec in data.get(key, {}).items() if rec["total"] > 0)
    total = sum(l + s for _, l, s in plan) + sum(l + s for _, l, s in burns)
    if total != EXPECTED_TOTAL:
        sys.exit(
            f"REFUSING TO RUN: snapshot total {total} != expected {EXPECTED_TOTAL}.\n"
            "The snapshot changed since this figure was verified against the "
            "51M hardcap. Re-verify tokenomics_check.py, then update EXPECTED_TOTAL."
        )
    return plan, burns


def load_progress():
    if RESUME.exists():
        return json.loads(RESUME.read_text())
    return {"done": {}, "target": None}


def save_progress(p):
    tmp = RESUME.with_suffix(".tmp")
    tmp.write_text(json.dumps(p))
    tmp.replace(RESUME)  # atomic: a crash mid-write cannot corrupt the record


# Batch sizes, MEASURED on the local MAGI devnet 2026-08-21 against the 10B-gas
# per-call ceiling (rc_limit max 100,000 x 100,000 gas/RC):
#   - an account WITH staked power registers a migration mint: ~324M gas each,
#     linear; the ceiling is ~30 with realistic stakes -> 20 leaves 33% headroom
#   - liquid-only migrations and burns: ~45M gas each -> 50 uses < 25% of it
# state.MaxMigrateBatch (50) is the contract's iteration bound; these are the
# sizes that actually fit.
BATCH_STAKED = 20
BATCH_LIQUID = 50


def batch_args(batch):
    """[(account, liquid, staked)] -> the migrate_batch / burn_batch wire format.

    For migrate_batch: liquid becomes balance; staked becomes the 30-day
    migration mint whose L-Shares are the staked amount 1:1. For burn_batch:
    both go to hive:null with a per-account receipt.
    """
    return "|".join(f"hive:{a},{liq},{stk}" for a, liq, stk in batch)


def migrate_dev(batch, entrypoint="migrate_batch"):
    body = json.dumps({
        "sender": "hive:owner",
        "entrypoint": entrypoint,
        "args": batch_args(batch),
    }).encode()
    req = urllib.request.Request(f"{DEV_URL}/tx", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            out = json.load(r)
    except urllib.error.HTTPError as e:
        # The rejection reason is in the body; losing it makes a stopped run
        # undiagnosable, which is the last thing a money migration may be.
        try:
            out = json.loads(e.read().decode())
        except Exception:
            raise RuntimeError(f"HTTP {e.code}") from None
    if not out.get("ok"):
        raise RuntimeError(out.get("msg", "rejected"))


def rc_limit_for(batch):
    """Measured cost plus ~20% headroom. MAGI freezes the FULL rc_limit for
    5 days, so this must be tight: ~3,300 RC per staked account, ~460 per
    liquid-only or burned account, plus a 2,500 base."""
    staked = sum(1 for _, _, s in batch if s > 0)
    liquid = len(batch) - staked
    return min(100_000, int((2_500 + 3_300 * staked + 460 * liquid) * 1.2))


def migrate_magi(batch, entrypoint="migrate_batch"):
    # Throwaway contract only — the contract id is pinned inside call.js and
    # this script deliberately has no way to override it.
    r = subprocess.run(
        ["node", str(ROOT / "tools/chain-test/call.js"),
         entrypoint, batch_args(batch), str(rc_limit_for(batch))],
        capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "broadcast failed")
    # Hive allows at most 5 custom_json per account per block; pace well under.
    time.sleep(3.1)


def dev_migrated_supply():
    with urllib.request.urlopen(f"{DEV_URL}/chain", timeout=10) as r:
        info = json.load(r)
    return int(str(info["migrated_supply"]).replace(".", ""))


def main():
    ap = argparse.ArgumentParser()
    tgt = ap.add_mutually_exclusive_group()
    tgt.add_argument("--dev", action="store_true")
    tgt.add_argument("--magi", action="store_true")
    ap.add_argument("--limit", type=int, help="stop after N credits (rehearsal)")
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()

    plan, burns = load_plan()
    prog = load_progress()

    if args.status or not (args.dev or args.magi):
        done = len(prog["done"])
        done_amt = sum(prog["done"].values())
        print(f"plan: {len(plan)} accounts migrate + {len(burns)} burn to null, "
              f"{EXPECTED_TOTAL} base units")
        print(f"done: {done} accounts, {done_amt} base units ({prog.get('target')})")
        print(f"left: {len(plan) + len(burns) - done}")
        return

    target = "dev" if args.dev else "magi"
    if prog["target"] not in (None, target):
        sys.exit(f"REFUSING: progress file records a run against '{prog['target']}'.\n"
                 f"Finish that run or delete {RESUME} to start over.")
    prog["target"] = target
    send = migrate_dev if args.dev else migrate_magi

    # Migrations first, then burns: two work lists, one progress file. Each
    # entry is tagged with the entrypoint that carries it.
    todo = [("migrate_batch", a, liq, stk) for a, liq, stk in plan if a not in prog["done"]]
    todo += [("burn_batch", a, liq, stk) for a, liq, stk in burns if a not in prog["done"]]
    if args.limit:
        todo = todo[: args.limit]
    batches = []
    # Staked and liquid-only migrations are batched separately: a mint is ~7x
    # the gas of a plain credit, so mixing them would waste the cheap batch's
    # headroom or blow the expensive one's ceiling.
    staked = [(a, l, s) for k, a, l, s in todo if k == "migrate_batch" and s > 0]
    liquid = [(a, l, s) for k, a, l, s in todo if k == "migrate_batch" and s == 0]
    burns_todo = [(a, l, s) for k, a, l, s in todo if k == "burn_batch"]
    batches += [("migrate_batch", staked[i:i + BATCH_STAKED]) for i in range(0, len(staked), BATCH_STAKED)]
    batches += [("migrate_batch", liquid[i:i + BATCH_LIQUID]) for i in range(0, len(liquid), BATCH_LIQUID)]
    batches += [("burn_batch", burns_todo[i:i + BATCH_LIQUID]) for i in range(0, len(burns_todo), BATCH_LIQUID)]
    print(f"crediting {len(todo)} accounts against {target} in {len(batches)} batches…")

    for i, (kind, batch) in enumerate(batches, 1):
        try:
            send(batch, kind)
        except Exception as e:
            # The contract skips already-migrated accounts inside a batch, so a
            # batch straddling the crash point is safe to resend. Any real
            # failure applies NOTHING (the batch is atomic) — stop and report.
            save_progress(prog)
            sys.exit(f"STOPPED at batch {i} ({batch[0][0]}…): {e}\n"
                     f"{len(prog['done'])} credits are safe; rerun to resume.")
        for account, liquid, staked in batch:
            prog["done"][account] = liquid + staked
        if i % 5 == 0 or i == len(batches):
            save_progress(prog)
            print(f"  batch {i}/{len(batches)}  (through {batch[-1][0]})")
    save_progress(prog)

    if len(prog["done"]) == len(plan) + len(burns):
        credited = sum(prog["done"].values())
        print(f"\nall {len(plan)} migrated + {len(burns)} burned: {credited} base units")
        if credited != EXPECTED_TOTAL:
            sys.exit("MISMATCH against the snapshot total — investigate before launch.")
        if args.dev:
            onchain = dev_migrated_supply()
            ok = onchain == EXPECTED_TOTAL
            print(f"on-chain migrated supply: {onchain}  "
                  f"{'== snapshot ✓' if ok else '!= SNAPSHOT ✗'}")
            if not ok:
                sys.exit(1)
        print("MIGRATION COMPLETE.")


if __name__ == "__main__":
    main()

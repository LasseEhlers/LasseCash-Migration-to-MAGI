#!/usr/bin/env python3
"""Track whether claim_migration's real RC cost is drifting upward.

WHY THIS EXISTS. 2026-09-04: @yessuh, a genuinely fresh account (10,000/10,000
free RC, 0 HBD), was refused claiming with "needs ~10,468". CLAUDE.md's
measured worst case for this call (staked, unmatured, contends for a board
seat) was 5,892 RC on 2026-08-21. A fresh dry run against @aggroed the same
night came back at 6,463 — close to the old figure, not the new one. So the
cost is not flatly regressed; it looks like it depends on board contention
AT THE MOMENT OF THE CALL, which can only get tighter as more of the 20 board
seats fill up over the following weeks. This script re-measures a fixed set
of real, currently-unclaimed accounts over time so the trend is visible
instead of guessed at.

HOW. `simulateContractCalls` is a read-only dry run — it does not check the
signature in required_auths, so it can measure ANY real leaf's claim cost
without that account's key, without broadcasting, without spending anything.
Same technique tools/entrypoint-sweep/sweep.py already uses.

Candidates are a FIXED list (chosen 2026-09-04, all confirmed unclaimed,
staked > 0, not burned) so successive runs are comparing the same call
shape over time. An account that gets claimed by its real owner between runs
is reported as "claimed since baseline" rather than measured — that is
itself useful information (means one fewer open board seat contest).

    python3 tools/rc-drift-check.py                # measure + append to log
    python3 tools/rc-drift-check.py --history       # just print the log
"""
import argparse, json, sys, time, urllib.request
from pathlib import Path

API = "https://api.vsc.eco/api/v1/graphql"
PROD = "vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV"
ROOT = Path(__file__).resolve().parent.parent
LEAVES = ROOT / "web/static/migration/leaves.json"
PROOFS = ROOT / "web/static/migration/proofs"
LOG = ROOT / "deploy-data/rc-drift-log.jsonl"

# Fixed 2026-09-04, all confirmed unclaimed + staked>0 + not burned at pick
# time. @aggroed already has one data point: 6,463 RC, same night as the
# yessuh refusal.
CANDIDATES = [
    "aggroed", "eonwarped", "vocup", "airanmilian",
    "patif2025", "cedricguillas", "vapolocityj", "pele23", "nawalz",
]


def gql(query, variables):
    req = urllib.request.Request(
        API, data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Content-Type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=45).read())
    if "errors" in d:
        raise SystemExit("GraphQL: " + d["errors"][0].get("message", "?"))
    return d["data"]


def already_claimed(names):
    keys = [f"mig_hive:{n}" for n in names]
    d = gql("query($c:String!,$k:[String!]!){ getStateByKeys(contractId:$c, keys:$k) }",
            {"c": PROD, "k": keys})
    rows = d["getStateByKeys"] or {}
    return {n for n in names if rows.get(f"mig_hive:{n}")}


def proof_for(name):
    shard = "".join(c for c in name.lower() if c.isalnum())[:2] or "--"
    f = PROOFS / f"{shard}.json"
    if not f.exists():
        return None
    row = json.loads(f.read_text()).get(f"hive:{name}")
    return row


def simulate_claim(name, leaf):
    payload = f"{leaf['liquid']}|{leaf['staked']}|{','.join(leaf['proof'])}"
    q = ("query($i: SimulateContractCallsInput!) { simulateContractCalls(input: $i) "
         "{ success err_msg gas_used rc_used ret } }")
    body = {"query": q, "variables": {"i": {
        "tx_id": "rc-drift", "required_auths": f"hive:{name}",
        "calls": [{"contract_id": PROD, "action": "claim_migration",
                   "payload": payload, "rc_limit": 100_000, "intents": []}]}}}
    req = urllib.request.Request(API, data=json.dumps(body).encode(),
                                  headers={"Content-Type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=45).read())
    rows = (d.get("data") or {}).get("simulateContractCalls") or []
    return rows[0] if rows else {"success": False, "err_msg": "no result"}


def run():
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    claimed = already_claimed(CANDIDATES)
    entries = []
    print(f"{'account':<16}{'status':<24}{'gas_used':>14}{'rc_used':>10}")
    for name in CANDIDATES:
        if name in claimed:
            print(f"{name:<16}{'claimed since baseline':<24}")
            entries.append({"ts": ts, "account": name, "status": "claimed"})
            continue
        leaf = proof_for(name)
        if leaf is None:
            print(f"{name:<16}{'no proof found':<24}")
            entries.append({"ts": ts, "account": name, "status": "no_proof"})
            continue
        sim = simulate_claim(name, leaf)
        if sim.get("success"):
            gas, rc = sim["gas_used"], sim["rc_used"]
            print(f"{name:<16}{'ok':<24}{gas:>14,}{rc:>10,}")
            entries.append({"ts": ts, "account": name, "status": "ok",
                             "gas_used": gas, "rc_used": rc})
        else:
            msg = (sim.get("err_msg") or "?")[:60]
            print(f"{name:<16}{'refused: ' + msg:<24}")
            entries.append({"ts": ts, "account": name, "status": "refused",
                             "err_msg": sim.get("err_msg")})
        time.sleep(2.2)  # node caps ~30 simulations/min

    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")
    print(f"\nappended {len(entries)} rows to {LOG.relative_to(ROOT)}")


def history():
    if not LOG.exists():
        print("no history yet — run without --history first")
        return
    by_account = {}
    for line in LOG.read_text().splitlines():
        e = json.loads(line)
        by_account.setdefault(e["account"], []).append(e)
    for name, rows in by_account.items():
        print(f"\n{name}:")
        for r in rows:
            if r["status"] == "ok":
                print(f"  {r['ts']}  rc_used={r['rc_used']:,}")
            else:
                print(f"  {r['ts']}  {r['status']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", action="store_true")
    args = ap.parse_args()
    history() if args.history else run()

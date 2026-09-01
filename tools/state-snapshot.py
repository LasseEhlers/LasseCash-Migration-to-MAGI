#!/usr/bin/env python3
"""Snapshot a MAGI contract's public state, and diff two snapshots.

WHY THIS EXISTS. The genesis post tells people a contract update preserves
state. That is what MAGI's source says, and until now nobody has tested it.
Before the production contract is updated, the claim gets proven on a
throwaway: snapshot, update, snapshot again, diff.

The diff must be MECHANICAL. Reading two lists of hex figures by eye is how
you miss the one key that moved, and the whole point is to catch exactly that.

  python3 tools/state-snapshot.py grab <contract_id> before.json
  python3 tools/state-snapshot.py diff before.json after.json

Keys that legitimately move between two reads of a LIVE contract — the accrual
cursor and anything emission touches — are reported separately from keys that
must not move at all. A balance changing across an update is a failure; the
settled height changing is just time passing.
"""
import json, sys, urllib.request

API = "https://api.vsc.eco/api/v1/graphql"

# getStateByKeys refuses a request outside 1..100 keys.
BATCH = 90

CONFIG = ["cfg_init", "cfg_genesis", "cfg_settled", "cfg_migroot",
          "cfg_migtotal", "cfg_burntotal"]
SUPPLY = ["sup_migrated", "sup_claimed", "sup_emitted", "shr_total"]
POOLS  = ["pool_lshare", "pool_viral", "pool_deep", "pool_liq"]
AMM    = ["amm_lc", "amm_hbd", "amm_acc", "amm_accheld", "amm_accseen"]
ACCR   = ["acc_day", "acc_val", "acc_held"]
MISC   = ["gov_board", "rsh_viral", "rsh_deep"]
PER_ACCOUNT = ["bal_", "shr_", "mig_", "mnt_", "mntn_", "pend_", "dur_"]

# An update is instant relative to the chain, but not atomic with it: the two
# reads straddle real blocks, so anything driven by HEIGHT is expected to move.
# Everything else is load-bearing and must be byte-identical.
EXPECTED_TO_MOVE = {"cfg_settled", "acc_day", "acc_val", "acc_held",
                    "sup_emitted", "pool_lshare", "pool_viral", "pool_deep",
                    "pool_liq"}


def gql(query, variables):
    req = urllib.request.Request(
        API, data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Content-Type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if "errors" in d:
        raise SystemExit("GraphQL: " + d["errors"][0].get("message", "?"))
    return d["data"]


def read_keys(contract, keys):
    out = {}
    for i in range(0, len(keys), BATCH):
        d = gql("query($c:String!,$k:[String!]!){ getStateByKeys(contractId:$c, keys:$k) }",
                {"c": contract, "k": keys[i:i + BATCH]})
        out.update(d["getStateByKeys"] or {})
    return {k: v for k, v in out.items() if v not in (None, "")}


def grab(contract, path):
    state = read_keys(contract, CONFIG + SUPPLY + POOLS + AMM + ACCR + MISC)

    # The contract cannot enumerate accounts and neither can we, so the board
    # is the seed: it holds every account with shares, which is every account
    # that matters for an ABI check. Extra names cost one read each.
    accounts = set(a for a in (state.get("gov_board") or "").split("|") if a)
    accounts |= {"hive:lasseehlers", "hive:lassecashmagi", "hive:angeloextreme",
                 "hive:null", "hive:tibfox"}
    per = [p + a for a in sorted(accounts) for p in PER_ACCOUNT]
    state.update(read_keys(contract, per))

    head = gql("query{ localNodeInfo{ last_processed_block } }", {})
    snap = {"contract": contract,
            "head": head["localNodeInfo"]["last_processed_block"],
            "state": state}
    with open(path, "w") as f:
        json.dump(snap, f, indent=1, sort_keys=True)
    print(f"{contract}\nhead {snap['head']:,}   {len(state)} non-empty keys -> {path}")


def diff(a_path, b_path):
    a, b = (json.load(open(p)) for p in (a_path, b_path))
    if a["contract"] != b["contract"]:
        raise SystemExit(f"different contracts: {a['contract']} vs {b['contract']}")
    A, B = a["state"], b["state"]

    moved, vanished, appeared, expected = [], [], [], []
    for k in sorted(set(A) | set(B)):
        if k not in B:
            vanished.append(k)
        elif k not in A:
            appeared.append((k, B[k]))
        elif A[k] != B[k]:
            (expected if k in EXPECTED_TO_MOVE else moved).append((k, A[k], B[k]))

    print(f"{a['contract']}")
    print(f"head {a['head']:,} -> {b['head']:,}  ({b['head'] - a['head']:,} blocks)")
    print(f"{len(A)} keys before, {len(B)} after\n")

    if expected:
        print(f"MOVED, and should have ({len(expected)} — height-driven):")
        for k, x, y in expected:
            print(f"   {k:28}{x}  ->  {y}")
        print()

    ok = not (moved or vanished)
    if vanished:
        print(f"!! LOST {len(vanished)} KEYS — state did NOT survive:")
        for k in vanished:
            print(f"   {k:28}was {A[k]}")
        print()
    if moved:
        print(f"!! {len(moved)} KEYS CHANGED THAT MUST NOT:")
        for k, x, y in moved:
            print(f"   {k:28}{x}  ->  {y}")
        print()
    if appeared:
        print(f"new keys ({len(appeared)}) — expected if the update added state:")
        for k, v in appeared:
            print(f"   {k:28}{v[:60]}")
        print()

    print("PASS — every load-bearing key survived byte-identical." if ok
          else "FAIL — see above.")
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "grab":
        grab(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == "diff":
        sys.exit(diff(sys.argv[2], sys.argv[3]))
    else:
        raise SystemExit(__doc__)

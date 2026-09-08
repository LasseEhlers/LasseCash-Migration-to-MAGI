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
ACCR   = ["acc_day", "acc_per", "acc_held"]  # acc_per is the accumulator; "acc_val" never existed
MISC   = ["gov_board", "rsh_viral", "rsh_deep"]
# "mnt_"/"mntn_"/"dur_" were GUESSES and match nothing — the real prefixes are
# below (see contract/state/keys.go). They cost one dead read each and, worse,
# made the snapshot look like it covered mints when it did not.
PER_ACCOUNT = ["bal_", "shr_", "mig_", "mseq_", "pend_"]
# The mint length an account chose in settings: "set_<acct>_days", so it is a
# suffix key and cannot go in the prefix list above.
PER_ACCOUNT_SUFFIX = [("set_", "_days")]
# Mint records are "mint_<acct>_<id>" with ids allocated from mseq_<acct>.
# They hold PRINCIPAL — the largest value in the contract after balances — so a
# snapshot that skips them cannot claim an update preserved state.
MAX_MINTS_PER_ACCOUNT = 40

# An update is instant relative to the chain, but not atomic with it: the two
# reads straddle real blocks, so anything driven by HEIGHT is expected to move.
# Everything else is load-bearing and must be byte-identical.
EXPECTED_TO_MOVE = {"cfg_settled", "acc_day", "acc_per", "acc_held",
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
    # Never cover LESS than a previous snapshot: union in every account any
    # earlier file asked about, so the comparison set only ever grows.
    for prev in sys.argv[3:]:
        try:
            accounts |= set(json.load(open(prev)).get("accounts") or [])
        except Exception:
            pass
    per = [p + a for a in sorted(accounts) for p in PER_ACCOUNT]
    per += [p + a + suf for a in sorted(accounts) for p, suf in PER_ACCOUNT_SUFFIX]
    state.update(read_keys(contract, per))

    # Now the mint records themselves. mseq_<acct> is the next id to allocate,
    # so ids 1..mseq cover every mint the account has ever had, settled ones
    # included — and a settled mint's key stays retired, so reading it back is
    # how you notice one reappearing.
    mint_keys = []
    for a in sorted(accounts):
        seq = state.get("mseq_" + a)
        n = int(seq) if seq and seq.isdigit() else 0
        n = min(n, MAX_MINTS_PER_ACCOUNT)
        mint_keys += [f"mint_{a}_{i}" for i in range(1, n + 1)]
    if mint_keys:
        state.update(read_keys(contract, mint_keys))

    head = gql("query{ localNodeInfo{ last_processed_block } }", {})
    snap = {"contract": contract,
            "head": head["localNodeInfo"]["last_processed_block"],
            # WHICH accounts were asked about. The board ROTATES as people
            # claim, so two snapshots taken days apart do not cover the same
            # set — on 2026-09-08 five accounts fell off the board and the
            # diff reported 25 keys "LOST" that were on chain the whole time,
            # on the most important verification in the project.
            "accounts": sorted(accounts),
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
    # A key missing from the newer snapshot usually means it was never ASKED
    # for (the account list moved), not that the chain dropped it. Re-read the
    # candidates live and only report the ones genuinely gone.
    maybe = [k for k in A if k not in B]
    if maybe:
        live = {}
        for i in range(0, len(maybe), BATCH):
            live.update(read_keys(b["contract"], maybe[i:i + BATCH]))
        still = [k for k in maybe if live.get(k) == A[k]]
        if still:
            print(f"NOT asked for in the newer snapshot, but READ BACK LIVE and "
                  f"unchanged ({len(still)}) — not a loss:")
            for k in still[:8]:
                print(f"   {k}")
            if len(still) > 8:
                print(f"   ... and {len(still) - 8} more")
            print()
        B = dict(B)
        B.update({k: v for k, v in live.items() if k in maybe})
    for k in sorted(set(A) | set(B)):
        if k not in B:
            vanished.append(k)
        elif k not in A:
            appeared.append((k, B[k]))
        elif A[k] != B[k]:
            (expected if k in EXPECTED_TO_MOVE else moved).append((k, A[k], B[k]))

    print(f"{a['contract']}")
    print(f"head {a['head']:,} -> {b['head']:,}  ({b['head'] - a['head']:,} blocks)")
    print(f"{len(A)} keys before, {len(B)} after")
    try:
        txs = gql("query($c:String!,$o:Int!){findTransaction(filterOptions:"
                  "{byContract:$c,limit:100,offset:$o}){anchr_height}}",
                  {"c": a["contract"], "o": 0}).get("findTransaction") or []
        n = sum(1 for t in txs
                if a["head"] <= (t.get("anchr_height") or 0) <= b["head"])
        if n:
            print(f"⚠️  {n}+ transactions hit the contract between these two reads. "
                  f"On a LIVE chain the diff shows USER ACTIVITY as well as any "
                  f"update effect — attribute every change below to a transaction "
                  f"before calling it a fault.")
    except Exception:
        pass
    print()

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

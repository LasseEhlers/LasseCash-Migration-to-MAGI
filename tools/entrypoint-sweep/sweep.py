#!/usr/bin/env python3
"""Exercise EVERY entrypoint against a deployed contract, without broadcasting.

WHY. `simulateContractCalls` executes the deployed WASM and returns
success / err_msg / gas_used / rc_used. No HBD, no RC, no wallet, no state
change. It is the cheapest possible test and it has already earned its keep
once: it is how the empty-vs-nil bug was found, the one that made a deployed
contract permanently impossible to initialise.

WHAT A PASS MEANS, and it is narrower than it looks. A call that comes back
with a SENSIBLE refusal has proven it parsed its arguments, reached its
validation and answered — which is exactly what `init` failed to do on the
bricked deploy. A call that aborts with a usage string, or returns an error
that names nothing, is the interesting result.

So the expected outcome for most rows is a REFUSAL, not a success: this runs
as an account that mostly cannot afford what it is asking for. What matters is
that the refusal is the RIGHT one.

⚠️ THE GAS COLUMN ON A REFUSED ROW IS THE REJECTION COST, NOT THE REAL ONE.
A call that aborts at a bounds check never does the work. Measured 2026-09-02:
set_param with an out-of-bounds value returned in 183,452 gas (1.8 RC), while
the SAME call with a valid value costs 121,742,220 gas (1,217 RC) — 670x more.
The client's RC floor had been set from the cheap figure and every real
threshold change failed with gas_limit_hit.

So never size an RC limit from this table. Measure the SUCCEEDING path
separately, with arguments the contract will accept.

    python3 tools/entrypoint-sweep/sweep.py                       # production
    python3 tools/entrypoint-sweep/sweep.py --contract vsc1B...   # a throwaway
"""
import argparse
import json
import sys
import time
import urllib.request

API = "https://api.vsc.eco/api/v1/graphql"
# MEASURED 2026-09-01: the node answers "rate limit exceeded: max 30
# simulation requests per minute". A full sweep is 33 calls, so it must pace
# itself or the tail of the table reports transport errors that look like
# broken entrypoints.
PACE_SECONDS = 2.2
PROD = "vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV"

# One representative call per entrypoint, with the refusal we EXPECT. A None
# expectation means "anything sensible"; the point is that it answers at all.
#
# Amounts are deliberately absurd where a success would move real value — this
# never broadcasts, but a simulation that "succeeds" at spending someone's
# balance is a worse thing to read than a clean refusal.
CALLS = [
    # genesis — must refuse, the contract is long since initialised
    ("init",             "109512118",                         "owner only"),
    ("set_snapshot",     "deadbeef|1|1",                      None),
    # money
    # Run as a FUNDED account, so these succeed — that is the correct answer,
    # and a refusal here would mean the money paths had broken.
    ("transfer",         "hive:nobody|100000000",             "transferred"),
    # THE BARE NAME. Answers "transferred" on the live contract today, which is
    # the bug; after the update it must answer with a refusal naming the
    # address. This row is the whole reason the sweep is worth re-running.
    ("transfer",         "nobody|100000000",                  "transferred"),
    ("burn",             "100000000",                         "burned"),
    # Absent until the update lands: "wasm function not found" is the CONTROL
    # that proves this sweep can see an entrypoint appear.
    ("fund",             "pob|100000000",                     "not found"),
    # mints
    ("mint",             "100000000|30",                      "minted"),
    ("claim_mint",       "9999",                              "no such mint"),
    ("good_accounting",  "9999",                              "no such mint"),
    ("set_duration",     "365",                               None),
    ("sweep_mint",       "hive:nobody|1",                     "no such mint"),
    ("settle",           "",                                  None),
    ("settle_pending",   "",                                  None),
    ("advance",          "1",                                 None),
    # migration
    ("claim_migration",  "1|1|deadbeef",                      None),
    ("record_burn",      "hive:nobody|1|1|deadbeef",          None),
    ("sweep_unclaimed",  "",                                  None),
    # media
    ("post",             "a-test-permlink|0|0",               None),
    ("comment",          "a-reply|hive:nobody|nothing|0",     None),
    ("vote",             "hive:nobody|nothing|100",           None),
    ("payout",           "hive:nobody|nothing",               "no such post"),
    ("claim_curation",   "hive:nobody|nothing",               "no such post"),
    ("sweep_curation",   "hive:nobody|nothing",               "no such post"),
    ("promote_post",     "hive:nobody|nothing|100000000",     None),
    # pool
    # No intent is attached by a simulation, so the HBD draw cannot be
    # authorised — the right refusal, and it proves the intent check runs.
    ("add_liquidity",    "100000000|100000000",               "no caller intent"),
    ("remove_liquidity", "9999",                              "no such"),
    ("claim_pool",       "9999",                              "no open tranche"),
    ("sweep_tranche",    "hive:nobody|1",                     "no open tranche"),
    ("swap_lc_hbd",      "100000000|1",                       "swapped"),
    ("swap_hbd_lc",      "100000000|1",                       "no caller intent"),
    # governance
    # VALID on purpose: an out-of-bounds value aborts early and measures
    # nothing. 1,000 L-Shares is the current default, so this is a no-op that
    # still walks the whole path.
    ("set_param",        "post.threshold_viral|100000000000",  "ok"),
    ("promote",          "hive:nobody",                       None),
    # and one that must NOT exist
    ("no_such_entry",    "",                                  "not found"),
]


def simulate(contract, account, action, payload):
    q = ("query($i: SimulateContractCallsInput!) { simulateContractCalls(input: $i) "
         "{ success err_msg gas_used rc_used ret } }")
    body = {"query": q, "variables": {"i": {
        "tx_id": "sweep", "required_auths": f"hive:{account}",
        "calls": [{"contract_id": contract, "action": action,
                   "payload": payload, "rc_limit": 100_000, "intents": []}]}}}
    req = urllib.request.Request(API, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=45).read())
    except Exception as e:
        return {"_transport": str(e)[:90]}
    if "errors" in d:
        return {"_transport": d["errors"][0].get("message", "?")[:90]}
    rows = (d.get("data") or {}).get("simulateContractCalls") or []
    return rows[0] if rows else {"_transport": "no result"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", default=PROD)
    ap.add_argument("--account", default="lasseehlers")
    args = ap.parse_args()

    print(f"contract {args.contract}\nas       hive:{args.account}")
    print(f"{len(CALLS)} calls, none broadcast\n")
    print(f"{'entrypoint':<18}{'gas':>12}  result")

    odd = []
    for i, (action, payload, expect) in enumerate(CALLS):
        if i:
            time.sleep(PACE_SECONDS)
        r = simulate(args.contract, args.account, action, payload)
        if "_transport" in r:
            print(f"{action:<18}{'-':>12}  TRANSPORT: {r['_transport']}")
            odd.append((action, r["_transport"]))
            continue
        msg = (r.get("err_msg") or r.get("ret") or "").strip()
        gas = r.get("gas_used") or 0
        mark = "ok  " if r.get("success") else "    "
        note = ""
        if expect and expect.lower() not in msg.lower():
            note = f"   <- expected something like {expect!r}"
            odd.append((action, msg))
        print(f"{action:<18}{gas:>12,}  {mark}{msg[:60]}{note}")

    print()
    if odd:
        print(f"{len(odd)} row(s) worth a look:")
        for a, m in odd:
            print(f"   {a}: {m[:80]}")
    else:
        print("every entrypoint parsed its arguments and answered.")


if __name__ == "__main__":
    main()

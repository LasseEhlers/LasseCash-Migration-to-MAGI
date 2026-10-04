#!/usr/bin/env python3
"""What each action costs in MAGI credits — measured, and compared with what
the site tells people.

WHY. Every button dry-runs its own call, so a CLICK is always sized right.
What goes stale is the TEXT around it: the Start page's "a mint about 6,000",
the low-credits banner's threshold, the holding tiers. On 2026-10-04 a mint
was found to cost ~5,850 while the site still said 2,500-3,500 — the token
handover had doubled it a month earlier and nothing noticed.

WHAT. Simulates the common actions on PRODUCTION as a reference account and
compares each with PUBLISHED below. Read-only: `simulateContractCalls` costs
no RC, no HBD, broadcasts nothing, needs no key. Exit 1 if any measured cost
drifts more than TOLERANCE from what the site says — the text needs updating.
An action that cannot be measured (the reference account lacks the balance,
no open post to vote on) is reported as SKIP, never as a failure.

WHEN A CHECK FAILS: update PUBLISHED here AND every text that quotes the
figure — web/src/routes/start/+page.svelte ("For scale"), RcNote.svelte (LOW
and its comment), CLAUDE.md ("A MINT COSTS …").

    python3 tools/rc-watch.py            # default account hive:lasseehlers
    RC_WATCH_ACCOUNT=hive:alice python3 tools/rc-watch.py
"""
import json
import os
import sys
import urllib.request

CORE = "vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV"
TOKEN = "vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h"
NODES = ["https://api.okinoko.io/api/v1/graphql", "https://vsc.techcoderx.com/api/v1/graphql",
         "https://api.vsc.eco/api/v1/graphql"]
WHO = os.environ.get("RC_WATCH_ACCOUNT", "hive:lasseehlers")
TOLERANCE = 0.25

# The figures the site publishes, total credits per action (allowance included
# where the action needs one). Measured on production 2026-10-04.
PUBLISHED = {
    "vote": 1_070,
    "post": 1_750,
    "sell": 1_220,
    "buy": 520,
    "send": 2_930,
    "add_liquidity": 2_800,
    "mint": 5_850,
}


def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    last = None
    for node in NODES:
        try:
            req = urllib.request.Request(node, body, {"content-type": "application/json",
                                                      "user-agent": "lassecash-rc-watch"})
            out = json.loads(urllib.request.urlopen(req, timeout=40).read())
            if out.get("errors"):
                raise RuntimeError(out["errors"][0].get("message"))
            return out["data"]
        except Exception as e:  # next node
            last = e
    raise RuntimeError(f"no MAGI node answered: {last}")


def simulate(calls):
    q = ("query($i:SimulateContractCallsInput!){simulateContractCalls(input:$i)"
         "{success err_msg rc_used}}")
    return gql(q, {"i": {"tx_id": "rc-watch", "required_auths": WHO, "calls": calls}})["simulateContractCalls"]


def call(action, payload, rc=30_000, intents=None):
    return {"contract_id": CORE, "action": action, "payload": payload, "rc_limit": rc, "intents": intents or []}


def allowance(units):
    return {"contract_id": TOKEN, "action": "increaseAllowance", "rc_limit": 2_000, "intents": [],
            "payload": json.dumps({"spender": "contract:" + CORE, "amount": str(units)})}


def hbd(limit):
    return [{"type": "transfer.allow", "args": {"token": "hbd", "limit": limit}}]


def open_post():
    """A registered post still inside its window: newest `post` calls first."""
    d = gql('{findTransaction(filterOptions:{byContract:"%s",limit:100})'
            '{status required_auths required_posting_auths ops{data}}}' % CORE)
    for t in d["findTransaction"] or []:
        if t["status"] != "CONFIRMED":
            continue
        author = (t["required_posting_auths"] or t["required_auths"] or [None])[0]
        for op in t["ops"]:
            data = op.get("data") or {}
            if data.get("action") == "post" and author:
                yield f'{author}|{data["payload"].split("|")[0]}'


def measure():
    LC = 100_000_000  # one LASSECASH in base units
    out = {}
    plans = {
        # HBD-drawing calls probe at a LOW rc_limit: a high one reserves HBD
        # out of the balance and refuses the draw (CLAUDE.md, the @daneamanda wall).
        "buy": [call("swap_hbd_lassecash", "10000000|1", 3_000, hbd("0.100"))],
        "sell": [allowance(100 * LC), call("swap_lassecash_hbd", f"{100 * LC}|1")],
        "send": [allowance(LC), call("transfer", f"hive:lassecashmagi|{LC}")],
        "add_liquidity": [allowance(1_000 * LC), call("add_liquidity", f"{1_000 * LC}|200000000", 3_000, hbd("2.000"))],
        "mint": [allowance(10_000 * LC), call("mint", f"{10_000 * LC}|1095")],
        "post": [call("post", "rc-watch-probe-not-a-real-post|0|0")],
    }
    for name, calls in plans.items():
        r = simulate(calls)
        out[name] = (sum(x["rc_used"] or 0 for x in r), all(x["success"] for x in r),
                     next((x["err_msg"] for x in r if not x["success"]), ""))
    out["vote"] = (0, False, "no open post found")
    for target in list(open_post())[:8]:
        r = simulate([call("vote", f"{target}|10")])
        if r[0]["success"]:
            out["vote"] = (r[0]["rc_used"], True, "")
            break
        out["vote"] = (0, False, (r[0]["err_msg"] or "")[:60])
    return out


def main():
    failed = 0
    print(f"MAGI credits per action, measured as {WHO} on {CORE}\n")
    for name, (rc, ok, err) in measure().items():
        want = PUBLISHED[name]
        if not ok:
            print(f"SKIP  {name:14} could not measure: {(err or '').splitlines()[0][:70]}")
            continue
        drift = (rc - want) / want
        verdict = "PASS" if abs(drift) <= TOLERANCE else "FAIL"
        failed += verdict == "FAIL"
        print(f"{verdict}  {name:14} {rc:>6,} measured vs {want:>6,} published ({drift:+.0%})")
    print("\nALL FIGURES CURRENT" if not failed else
          f"\n{failed} FIGURE(S) DRIFTED — update PUBLISHED and the texts listed at the top of this file")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

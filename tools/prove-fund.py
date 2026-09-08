#!/usr/bin/env python3
"""Prove one `fund` call did exactly what it should, from two independent
witnesses: the core's pool balances (contract state) and MAGI's OWN indexer
(the token side, which the core does not control).

  python3 tools/prove-fund.py before            # snapshot pools + funder's token balance
  ...fund on lassecash.com/rewards...
  python3 tools/prove-fund.py after <target> <amount>

Pass: the named pool rose by exactly <amount>; the funder's token balance,
as MAGI's indexer reports it, fell by exactly <amount>; nothing else moved
beyond emission. For target "all", the four pools rise by the block split
(12.5/37.5/25/25 %) and sum to the amount to the base unit.
"""
import json, sys, urllib.request
API = "https://api.vsc.eco/api/v1/graphql"
IDX = "https://indexer.magi.milohpr.com/v1/graphql"
C = "vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV"
TOK = "vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h"
FUNDER = "hive:lasseehlers"
POOLS = {"viral": "pool_viral", "deep": "pool_deep", "lshare": "pool_lshare", "liquidity": "pool_liq"}
SNAP = "/tmp/claude-1000/-home-lasseehlers-LasseCash-Migration-to-MAGI/937c42bb-40d7-4e3a-8f83-c0391e9d353f/scratchpad/fund-before.json"

def gql(url, q, v=None):
    r = urllib.request.Request(url, data=json.dumps({"query": q, "variables": v or {}}).encode(),
                               headers={"content-type": "application/json", "user-agent": "lassecash/1.0"})
    return json.loads(urllib.request.urlopen(r, timeout=45).read())["data"]

def read():
    st = gql(API, 'query($c:String!,$k:[String!]!){getStateByKeys(contractId:$c,keys:$k)}',
             {"c": C, "k": list(POOLS.values()) + ["sup_emitted"]})["getStateByKeys"]
    tok = gql(IDX, 'query($c:String!,$a:String!){magi_token_balances(where:{contract_id:{_eq:$c},account:{_eq:$a}}){balance}}',
              {"c": TOK, "a": FUNDER})["magi_token_balances"]
    return {"pools": {k: int(st[v] or 0) for k, v in POOLS.items()},
            "emitted": int(st["sup_emitted"] or 0),
            "funder_token": int(tok[0]["balance"]) if tok else 0}

if sys.argv[1:2] == ["before"]:
    json.dump(read(), open(SNAP, "w")); print("snapshot taken"); sys.exit()
target, amount = sys.argv[2], int(round(float(sys.argv[3]) * 1e8))
b = json.load(open(SNAP)); a = read()
emit = a["emitted"] - b["emitted"]
print(f"emission between the two reads: {emit/1e8:,.8f} (split 12.5/37.5/25/25 into the pools)\n")
split = {"viral": 0.125, "deep": 0.375, "lshare": 0.25, "liquidity": 0.25}
ok = True
for k in POOLS:
    d = a["pools"][k] - b["pools"][k]
    from_emission = int(emit * split[k])
    from_fund = d - from_emission
    want = amount if target == k else (int(amount * split[k]) if target == "all" else 0)
    slack = 2 if target == "all" and k == "lshare" else 0  # L-Share absorbs rounding
    good = abs(from_fund - want) <= slack + 1
    ok &= good
    print(f"  {k:<10} +{d/1e8:>14,.8f}  of which fund ≈ {from_fund/1e8:>12,.8f}  want {want/1e8:>12,.8f}  {'OK' if good else 'MISMATCH'}")
dt = b["funder_token"] - a["funder_token"]
print(f"\n  funder's token balance per MAGI's indexer: -{dt/1e8:,.8f}   want {amount/1e8:,.8f}  {'OK' if dt == amount else 'MISMATCH'}")
ok &= dt == amount
print("\nPASS — pool credited and token debited by the same amount, witnessed by two independent readers." if ok else "\nFAIL — see above.")

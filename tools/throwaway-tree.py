#!/usr/bin/env python3
"""A tiny migration tree for a THROWAWAY deploy.

Mirrors engine/merkle.go exactly — leaf domain, sorted-pair parents, odd node
promoted unchanged — so proofs built here verify against the deployed
contract. Only ever used for test contracts: the production root comes from
`./build.sh tree` over the real snapshot and must never come from this file.

  python3 tools/throwaway-tree.py            # prints root, totals and proofs
"""
import hashlib, json, sys

LEAF_DOMAIN = b"lassecash-migration-leaf-v1|"

# The throwaway's whole world. Two accounts we can sign for from the command
# line (their keys are in deploy-data/config/), so the arc can be driven
# without a wallet: one claims mid-bleed, one never claims and is swept.
ACCOUNTS = [
    # account,               liquid,        staked,       burned
    ("hive:lassecashmagi",   100_000_000,   1_000_000_000, False),   # 1 + 10 LASSECASH
    ("hive:lassecashdapps",  200_000_000,   2_000_000_000, False),   # 2 + 20, never claims
    ("hive:null",            0,             0,             True),
]

def sha(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()

def leaf_hash(acct: str, liquid: int, staked: int, burned: bool) -> bytes:
    kind = b"b" if burned else b"m"
    return sha(LEAF_DOMAIN + acct.encode() + b"|" + str(liquid).encode() + b"|" +
               str(staked).encode() + b"|" + kind)

def parent(a: bytes, b: bytes) -> bytes:
    return sha(a + b if a <= b else b + a)

def build(leaves):
    n = len(leaves)
    proofs = [[] for _ in range(n)]
    level, idx = list(leaves), list(range(n))
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                for j in range(n):
                    if idx[j] == i:
                        proofs[j].append(level[i + 1])
                    elif idx[j] == i + 1:
                        proofs[j].append(level[i])
                nxt.append(parent(level[i], level[i + 1]))
            else:
                nxt.append(level[i])  # promoted unchanged, never duplicated
        for j in range(n):
            idx[j] //= 2
        level = nxt
    return level[0], proofs

def main() -> int:
    leaves = [leaf_hash(*a) for a in ACCOUNTS]
    root, proofs = build(leaves)
    qualifier = sum(l + s for _, l, s, b in ACCOUNTS if not b)
    burn = sum(l + s for _, l, s, b in ACCOUNTS if b)
    out = {
        "root": root.hex(),
        "qualifier_total": qualifier,
        "burn_total": burn,
        "set_snapshot": f"{root.hex()}|{qualifier}|{burn}",
        "accounts": [
            {
                "account": a, "liquid": l, "staked": s, "burned": b,
                "proof": [h.hex() for h in p],
                "claim_migration": None if b else f"{l}|{s}|" + ",".join(h.hex() for h in p),
            }
            for (a, l, s, b), p in zip(ACCOUNTS, proofs)
        ],
    }
    print(json.dumps(out, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())

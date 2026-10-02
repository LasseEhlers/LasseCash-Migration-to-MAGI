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
# ⚠️ AMOUNTS RAISED 2026-09-30 for the sweep run (throwaway #13). The old
# figures (1 and 10 LASSECASH) could not register a post: `CreatePost` checks
# the author against the VIRAL threshold, 1,000 L-Shares by default, and a
# 10-share claim is refused. sweep_curation needs a real post, a real vote and
# a real payout before there is any curator pot to expire, so the claimer has
# to clear that bar. Still a throwaway tree — never the production root.
ACCOUNTS = [
    # account,               liquid,            staked,       burned
    # Throwaway #15 (2026-10-02): reproducing the FLOAT SHORTFALL and proving
    # `reconcile_float` fixes it. See docs/FLOAT-SHORTFALL.md.
    #
    # ⚠️ THE STAKE MUST BE BIG, and that is the whole design of this tree.
    # A migration mint's principal is only unbacked if it exceeds whatever
    # emission has since minted into the core's float. With genesis set 31
    # days back, emission alone puts ~283,000 LASSECASH there — so a small
    # stake would be quietly covered and the claim would SUCCEED, proving
    # nothing. That is exactly why production's small claims (andy4475,
    # cinqowy) worked while Lasse's 7,005,065 did not, and it is why the unit
    # test had to be rewritten from 9,000 to 7,000,000 before it failed.
    #
    # The signer is lassecashmagi: it owns the contract and holds the credits.
    ("hive:lassecashmagi",   100_000_000_000,   700_000_000_000_000, False),  # 1,000 liquid + 7,000,000 staked
    ("hive:lassecashdapps",  100_000_000,       0,                   False),  # unused second leaf
    ("hive:null",            0,                 0,                   True),
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

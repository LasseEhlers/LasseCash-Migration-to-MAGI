#!/usr/bin/env python3
"""Check the production contract's money invariants against the LIVE chain.

WHY THIS EXISTS, AND IT IS THE WHOLE POINT.

`auditSupply` has run inside every contract test since August. It has never
once run against production. On 8 September the token handover left 9.19M
LASSECASH of backing unminted, and that is exactly what `auditSupply` is for —
but in a test the token and the core are the SAME in-memory world, so the
invariant was comparing the books against themselves and finding them
consistent. They were. The gap only exists on a chain where the two are
genuinely separate contracts and one was adopted eight days after the other.

Nothing found it for 24 days. Then Lasse pressed Claim and the token said
`Insufficient balance`.

This script is the same invariant, asked of the real chain instead of a fake
one. Run hourly it would have gone red on 8 September, minutes after the
handover, instead of staying quiet until a user hit it.

    python3 tools/audit-production.py            # production
    python3 tools/audit-production.py --json     # for cron / a monitor
    CONTRACT_ID=… TOKEN_ID=… python3 tools/audit-production.py   # a throwaway

Exit status is 0 only if every check passes, so cron mails you on failure and
stays silent otherwise. Read-only: GraphQL queries and simulations, no RC, no
HBD, nothing broadcast.

⚠️ IT IS RED ON PURPOSE UNTIL `reconcile_float` ACTIVATES (Sun 4 Oct). The
shortfall is real and known; the check reporting it is the check working. When
it turns green on Sunday, that is the fix proven by an instrument that was
written before the fix landed and does not know anything about it.
"""
import json, os, sys, urllib.request

CORE  = os.environ.get("CONTRACT_ID", "vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV")
TOKEN = os.environ.get("TOKEN_ID",    "vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h")

# The 51M historic hardcap. It is enforced in Go on chain; no state key holds
# it, so it is written out here as the independent second opinion.
HARDCAP = 51_000_000 * 100_000_000
# Heights per day on the real chain (3s blocks). A test build compresses this,
# which is why --heights-per-day exists.
HEIGHTS_PER_DAY = int(os.environ.get("HEIGHTS_PER_DAY", 28_800))
# How far the accrual walk may lag before claims start being refused. The walk
# is capped per call, so a day or two of drift is ordinary; a week means
# nobody has transacted and the next claimer pays for the whole catch-up.
MAX_ACCRUAL_LAG_DAYS = 3

NODES = ("https://api.vsc.eco/api/v1/graphql",
         "https://api.okinoko.io/api/v1/graphql",
         "https://vsc.techcoderx.com/api/v1/graphql")


def pick_api():
    if os.environ.get("MAGI_API"):
        return os.environ["MAGI_API"]
    for url in NODES:
        try:
            if "last_processed_block" in post(url, {"query": "{localNodeInfo{last_processed_block}}"}):
                return url
        except Exception:
            continue
    raise SystemExit("no MAGI node answered")


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=30).read().decode()


def gql(query, variables=None):
    d = json.loads(post(API, {"query": query, "variables": variables or {}}))
    if "errors" in d:
        raise SystemExit("GraphQL: " + d["errors"][0].get("message", "?"))
    return d["data"]


def state(contract, keys, hexed=False):
    enc = ', encoding:"hex"' if hexed else ""
    d = gql("query($c:String!,$k:[String!]!){getStateByKeys(contractId:$c,keys:$k%s)}" % enc,
            {"c": contract, "k": keys})
    return d["getStateByKeys"] or {}


def token_balance(acct):
    """balanceOf through simulation. Per-account token keys do not match the
    obvious guesses, so this is the only way to read one (CLAUDE.md)."""
    d = gql("""query($i:SimulateContractCallsInput!){
                 simulateContractCalls(input:$i){ success err_msg ret } }""",
            {"i": {"tx_id": "audit", "required_auths": "hive:lasseehlers",
                   "calls": [{"contract_id": TOKEN, "action": "balanceOf",
                              "payload": json.dumps({"account": acct}),
                              "rc_limit": 10_000, "intents": []}]}})
    row = (d.get("simulateContractCalls") or [{}])[0]
    if not row.get("success"):
        return None
    return int(json.loads(row["ret"])["balance"])


def amt(n):
    """Base units -> the 8dp form, never rounded up."""
    neg = n < 0
    n = abs(int(n))
    return ("-" if neg else "") + f"{n // 100_000_000:,}.{n % 100_000_000:08d}"


# The legacy `bal_` rows that existed when reconcile_float ran (4 Oct 2026),
# reconstructed on 9 Oct: the 12 still standing plus @shopnilhasan's, the one
# touched since. Their total at reconcile time, in base units.
LEGACY_ACCOUNTS = [
    "hive:fighter4-freedom", "hive:chaosmagic23", "hive:methus", "hive:bokica80",
    "hive:badadib", "hive:condeas", "hive:yintercept", "hive:iamraincrystal",
    "hive:lrekt01", "hive:tom45p", "hive:bitphoto", "hive:savvytester",
    "hive:shopnilhasan",
]
LEGACY_AT_RECONCILE = 22_515_858_392_707 + 8_692_782


API = pick_api()


def run():
    core = state(CORE, ["sup_migrated", "sup_emitted", "sup_claimed",
                        "cfg_migtotal", "cfg_genesis", "acc_day", "cfg_settled"])
    tok = state(TOKEN, ["supply", "owner"], hexed=True)
    head = gql("{localNodeInfo{last_processed_block}}")["localNodeInfo"]["last_processed_block"]

    def num(d, k):
        v = d.get(k)
        return int(v) if v not in (None, "") else 0

    migrated = num(core, "sup_migrated")
    emitted  = num(core, "sup_emitted")
    claimed  = num(core, "sup_claimed")
    migtotal = num(core, "cfg_migtotal")
    genesis  = num(core, "cfg_genesis")
    acc_day  = num(core, "acc_day")
    books    = migrated + emitted
    supply   = int(tok["supply"], 16) if tok.get("supply") else 0
    owner    = bytes.fromhex(tok["owner"]).decode() if tok.get("owner") else ""
    float_   = token_balance("contract:" + CORE)
    day_now  = (head - genesis) // HEIGHTS_PER_DAY if genesis else 0

    checks = []

    def check(name, ok, detail):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    # 1. THE ONE THAT WOULD HAVE CAUGHT IT. Every token the books say exists
    #    must actually be minted in the token contract. mintSupply is the only
    #    place supply grows and it mints as it counts, so after the handover
    #    this can only be broken by value that was counted before the token
    #    existed and never carried across — which is precisely what happened.
    #
    #    THE ONE KNOWN, EXPLAINED SURPLUS (found 2026-10-09). Thirteen accounts
    #    claimed before the 8 Sep handover and were never moved by
    #    migrate_ledger, so they still had legacy `bal_` rows when
    #    reconcile_float minted backing for them on 4 Oct. Touching such an
    #    account later runs ensureMigrated, which MINTS the row again instead of
    #    moving the backing already in the float — so the token ends up holding
    #    exactly that row's value more than the books. Nobody gains or loses:
    #    the owner gets their own balance once, the duplicate sits idle in the
    #    core's float. The surplus must therefore equal, to the base unit,
    #    LEGACY_AT_RECONCILE minus the legacy rows still standing. Anything
    #    else — a shortfall, or a surplus of any other size — is a real fault.
    legacy = state(CORE, ["bal_" + a for a in LEGACY_ACCOUNTS])
    legacy_now = sum(num(legacy, "bal_" + a) for a in LEGACY_ACCOUNTS)
    expected_surplus = LEGACY_AT_RECONCILE - legacy_now
    check("backing", supply - books == expected_surplus,
          f"books {amt(books)} vs minted {amt(supply)} — surplus {amt(supply - books)}, "
          f"explained {amt(expected_surplus)} (legacy rows touched since 4 Oct; "
          f"{amt(legacy_now)} still standing)")

    # 2. The historic hardcap, checked against the chain rather than trusted.
    check("hardcap", books <= HARDCAP,
          f"{amt(books)} of {amt(HARDCAP)} — room {amt(HARDCAP - books)}")

    # 3. Nobody can claim more of the migration than was committed at genesis.
    check("claim ceiling", claimed <= migtotal,
          f"claimed {amt(claimed)} of {amt(migtotal)}")

    # 4. ONLY THE CORE MAY MINT. If this ever reads anything else, someone
    #    other than the frozen contract can create LASSECASH, which is the
    #    worst thing that could possibly be true.
    check("token owner", owner == "contract:" + CORE, owner or "(unreadable)")

    # 5. The accrual walk falling behind does not lose money, but it REFUSES
    #    claims until someone pays to catch it up — which is the dead end
    #    Lasse hit on 1 October.
    lag = day_now - acc_day
    check("accrual", lag <= MAX_ACCRUAL_LAG_DAYS,
          f"walked to day {acc_day}, chain is at day {day_now} (lag {lag})")

    # Not a pass/fail — the float is SUPPOSED to be small, it is a working
    # balance. It is reported because it is what decides whether a given claim
    # goes through today, and it is the number that drifts.
    info = f"float {amt(float_) if float_ is not None else '?'}   head {head:,}   node {API.split('/')[2]}"
    return checks, info


def main():
    checks, info = run()
    as_json = "--json" in sys.argv
    failed = [c for c in checks if not c["ok"]]
    if as_json:
        print(json.dumps({"ok": not failed, "info": info, "checks": checks}, indent=1))
    else:
        print(info + "\n")
        for c in checks:
            print(f"{'PASS' if c['ok'] else 'FAIL'}  {c['check']:<14} {c['detail']}")
        print()
        print("ALL CHECKS PASS" if not failed
              else f"{len(failed)} CHECK(S) FAILED: " + ", ".join(c["check"] for c in failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

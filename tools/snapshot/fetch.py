#!/usr/bin/env python3
"""
LasseCash migration snapshot — data collection.

DESIGN PRINCIPLE: fetching is slow (~10,500 accounts x 2 chains) and criteria
are a judgement call that will change. So this tool does NOTHING but collect
raw facts. Deciding who qualifies is a separate, instant, local step
(apply_criteria.py). Never bake policy into the fetcher — you do not want to
re-scrape the chain every time a threshold is reconsidered.

Both stages are resumable: re-running picks up where it stopped.

Usage:
    python3 fetch.py balances     # stage 1: every LASSECASH holder
    python3 fetch.py activity     # stage 2: liveness evidence per account
    python3 fetch.py status       # how far along are we
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
BALANCES = os.path.join(DATA, "balances.json")
ACTIVITY = os.path.join(DATA, "activity.json")

HE_RPC = "https://api.hive-engine.com/rpc/contracts"
HE_HISTORY = "https://accounts.hive-engine.com/accountHistory"
# Probed 2026-08-20; anyx.io was returning 502 and is excluded. Requests are
# spread across these round-robin so no single node is hammered.
HIVE_NODES = [
    "https://api.hive.blog",
    "https://api.deathwing.me",
    "https://api.openhive.network",
    "https://rpc.mahdiyari.info",
    "https://api.syncad.com",
]

# Accounts are independent, so the scan is embarrassingly parallel. Sequential
# it is a ~5 hour job; this brings it under half an hour without being rude to
# any one node.
WORKERS = 12

SYMBOL = "LASSECASH"

# Operations that REQUIRE the active key. Posting-key bots cannot produce these,
# which is precisely why they are the liveness signal. See CLAUDE.md.
ACTIVE_OPS = {
    "transfer": 2,
    "transfer_to_vesting": 3,
    "withdraw_vesting": 4,
    "account_update": 10,
    "transfer_to_savings": 32,
    "delegate_vesting_shares": 40,
    "account_update2": 43,
    "recurrent_transfer": 49,
}
OP_FILTER_LOW = 0
for _bit in ACTIVE_OPS.values():
    OP_FILTER_LOW |= 1 << _bit
assert OP_FILTER_LOW == 572849853039644, "operation filter bitmask changed unexpectedly"


# --- plumbing -------------------------------------------------------------

def post(url, payload, tries=5, timeout=45):
    """POST JSON with retries and backoff. Returns parsed dict, or None."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json",
                         "User-Agent": "lassecash-migration-snapshot/1.0"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001 - we genuinely want every failure
            last = e
            time.sleep(min(2 ** attempt, 20))
    print(f"    ! give up after {tries}: {type(last).__name__}: {last}", file=sys.stderr)
    return None


def get(url, tries=4, timeout=45):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "lassecash-migration-snapshot/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(2 ** attempt, 20))
    return None


def he_find(contract, table, query, limit=1000, offset=0):
    d = post(HE_RPC, {"jsonrpc": "2.0", "id": 1, "method": "find",
                      "params": {"contract": contract, "table": table,
                                 "query": query, "limit": limit,
                                 "offset": offset}})
    if not d or "result" not in d:
        return None
    return d["result"]


def load(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)  # atomic: a killed process never leaves half a file


# --- stage 1: balances ----------------------------------------------------

def fetch_balances():
    """
    Every account that has ever held LASSECASH.

    Hive-Engine rejects offsets past ~10,500, so page by ascending _id instead
    of offset. _id is stable and monotonic, which also makes this resumable.
    """
    rows = load(BALANCES, {})
    last_id = max((r["_id"] for r in rows.values()), default=0) if rows else 0
    print(f"stage 1: balances (resuming from _id {last_id}, {len(rows)} known)")

    while True:
        batch = he_find("tokens", "balances",
                        {"symbol": SYMBOL, "_id": {"$gt": last_id}},
                        limit=1000)
        if batch is None:
            print("  ! query failed; state saved, re-run to resume")
            break
        if not batch:
            break
        for r in batch:
            rows[r["account"]] = {
                "_id": r["_id"],
                "balance": r.get("balance") or "0",
                "stake": r.get("stake") or "0",
                "pendingUnstake": r.get("pendingUnstake") or "0",
                "delegationsIn": r.get("delegationsIn") or "0",
                "delegationsOut": r.get("delegationsOut") or "0",
            }
            last_id = max(last_id, r["_id"])
        save(BALANCES, rows)
        print(f"  {len(rows):,} accounts (last _id {last_id})")

    save(BALANCES, rows)

    liquid = sum(float(r["balance"]) for r in rows.values())
    staked = sum(float(r["stake"]) for r in rows.values())
    print(f"\n  accounts : {len(rows):,}")
    print(f"  liquid   : {liquid:,.8f}")
    print(f"  staked   : {staked:,.8f}")
    print(f"  combined : {liquid + staked:,.8f}")
    return rows


# --- stage 2: liveness evidence -------------------------------------------

def authorized_by(account, op_type, value):
    """
    Whether ACCOUNT itself SIGNED this operation.

    get_account_history returns every op that merely INVOLVES the account —
    including transfers RECEIVED and power-ups someone else paid for. Counting
    those as liveness was a real bug, caught by Lasse 2026-08-21: an account
    whose entire recent "activity" was received dust spam qualified as alive.
    Only the authorizing side proves a human holds the active key.
    """
    t = op_type.removesuffix("_operation")
    if t in ("transfer", "transfer_to_savings", "recurrent_transfer",
             "transfer_to_vesting"):
        return value.get("from") == account
    if t in ("withdraw_vesting", "account_update", "account_update2"):
        return value.get("account") == account
    if t == "delegate_vesting_shares":
        return value.get("delegator") == account
    return False  # unknown op type: fail closed, never fake liveness


# How far back to walk one account's filtered history looking for a SIGNED op.
# 10 pages x 1000 filtered ops is far beyond any plausible run of purely
# third-party ops (received dust, incoming delegations). If the search is
# truncated, the record says so instead of silently claiming "no activity".
MAX_HISTORY_PAGES = 10


def last_active_op(account, node_idx=0):
    """
    Most recent active-authority operation SIGNED BY the account, walking
    backwards through its (server-side filtered) history until one is found.
    Returns (iso_timestamp, op_type, truncated) — (None, None, truncated) if
    none exists.
    """
    node = HIVE_NODES[node_idx % len(HIVE_NODES)]
    start = -1
    for _ in range(MAX_HISTORY_PAGES):
        # API quirk: unless start == -1, the node requires start >= limit-1
        # (it returns the index range [start-limit+1, start]). Near the start
        # of an account's history the limit must shrink to match.
        limit = 1000 if start == -1 else min(1000, start + 1)
        d = post(node, {
            "jsonrpc": "2.0", "id": 1,
            "method": "account_history_api.get_account_history",
            "params": {"account": account, "start": start, "limit": limit,
                       "operation_filter_low": OP_FILTER_LOW,
                       "include_reversible": True},
        }, tries=3)
        if not d or "result" not in d:
            return None, None, True  # node failure — unknown, not "dead"
        hist = d["result"].get("history") or []
        if not hist:
            return None, None, False  # genuinely no signed op, ever
        for idx, op in reversed(hist):  # newest last -> walk newest first
            op_type = op.get("op", {}).get("type") or ""
            value = op.get("op", {}).get("value") or {}
            if authorized_by(account, op_type, value):
                return op.get("timestamp"), op_type, False
        oldest_idx = hist[0][0]
        if oldest_idx == 0:
            return None, None, False  # walked the whole history
        start = oldest_idx - 1
    return None, None, True  # search truncated: MAX_HISTORY_PAGES exhausted


def he_authorized_by(account, entry):
    """
    Whether ACCOUNT initiated this Hive-Engine history entry.

    Same bug class as the Hive layer: accountHistory lists entries where the
    account is EITHER side, so received transfers and third-party stakes
    ("lasseehlers staked to X") counted as X's engagement. Only the sender /
    actor side counts: `from` for transfers and stakes; the `account` field
    for self-ops that carry no `from`.
    """
    frm = entry.get("from")
    if frm is not None:
        return frm == account
    return entry.get("account") == account


# Hive-Engine operations a user can INITIATE for LASSECASH. Server-side
# filtering keeps the walk short: without it, accounts receiving automatic
# distribution payouts bury their last real action under thousands of
# `distribution_checkPendingDistributions` entries (signumpizza: ~3/day).
HE_USER_OPS = ",".join([
    "tokens_transfer", "tokens_stake", "tokens_unstake",
    "tokens_cancelUnstake", "tokens_delegate", "tokens_undelegate",
    "market_buy", "market_sell", "market_placeOrder", "market_cancel",
])


def last_token_activity(account):
    """
    Most recent LASSECASH action INITIATED BY the account on the Hive-Engine
    layer, walking back through its history. Proves engagement with LasseCash
    specifically, not merely with Hive.
    Returns (unix_ts, operation, truncated) or (None, None, truncated).
    """
    offset = 0
    for _ in range(MAX_HISTORY_PAGES):
        d = get(f"{HE_HISTORY}?account={account}&symbol={SYMBOL}"
                f"&ops={HE_USER_OPS}&limit=500&offset={offset}")
        if d is None or not isinstance(d, list):
            return None, None, True  # API failure — unknown, not "dead"
        if not d:
            return None, None, False  # history exhausted: never acted
        for e in d:  # newest first
            if he_authorized_by(account, e):
                return e.get("timestamp"), e.get("operation"), False
        if len(d) < 500:
            return None, None, False
        offset += 500
    return None, None, True


def scan_one(item):
    """Collect both liveness signals for one account. Pure per-account work,
    safe to run concurrently."""
    i, account = item
    ts, op, trunc = last_active_op(account, node_idx=i)
    he_ts, he_op, he_trunc = last_token_activity(account)
    return account, {
        "last_active_op_ts": ts,
        "last_active_op_type": op,
        "last_lassecash_ts": he_ts,
        "last_lassecash_op": he_op,
        # A truncated search means "not found within the walked window", not
        # "proven absent". Recorded so criteria can treat it honestly.
        "search_truncated": bool(trunc or he_trunc),
    }


def fetch_activity():
    balances = load(BALANCES, {})
    if not balances:
        print("no balances yet — run `fetch.py balances` first")
        return
    acts = load(ACTIVITY, {})
    todo = [a for a in balances if a not in acts]
    print(f"stage 2: activity — {len(acts):,} done, {len(todo):,} to go "
          f"({WORKERS} workers over {len(HIVE_NODES)} nodes)")

    start = time.time()
    done_now = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(scan_one, (i, a)): a for i, a in enumerate(todo)}
        for fut in as_completed(futures):
            try:
                account, rec = fut.result()
            except Exception as e:  # noqa: BLE001 — one bad account must not
                account = futures[fut]  # kill an 11k-account scan
                print(f"    ! @{account}: {type(e).__name__}: {e}", file=sys.stderr)
                continue
            acts[account] = rec
            done_now += 1
            if done_now % 100 == 0:
                save(ACTIVITY, acts)
                rate = done_now / max(time.time() - start, 1)
                eta = (len(todo) - done_now) / max(rate, 0.01) / 60
                print(f"  {len(acts):,}/{len(balances):,} "
                      f"({len(acts) * 100 // len(balances)}%)  "
                      f"{rate:.1f}/s  eta {eta:.0f}m")

    save(ACTIVITY, acts)
    print(f"done: {len(acts):,} accounts in {(time.time() - start) / 60:.1f}m")


def status():
    b = load(BALANCES, {})
    a = load(ACTIVITY, {})
    print(f"balances : {len(b):,} accounts")
    print(f"activity : {len(a):,} accounts"
          + (f"  ({len(b) - len(a):,} remaining)" if b else ""))
    if a:
        with_active = sum(1 for v in a.values() if v.get("last_active_op_ts"))
        with_lc = sum(1 for v in a.values() if v.get("last_lassecash_ts"))
        print(f"  with any active-authority op : {with_active:,}")
        print(f"  with any LASSECASH movement  : {with_lc:,}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "balances":
        fetch_balances()
    elif cmd == "activity":
        fetch_activity()
    elif cmd == "status":
        status()
    else:
        print(__doc__)
        sys.exit(1)

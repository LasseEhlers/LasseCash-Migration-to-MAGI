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
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
BALANCES = os.path.join(DATA, "balances.json")
ACTIVITY = os.path.join(DATA, "activity.json")
# Marks a scan pass in progress. Present = resume it; absent = start a
# fresh full pass. Removed only when every account has been scanned.
PASS_FILE = os.path.join(DATA, "activity_pass.json")

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


def he_find_one(contract, table, query):
    d = post(HE_RPC, {"jsonrpc": "2.0", "id": 1, "method": "findOne",
                      "params": {"contract": contract, "table": table, "query": query}})
    if not d or "result" not in d:
        return None
    return d["result"]


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
    # ⚠️ ALWAYS A FULL PASS — NEVER RESUME FROM THE HIGHEST KNOWN _id.
    #
    # This used to start at `max(_id)` and fetch only rows above it, which is
    # correct for DISCOVERING new accounts and silently wrong for everything
    # else: an existing account's _id does not change when its BALANCE does, so
    # every balance change since the last scan was invisible. Caught 2026-08-23,
    # when a gift run moved ~74,000 LASSECASH from two accounts to 1,521 others:
    # the recipients were discovered with their new balances while the senders
    # kept their old ones, the same tokens were counted twice, and the snapshot
    # total rose to 31,081,149 — an 81,150 BREACH of the 51,000,000 hardcap
    # that was pure double-counting.
    #
    # This mattered far beyond that one run. The migration is announced with a
    # roll call whose entire purpose is to make hundreds of people MOVE
    # LASSECASH in the final week. A resuming scan would have recorded not one
    # of those movements, and the snapshot would have committed stale balances
    # to an immutable contract.
    #
    # A full pass is ~13 requests. There was never anything to save.
    prev = load(BALANCES, {})
    rows: dict = {}
    last_id = 0
    print(f"stage 1: balances (full pass; {len(prev)} known from the last scan)")

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
        print(f"  {len(rows):,} accounts (last _id {last_id})")

    # Only overwrite once the pass completed. A half-finished pass must never
    # replace a good file — it would look like thousands of accounts vanished.
    if not rows:
        print("  ! no rows read; keeping the previous balances file")
        rows = prev
    else:
        gone = set(prev) - set(rows)
        if gone:
            # Hive-Engine does not delete balance rows, so this should be empty.
            # If it ever is not, say so rather than silently dropping holders.
            print(f"  ! {len(gone)} accounts present last scan and missing now: "
                  f"{', '.join(sorted(gone)[:5])}{'…' if len(gone) > 5 else ''}")
        save(BALANCES, rows)

    # LASSECASH that is OWNED but not in any account balance — found
    # 2026-08-22 when the "lost" gap under the 51M cap turned out to be
    # 603k of people's money: (a) the SWAP.HIVE:LASSECASH Diesel pool, where
    # each liquidity provider owns shares/totalShares of the LASSECASH
    # reserve, and (b) open SELL orders on the Hive-Engine market, where the
    # seller's tokens sit in the market contract until filled. Both are
    # credited to their owners as LIQUID. Without this, 125 LPs and 29
    # sellers would have been burned at the snapshot.
    from decimal import Decimal, ROUND_DOWN
    pooled, on_order = {}, {}

    # EVERY pool holding LASSECASH, not just SWAP.HIVE:LASSECASH. Found
    # 2026-08-23: the LASSECASH:PUPPY pool holds ~14,459 LASSECASH belonging
    # to 35 providers, and the old hardcoded pair meant all of them would have
    # been burned at the snapshot. Never hardcode one pair again — read the
    # pool list and take whichever side is LASSECASH.
    all_pools = he_find("marketpools", "pools", {}, limit=1000) or []
    lc_pools = [p for p in all_pools if SYMBOL in (p.get("tokenPair") or "")]
    if not lc_pools:
        print("  ! could not read any Diesel pool — pooled LASSECASH NOT captured")
    for pool in lc_pools:
        pair = pool["tokenPair"]
        base, quote = pair.split(":")
        reserve = Decimal(pool["baseQuantity"] if base == SYMBOL else pool["quoteQuantity"])
        total_shares = Decimal(pool["totalShares"])
        if total_shares <= 0:
            continue
        offset = 0
        n_lp = 0
        while True:
            batch = he_find("marketpools", "liquidityPositions",
                            {"tokenPair": pair}, limit=1000, offset=offset) or []
            for lp in batch:
                share = (Decimal(lp["shares"]) * reserve / total_shares).quantize(
                    Decimal("0.00000001"), rounding=ROUND_DOWN)
                pooled[lp["account"]] = pooled.get(lp["account"], Decimal(0)) + share
                n_lp += 1
            if len(batch) < 1000:
                break
            offset += 1000
        print(f"  pool {pair}: {reserve} {SYMBOL} across {n_lp} positions")
    offset = 0
    while True:
        batch = he_find("market", "sellBook", {"symbol": "LASSECASH"}, limit=1000, offset=offset) or []
        for o in batch:
            on_order[o["account"]] = on_order.get(o["account"], Decimal(0)) + Decimal(o["quantity"])
        if len(batch) < 1000:
            break
        offset += 1000
    print(f"  open sell orders: {sum(on_order.values(), Decimal(0))} {SYMBOL} across {len(on_order)} sellers")

    # RECONCILE against Hive-Engine's own contract-held table. This is the
    # check that would have caught both misses above on the day they appeared,
    # instead of a month later. tokens.contractsBalances is authoritative for
    # every token a contract holds: market (the sell book), marketpools (all
    # pools) and distribution (undistributed pool rewards).
    #
    # NOTE 2026-08-23: account-held + contract-held does NOT equal the token's
    # own `supply` field. For LASSECASH it exceeds it by ~485,310. That is a
    # Hive-Engine problem, not ours — the identical calculation reconciles to
    # 0.00 on VIBES and CTP, while LEO, POB and PIZZA are also over. Audited
    # and published rather than papered over.
    contracts = {c["account"]: Decimal(c.get("balance") or 0) + Decimal(c.get("stake") or 0)
                 for c in (he_find("tokens", "contractsBalances", {"symbol": SYMBOL},
                                   limit=100) or [])}
    print(f"\n  contract-held ({SYMBOL}), per tokens.contractsBalances:")
    for name, amt in sorted(contracts.items()):
        print(f"    {name:<16}{amt:>20,.8f}")
    captured_pool = sum(pooled.values(), Decimal(0))
    captured_ord = sum(on_order.values(), Decimal(0))
    mp, mk = contracts.get("marketpools", Decimal(0)), contracts.get("market", Decimal(0))
    print(f"    captured as pooled  {captured_pool:>20,.8f}  (vs marketpools {mp:,.8f})")
    print(f"    captured as onOrder {captured_ord:>20,.8f}  (vs market      {mk:,.8f})")
    if abs(mp - captured_pool) > Decimal("1"):
        print(f"    ! POOL MISMATCH {mp - captured_pool:,.8f} — a pool is not being read")
    if abs(mk - captured_ord) > Decimal("1"):
        print(f"    ! ORDER MISMATCH {mk - captured_ord:,.8f} — the sell book is not being read")
    dist = contracts.get("distribution", Decimal(0))
    if dist > 0:
        print(f"    distribution holds {dist:,.8f} — undistributed inflation, NOT migrated")
    for acct, amt in pooled.items():
        rows.setdefault(acct, {"_id": 0, "balance": "0", "stake": "0", "pendingUnstake": "0",
                               "delegationsIn": "0", "delegationsOut": "0"})["pooled"] = str(amt)
    for acct, amt in on_order.items():
        rows.setdefault(acct, {"_id": 0, "balance": "0", "stake": "0", "pendingUnstake": "0",
                               "delegationsIn": "0", "delegationsOut": "0"})["onOrder"] = str(amt)
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


# Operations that are always initiated by the owner of the tokens even
# though the entry carries no `from`/`to` (verified live against
# accounts.hive-engine.com 2026-08-22: a `tokens_unstakeStart` row for
# @cedricguillas has from=None, to=None, account=cedricguillas).
HE_SELF_INITIATED_OPS = {"tokens_unstakeStart", "tokens_undelegateStart"}

# Operations that are the automatic, unsigned completion of the above —
# nobody authorizes these; they fire on a timer regardless of whether the
# account is alive. Confirmed live: @cedricguillas has two
# `tokens_unstakeDone` rows (weekly instalments) between the `Start` and
# nothing else. If these ever counted as activity, ONE powerdown would look
# like months of the account being alive.
HE_AUTOMATIC_OPS = {"tokens_unstakeDone", "tokens_undelegateDone"}


def he_authorized_by(account, entry):
    """
    Whether ACCOUNT initiated this Hive-Engine history entry.

    Same bug class as the Hive layer: accountHistory lists entries where the
    account is EITHER side, so received transfers and third-party stakes
    ("lasseehlers staked to X") counted as X's engagement.

    `account` on every row is simply WHOSE HISTORY WAS QUERIED — it equals
    the queried account on every single entry regardless of who acted, so it
    can NEVER be used as an authorship signal (that was bug 2: the old
    fallback `entry.get("account") == account` was true unconditionally,
    which let a third party's stake into a queried account count as that
    account's own engagement). Authorship must instead be read explicitly,
    by operation:

    - entries WITH a `from` (transfers, stakes, delegations): the actor is
      `from`.
    - `tokens_unstakeStart` / `tokens_undelegateStart`: carry no from/to, but
      only the token owner can start their own unstake/undelegate — so the
      queried account is the actor.
    - `tokens_unstakeDone` / `tokens_undelegateDone`: the automatic,
      unsigned completion of the above (fires on a timer) — never counts.
    - anything else lacking a `from`: fail closed, do not count.
    """
    op_type = entry.get("operation")
    frm = entry.get("from")
    if frm is not None:
        return frm == account
    if op_type in HE_SELF_INITIATED_OPS:
        return True
    if op_type in HE_AUTOMATIC_OPS:
        return False
    return False


# Hive-Engine operations a user can INITIATE for LASSECASH. Server-side
# filtering keeps the walk short: without it, accounts receiving automatic
# distribution payouts bury their last real action under thousands of
# `distribution_checkPendingDistributions` entries (signumpizza: ~3/day).
#
# Verified live 2026-08-22 against accounts.hive-engine.com: the real
# operation names are `tokens_unstakeStart` / `tokens_undelegateStart`
# (NOT `tokens_unstake` / `tokens_undelegate`, which do not exist — the old
# names meant the server-side filter silently matched nothing, so every
# powerdown and undelegation in seven years was invisible to this scan).
# `tokens_unstakeDone` / `tokens_undelegateDone` are deliberately NOT
# requested: they are the automatic, unsigned completion of the above (see
# HE_AUTOMATIC_OPS) and fetching them would only bury the real signal under
# weekly instalments, the same problem this filter exists to avoid.
HE_USER_OPS = ",".join([
    "tokens_transfer", "tokens_stake", "tokens_unstakeStart",
    "tokens_cancelUnstake", "tokens_delegate", "tokens_undelegateStart",
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
        #
        # TWO FLAGS, AND THE DIFFERENCE DECIDES WHO IS BURNED. `he_trunc` is
        # the LASSECASH walk; `trunc` is the Hive L1 walk. C6 dropped the Hive
        # limb from eligibility entirely on 2026-08-22 — Hive activity is read
        # for the audit trail and makes nobody eligible — so only the LASSECASH
        # walk's truncation may trigger the fail-open rule.
        #
        # Writing only the OR of the two was a real bug, found in the 2026-08-23
        # rehearsal: any account with a Hive history too long to walk failed
        # open and migrated regardless of whether it ever touched LASSECASH.
        # 357 accounts flipped from correctly-burned to migrating, including
        # @signumpizza with 1,370,834 LC and silent since 2022, and prolific
        # Hive accounts like @themarkymark, @peakd, @gtg and @deathwing that
        # have no LASSECASH activity at all. apply_criteria has always PREFERRED
        # he_search_truncated; fetch.py simply never wrote it, so the fallback
        # to the combined flag fired every time.
        "he_search_truncated": bool(he_trunc),
        "search_truncated": bool(trunc or he_trunc),
    }


def fetch_activity():
    """
    Scan every account's signed-operation history.

    ⚠️ EVERY ACCOUNT IS RE-SCANNED ON EVERY PASS. It used to skip any account
    that already had a record — `todo = [a for a in balances if a not in acts]` —
    which is the same defect the balance scan had, and far worse here.

    The migration is announced with a ROLL CALL: 12,286 accounts are told they
    have until the snapshot block to sign one LASSECASH operation and keep
    their stake. Every one of those people already has an activity record
    saying "dead". A scan that skips known accounts would not see a single
    action taken in response to the announcement, and would burn the tokens of
    exactly the people who did what they were asked. Found 2026-08-23, eight
    days before the snapshot.

    Resumability is kept, but WITHIN a pass rather than across passes. A pass
    id is written to PASS_FILE at the start; records carry the pass that wrote
    them, so a crash-and-rerun resumes and a completed run leaves no marker,
    making the next invocation a full fresh scan. That is the safe default: an
    unnecessary re-scan costs an hour, a skipped one costs somebody's tokens.
    """
    balances = load(BALANCES, {})
    if not balances:
        print("no balances yet — run `fetch.py balances` first")
        return
    acts = load(ACTIVITY, {})

    resuming = os.path.exists(PASS_FILE)
    if resuming:
        pass_id = json.load(open(PASS_FILE))["pass"]
    else:
        pass_id = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with open(PASS_FILE, "w") as fh:
            json.dump({"pass": pass_id, "accounts": len(balances)}, fh)

    todo = [a for a in balances if (acts.get(a) or {}).get("pass") != pass_id]
    print(f"stage 2: activity — {'RESUMING' if resuming else 'FULL PASS'} {pass_id}")
    print(f"  {len(balances) - len(todo):,} already scanned in this pass, "
          f"{len(todo):,} to go ({WORKERS} workers over {len(HIVE_NODES)} nodes)")

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
            rec["pass"] = pass_id
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
    stale = [a for a in balances if (acts.get(a) or {}).get("pass") != pass_id]
    if stale:
        print(f"  ! {len(stale):,} accounts still unscanned in this pass — "
              f"re-run to finish; the marker is kept so it resumes")
    else:
        os.remove(PASS_FILE)   # pass complete: the NEXT run scans everything again
        print(f"done: {len(acts):,} accounts in {(time.time() - start) / 60:.1f}m "
              f"(pass complete — the next run is a fresh full scan)")


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

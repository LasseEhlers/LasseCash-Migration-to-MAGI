#!/usr/bin/env python3
"""Find ACTIVE liquidity providers on Hive-Engine's Diesel pools.

WHY. LasseCash's bottleneck is not incentive — the pool pays over 12,000% APY
and nobody is in it. The bottleneck is that the people who hold LASSECASH do
not hold the PAIR: they need HBD, and a bridge, and a reason.

Liquidity providers already have all three. They hold pair capital, they have
priced impermanent loss before, and they compare APYs for a living. One of them
is worth many posters for this specific problem, and they are enumerable:
Hive-Engine's `marketpools` contract publishes every pool and every position in
it, by account.

NOT PUBLISHED ON THE SITE. The migration snapshot is LasseCash's own history
and belongs in the open. This is other people's positions on another chain,
assembled so we can write to them — a marketing target list, which lives in a
local file and nowhere else.

    python3 tools/lp-targets/scan.py                  # full scan
    python3 tools/lp-targets/scan.py --min-usd 50     # only sizeable positions

Output: tools/lp-targets/data/targets.json + a readable table on stdout.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal

HE_RPC = "https://api.hive-engine.com/rpc/contracts"
HE_HISTORY = "https://accounts.hive-engine.com/accountHistory"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# The base assets whose pools are worth reading. A Diesel pool always pairs
# against one of these, and a position in a SWAP.HIVE or SWAP.HBD pool is the
# strongest signal — that LP is holding exactly the kind of capital our pool
# needs, not a farm token they cannot sell.
BASES = ("SWAP.HIVE", "SWAP.HBD", "SWAP.BTC", "BEE")

# An LP who has not signed anything in six months is a zombie position, and we
# already know that world: 52 of 125 LASSECASH LPs had not touched either chain
# in over a year. Writing to them is writing to nobody.
ALIVE_MONTHS = 6

# Only ops the account SIGNED ITSELF prove a human. Received transfers, other
# people's stakes and automatic payouts prove nothing — the exact bug that made
# 2,667 accounts look alive in the migration scan.
SIGNED_OPS = (
    "tokens_transfer", "tokens_stake", "tokens_unstakeStart",
    "tokens_delegate", "tokens_undelegateStart",
    "marketpools_addLiquidity", "marketpools_removeLiquidity",
    "marketpools_swapTokens", "market_buy", "market_sell", "market_cancel",
)


def post(url, payload, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            return json.loads(urllib.request.urlopen(req, timeout=30).read())
        except Exception:
            if attempt == tries - 1:
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def he_find(contract, table, query, limit=1000, offset=0):
    d = post(HE_RPC, {"jsonrpc": "2.0", "id": 1, "method": "find",
                      "params": {"contract": contract, "table": table,
                                 "query": query, "limit": limit, "offset": offset}})
    return (d or {}).get("result")


def get(url, tries=4):
    for attempt in range(tries):
        try:
            return json.loads(urllib.request.urlopen(url, timeout=30).read())
        except Exception:
            if attempt == tries - 1:
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def dec(x):
    try:
        return Decimal(str(x or 0))
    except Exception:
        return Decimal(0)


# --------------------------------------------------------------- prices

def token_prices():
    """USD per unit for the base assets, so pools can be compared honestly.

    Pool sizes in mixed tokens are not comparable — 1,000,000 of a farm token
    and 1,000 SWAP.HIVE look similar and are not. Everything is converted.
    """
    hive_usd = Decimal("0")
    d = get("https://api.coingecko.com/api/v3/simple/price?ids=hive&vs_currencies=usd")
    if d:
        hive_usd = dec(d.get("hive", {}).get("usd"))
    if hive_usd <= 0:
        print("  ! could not price HIVE; falling back to 0.04 (re-run later)", file=sys.stderr)
        hive_usd = Decimal("0.04")
    return {
        "SWAP.HIVE": hive_usd,
        "SWAP.HBD": Decimal("1"),      # pegged, near enough for ranking
        "BEE": Decimal("0"),           # priced below from its own pool
        "SWAP.BTC": Decimal("0"),
    }


# --------------------------------------------------------------- pools

def read_pools(prices, min_pool_usd):
    """Every Diesel pool against a base asset, with its USD size."""
    pools, offset = [], 0
    while True:
        batch = he_find("marketpools", "pools", {}, limit=1000, offset=offset)
        if not batch:
            break
        pools.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    print(f"  {len(pools)} Diesel pools on Hive-Engine")

    # BTC and BEE price themselves off their own SWAP.HIVE pool rather than an
    # external API — the pool IS the market on Hive-Engine.
    for p in pools:
        pair = p.get("tokenPair") or ""
        for sym in ("SWAP.BTC", "BEE"):
            if prices.get(sym, 0) <= 0 and pair in (f"SWAP.HIVE:{sym}", f"{sym}:SWAP.HIVE"):
                base, quote = pair.split(":")
                bq, qq = dec(p["baseQuantity"]), dec(p["quoteQuantity"])
                if bq > 0 and qq > 0:
                    prices[sym] = (bq / qq * prices["SWAP.HIVE"]) if base == "SWAP.HIVE" \
                        else (qq / bq * prices["SWAP.HIVE"])

    sized = []
    for p in pools:
        pair = p.get("tokenPair") or ""
        if ":" not in pair:
            continue
        base, quote = pair.split(":")
        # Value the side we can price, and double it: a constant-product pool
        # holds equal value on both sides by construction.
        usd = Decimal(0)
        if prices.get(base, 0) > 0:
            usd = dec(p["baseQuantity"]) * prices[base] * 2
        elif prices.get(quote, 0) > 0:
            usd = dec(p["quoteQuantity"]) * prices[quote] * 2
        if usd >= min_pool_usd:
            sized.append({"pair": pair, "usd": usd,
                          "totalShares": dec(p["totalShares"])})
    sized.sort(key=lambda x: -x["usd"])
    print(f"  {len(sized)} of them hold at least ${min_pool_usd:,.0f}")
    return sized


def read_positions(pool):
    """Every LP in one pool, with their USD share of it."""
    out, offset = {}, 0
    if pool["totalShares"] <= 0:
        return out
    while True:
        batch = he_find("marketpools", "liquidityPositions",
                        {"tokenPair": pool["pair"]}, limit=1000, offset=offset)
        if not batch:
            break
        for lp in batch:
            usd = dec(lp["shares"]) / pool["totalShares"] * pool["usd"]
            out[lp["account"]] = out.get(lp["account"], Decimal(0)) + usd
        if len(batch) < 1000:
            break
        offset += 1000
    return out


# --------------------------------------------------------------- liveness

def last_signed(account):
    """When this account last SIGNED a Hive-Engine operation, or None.

    Authorship is read per operation. `entry.account` is merely whose history
    was queried and matches every row regardless of who acted — the bug that
    made the first migration scan count receiving a transfer as being alive.
    """
    for offset in (0, 500):
        rows = get(f"{HE_HISTORY}?account={account}&limit=500&offset={offset}"
                   f"&ops={','.join(SIGNED_OPS)}")
        if not rows:
            return None
        for r in rows:
            op = r.get("operation") or ""
            if op not in SIGNED_OPS:
                continue
            # `tokens_unstakeDone` and friends fire automatically; only ops
            # whose sender IS the account prove a person signed something.
            actor = r.get("from") or r.get("account")
            if op.startswith(("marketpools_", "market_")) or actor == account:
                ts = r.get("timestamp")
                if ts:
                    return datetime.fromtimestamp(int(ts), timezone.utc)
        if len(rows) < 500:
            return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-usd", type=float, default=25.0,
                    help="smallest LP position worth writing to (default $25)")
    ap.add_argument("--min-pool-usd", type=float, default=500.0,
                    help="smallest pool worth reading (default $500)")
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    print("Reading Hive-Engine Diesel pools")
    prices = token_prices()
    print(f"  HIVE ${prices['SWAP.HIVE']:.6f}   BTC ${prices.get('SWAP.BTC', 0):,.0f}")
    pools = read_pools(prices, Decimal(str(args.min_pool_usd)))

    print(f"\nReading positions in {len(pools)} pools")
    by_account = defaultdict(lambda: {"usd": Decimal(0), "pools": []})
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for pool, positions in zip(pools, ex.map(read_positions, pools)):
            for acct, usd in positions.items():
                if usd >= Decimal(str(args.min_usd)):
                    by_account[acct]["usd"] += usd
                    by_account[acct]["pools"].append({"pair": pool["pair"], "usd": float(usd)})
    print(f"  {len(by_account)} accounts hold at least ${args.min_usd:,.0f} somewhere")

    print(f"\nChecking who is still alive ({ALIVE_MONTHS} months, signed ops only)")
    names = list(by_account)
    cutoff = datetime.now(timezone.utc) - timedelta(days=ALIVE_MONTHS * 30)
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        seen = dict(zip(names, ex.map(last_signed, names)))

    rows = []
    for acct in names:
        when = seen.get(acct)
        if not when or when < cutoff:
            continue
        d = by_account[acct]
        d["pools"].sort(key=lambda p: -p["usd"])
        rows.append({"account": acct, "usd": float(d["usd"]),
                     "last_signed": when.isoformat(),
                     "pools": d["pools"][:6], "pool_count": len(d["pools"])})
    rows.sort(key=lambda r: -r["usd"])

    path = os.path.join(OUT, "targets.json")
    with open(path, "w") as f:
        json.dump({"generated": datetime.now(timezone.utc).isoformat(),
                   "alive_months": ALIVE_MONTHS,
                   "min_usd": args.min_usd, "min_pool_usd": args.min_pool_usd,
                   "hive_usd": float(prices["SWAP.HIVE"]),
                   "targets": rows}, f, indent=1)

    dead = len(names) - len(rows)
    print(f"  {len(rows)} alive, {dead} dormant ({dead / max(len(names), 1) * 100:.0f}% of positions are zombies)")
    print(f"\n-> {path}\n")
    print(f"{'#':>4}  {'account':<20}{'LP value':>12}  {'pools':>5}  top pools")
    for i, r in enumerate(rows[:40], 1):
        top = ", ".join(p["pair"] for p in r["pools"][:3])
        print(f"{i:>4}  @{r['account']:<19}{r['usd']:>12,.0f}  {r['pool_count']:>5}  {top}")
    if len(rows) > 40:
        print(f"      … and {len(rows) - 40} more in targets.json")


if __name__ == "__main__":
    main()

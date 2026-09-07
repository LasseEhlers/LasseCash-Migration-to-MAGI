#!/usr/bin/env python3
"""Build a FRESH list of active Hive accounts, measured from the chain today.

Definition: an account is active if it PUBLISHED A ROOT POST within the last
DAYS days. Measured by walking the chain's created feed backwards
(bridge.get_ranked_posts sort=created, 20 per page — the call's hard maximum) until the posts are
older than the cutoff. Posting takes effort, so this excludes vote bots and
dormant stake; commenters-only and voters-only are NOT captured, and that is
stated rather than hidden.

Why not the 23 Aug list: it was built by tooling that is not in the repo, so
its criteria cannot be checked, and it is two weeks stale.

  python3 tools/snapshot/hive_actives.py            # 30 days, writes the list
  DAYS=60 python3 tools/snapshot/hive_actives.py

Output: tools/snapshot/data/hive_actives_<date>.json with, per account, the
last post date, post count in the window, and reputation — so the cutoff and
a reputation floor can be chosen afterwards without re-walking the chain.
Resumable: progress is saved every 20 pages.
"""
import json, os, sys, time, datetime as dt, urllib.request, math

DAYS = int(os.environ.get("DAYS", "30"))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = f"{HERE}/data/hive_actives_{dt.date.today().isoformat()}.json"
STATE = OUT + ".progress"
# openhive answers a real 20-post page in ~0.14 s, api.hive.blog in ~0.4 s.
# deathwing 403s the default Python user agent; anyx 502s this query.
NODES = ["https://api.openhive.network", "https://api.hive.blog"]
UA = {"content-type": "application/json", "user-agent": "lassecash-actives/1.0"}

def rpc(method, params):
    last = None
    for node in NODES:
        try:
            r = urllib.request.Request(node, data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode(),
                                       headers=UA)
            d = json.loads(urllib.request.urlopen(r, timeout=30).read())
            if "result" in d: return d["result"]
            last = d.get("error")
        except Exception as e:
            last = e
    raise RuntimeError(f"all nodes failed: {last}")

def rep(raw):
    raw = int(raw)
    if raw == 0: return 25.0
    s = -1 if raw < 0 else 1
    return round(s * (math.log10(abs(raw)) - 9) * 9 + 25, 1)

def main():
    cutoff = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(days=DAYS)
    acc, start_author, start_permlink, pages = {}, "", "", 0
    if os.path.exists(STATE):
        st = json.load(open(STATE)); acc, start_author, start_permlink, pages = st["acc"], st["a"], st["p"], st["pages"]
        print(f"resuming at page {pages} ({len(acc)} accounts so far)")
    done = False
    while not done:
        # 20 is the hard maximum for this call ("limit = 50 outside valid range [1:20]").
        q = {"sort": "created", "tag": "", "limit": 20}
        if start_author: q.update({"start_author": start_author, "start_permlink": start_permlink})
        posts = rpc("bridge.get_ranked_posts", q)
        if not posts: break
        if start_author: posts = posts[1:]          # the first row repeats the cursor
        for p in posts:
            created = dt.datetime.fromisoformat(p["created"])
            if created < cutoff: done = True; break
            a = acc.setdefault(p["author"], {"last": p["created"], "posts": 0, "rep": float(p.get("author_reputation", 25))})
            a["posts"] += 1
        if not posts: break
        start_author, start_permlink = posts[-1]["author"], posts[-1]["permlink"]
        pages += 1
        if pages % 100 == 0:
            json.dump({"acc": acc, "a": start_author, "p": start_permlink, "pages": pages}, open(STATE, "w"))
            print(f"  page {pages}: {len(acc)} accounts, oldest {posts[-1]['created']}", flush=True)
        time.sleep(0.05)
    json.dump({"generated": dt.datetime.now(dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds"), "definition": f"root post within {DAYS} days",
               "pages": pages, "count": len(acc), "accounts": acc}, open(OUT, "w"), indent=1)
    if os.path.exists(STATE): os.remove(STATE)
    print(f"\n{len(acc)} accounts posted a root post in the last {DAYS} days -> {OUT}")
    for r in (0, 25, 40, 50, 60):
        print(f"  reputation >= {r:>2}: {sum(1 for v in acc.values() if v['rep'] >= r):>6}")
    for n in (7, 14, 30):
        c = sum(1 for v in acc.values() if dt.datetime.fromisoformat(v["last"]) >= dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(days=n))
        print(f"  posted within {n:>2} days: {c:>6}")

main()

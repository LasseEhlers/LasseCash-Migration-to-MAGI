# The transaction index

Built 2026-10-03. **Dormant by choice:** Lasse decided the same day not to
bind it (no off-chain dependency while the chain is small). Revisit near the
2,000-call page cap. Code: `api/src/indexer.ts` (the walk, pure, tested),
`web/src/lib/server/tx-index.ts` (D1 storage + when to sync),
`web/src/routes/api/index/txs/+server.ts` (the endpoint).

**What it is.** The contract's transaction log, copied verbatim into a
Cloudflare D1 table. Nothing derived — every figure still comes from
contract state or the engine; the index only says where to look. It can be
dropped and rebuilt from the chain at any time.

**How it stays current.** No cron, no second service: a request to
`/api/index/txs` first catches up with the chain (at most once per 30 s,
one page when nothing happened), then answers from D1. First request
backfills; resumes across requests if history is longer than one call walks.

**Who reads it.** The browser's `MagiBackend` (`indexUrl`) for feed,
profiles, comments and activity (Stats). Anything other than a complete
answer — 503, error, still backfilling — falls back to walking the node,
so the site behaves identically with or without the database.

**Measured locally on Cloudflare's runtime against production
(2026-10-03):** backfill of all 318 transactions 6.8 s; reads 10 ms.

## Turning it on (Lasse, once, ~3 minutes)

1. Cloudflare dashboard → **Storage & Databases → D1 SQL Database →
   Create** → name `lassecash-index` → Create. (Free tier.)
2. **Workers & Pages → lassecash → Settings → Bindings → Add → D1
   database** → variable name **`DB`** → database `lassecash-index` → Save.
   Do it for Production (Preview optional).
3. Redeploy so the binding applies: Deployments → latest → **Retry
   deployment** (or push any commit).
4. Check: `https://lassecash.com/api/index/txs?actions=post` should answer
   `"complete": true`. The tables create themselves on the first request.

## Reset

D1 console: `DROP TABLE tx; DROP TABLE meta;` — the next request rebuilds.

## Next

- Server-side readers (SSR feed, sitemap, llms.txt) can read D1 directly
  instead of walking the node.
- `poolOps`/`poolLedger` (pool tab, market API) still walk history; move
  them when they need it.
- Per-author and per-action queries in SQL once the log is large enough
  that sending the filtered list to the browser is too much.

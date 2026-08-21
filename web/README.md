# LasseCash web

SvelteKit 2 + Svelte 5 runes. The frontend is a client of the chain — but not
*only* a client any more.

```
npm run dev      # http://localhost:5173, against the dev chain (./build.sh node)
npm run build    # -> .svelte-kit/cloudflare
npm run preview  # serves the production build locally for curl/browser checks
npm run check    # svelte-check
```

## The split: what renders on the server, and what does not

This is the load-bearing decision, and it follows CLAUDE.md's golden rule
exactly.

| | Where | Why |
|---|---|---|
| Post pages, profiles, the feed, `/about`, the discovery files | **Server-rendered** | Words. A crawler must be able to read the article without running JavaScript. |
| Mint (`/`), `/pool`, `/chain`, `/compose`, `/admin` | **Client only** (`export const ssr = false`) | Money. Every figure is per-user, moves every block, and comes out of the engine WASM in the browser. |

**The server never derives a money figure.** It reads titles, bodies, dates and
tags. Reward figures are not merely absent from the server code — they are kept
out of the cached HTML on purpose, because the HTML is cached for sixty seconds
and a pending payout moves every three. The feed and the post page paint them in
once the browser has read the chain (`hydrated` in `feed/+page.svelte`).

That is also why the server needs no engine: `Backend.postsMeta()` is the
content-only half of `posts()`, and it exists precisely so that server rendering
never has to load the WASM.

## URLs

| URL | What |
|---|---|
| `/@author/permlink` | **Canonical** post page, server-rendered |
| `/@author/permlink.md` | The same article as plain markdown |
| `/post/author/permlink` | The old form — **301** to the canonical |
| `/@name` | Profile, with the author's published work server-rendered |
| `/feed` | LasseMedia |
| `/about`, `/about.md` | Rendered and raw, both from `docs/ABOUT.md` |
| `/robots.txt` `/sitemap.xml` `/feed.xml` | Search-engine discovery |
| `/llms.txt` `/llms-full.txt` | AI-crawler discovery |

Every absolute URL is built from **one** value — `PUBLIC_SITE_URL`, via
`src/lib/site.ts`. Nothing else may name the origin.

### Canonical ownership on Hive

A Hive post is one record rendered by six frontends at six URLs. Publishing from
LasseCash writes `canonical_url` and `app: "lassecash/2.0"` into the post's
`json_metadata` (`api/src/hive-metadata.ts`), which is what peakd and ecency read
to decide whose `<link rel="canonical">` to emit. That makes lassecash.com the
original copy of our posts *on their sites too*.

## Deploying to Cloudflare Pages

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `.svelte-kit/cloudflare` |
| Root directory | `web` |
| Compatibility flags | **`nodejs_compat`** — required; SvelteKit's server uses `node:async_hooks` and `node:crypto` |

Environment variables (build **and** runtime):

| Variable | Meaning | Default |
|---|---|---|
| `PUBLIC_SITE_URL` | The canonical origin. Every canonical tag, sitemap entry, JSON-LD id and published `canonical_url` is built from it. | `https://lassecash.com` |
| `VITE_CONTRACT_ID` | The MAGI contract id. **Setting it flips the app into wallet mode** — leave it unset to talk to the local dev chain. | *(unset)* |
| `VITE_MAGI_NET_ID` | MAGI network id | `vsc-mainnet` |
| `VITE_CHAIN_URL` | Dev-chain URL, or the MAGI GraphQL endpoint | `http://localhost:8080` |

Run the real Workers runtime locally before trusting a deploy:

```bash
npm run build
npx wrangler pages dev .svelte-kit/cloudflare
```

`npm run preview` is the quicker check and was what the SSR work was verified
against; `wrangler pages dev` is the one that will catch a Node API sneaking
into a server module.

### ⚠️ Workers runtime, not Node

Server code runs at the edge. **Web APIs only** — `fetch`, `Request`,
`Response`. No `node:fs`, no `node:module`, no reading a file at request time.
Anything from disk is imported at *build* time; `docs/ABOUT.md` comes in through
Vite's `?raw`, which is why there is still exactly one copy of that text.

Keep per-request CPU small. Rendering one post's markdown is fine. `/feed.xml`
and `/llms-full.txt` fetch up to fifty bodies and are the heaviest things here —
they are cached for five minutes for that reason.

## TODO — static IPFS mirror

A second build of the same source with `@sveltejs/adapter-static` produces the
old SPA shell: no SSR, no sitemap, no canonical HTML, money pages identical
because they were always client-side. It would be a *mirror*, not the canonical
origin, and must not be indexed against lassecash.com. The config is kept as a
comment in `svelte.config.js`. Not built yet.

## TODO — there is no post index

The contract cannot enumerate its own posts (unbounded iteration does not fit in
the gas budget), so both backends rediscover posts from recent history. That
caps `/sitemap.xml`, `/feed.xml` and `/llms.txt` at whatever history reaches.
Fine now; useless at ten thousand posts. The fix is a real indexer-side post
index, not a bigger limit.

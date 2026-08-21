import adapter from "@sveltejs/adapter-cloudflare";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    // SERVER-RENDERED ON CLOUDFLARE PAGES.
    //
    // The frontend was a pure static client, and for the money pages it still
    // is — every figure on /, /pool and /chain is per-user and comes out of the
    // engine WASM in the BROWSER, so those routes opt out of SSR individually
    // (`export const ssr = false`).
    //
    // CONTENT is different. A post that only exists after JavaScript runs is
    // invisible to search engines and to most AI crawlers, which is the single
    // failure every Hive frontend shares. So article pages, profiles, the feed
    // and the discovery files (/sitemap.xml, /feed.xml, /llms.txt) render on
    // the server, from the same indexer the browser uses.
    //
    // The server RENDERS content. It never derives a money figure — see
    // CLAUDE.md's golden rule. Anything economic still hydrates client-side out
    // of the engine, which is why nothing here needs the WASM.
    //
    // ⚠️ WORKERS RUNTIME, NOT NODE. No `node:fs`, no `node:module`, no reading
    // a file at request time. Anything from disk must be imported at BUILD time
    // (see `docs/ABOUT.md`, pulled in with Vite's `?raw`). Keep per-request CPU
    // small: rendering one post's markdown is fine, walking every post is not.
    //
    //   npm run build          -> .svelte-kit/cloudflare
    //   npx wrangler pages dev .svelte-kit/cloudflare
    adapter: adapter({
      // WHICH REQUESTS REACH THE WORKER.
      //
      // The adapter's default is to exclude every static file by NAME, and
      // `static/migration/proofs/` alone holds ~500 of them — past Cloudflare's
      // 100-rule ceiling, at which point it silently drops the excludes and
      // every proof fetch wakes a function for nothing. Wildcards say the same
      // thing in five rules.
      //
      // Anything listed here is served straight off the CDN. Everything else —
      // the SSR'd content pages and the discovery files — goes to the worker.
      routes: {
        include: ["/*"],
        exclude: [
          "<build>",
          "<prerendered>",
          "/migration/*",
          "/engine.wasm",
          "/engine-testwindows.wasm",
          "/wasm_exec.js",
          "/admin-data.json",
        ],
      },
    }),
    alias: { "$api": "../api/src" },

    // TODO — STATIC IPFS MIRROR. LasseCash should also be publishable as a
    // pinned, unstoppable copy that needs no server at all. That is a second
    // build of the same source with:
    //
    //   import adapter from "@sveltejs/adapter-static";
    //   adapter: adapter({ fallback: "index.html" })
    //
    // which produces the old SPA shell: no SSR, no /sitemap.xml, no /feed.xml,
    // no canonical HTML — the money pages work identically because they were
    // always client-side. It is a MIRROR, not the canonical origin, so it must
    // not be indexed against lassecash.com. Not built now; the deliberate
    // decision is that the indexable site is the Cloudflare one.
  },
};

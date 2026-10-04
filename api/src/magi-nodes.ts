/**
 * Which MAGI node answers — with failover, because one node is not a network.
 *
 * Found live 2026-09-17 09:22 CPH: api.vsc.eco stopped answering entirely (no
 * HTTP, no ping) and every page showed "MAGI's node is not answering" with
 * empty balances and an empty feed — while two other public nodes were at the
 * same head block, returned the same contract state, and allowed browser
 * calls. The chain was fine; the site had wired itself to one server.
 *
 * Every read here is a query or a simulation, so retrying one on another node
 * is always safe: nothing is broadcast through a node (signing goes through
 * the wallet to Hive).
 *
 * The node that answered last is tried first, so after one failover the rest
 * of the page goes straight to the healthy node instead of each request
 * waiting out the dead one again.
 */

export const MAGI_NODES: readonly string[] = [
  "https://api.vsc.eco/api/v1/graphql",
  "https://api.okinoko.io/api/v1/graphql",
  "https://vsc.techcoderx.com/api/v1/graphql",
];

/**
 * How long to wait on a node before trying the next one. A dead server does
 * not refuse the connection, it swallows it, so without this every request
 * waits the full timeout. Real queries and simulations answer in well under a
 * second; a healthy-but-slow node that misses this merely hands the request
 * to another healthy node.
 */
const FAILOVER_MS = 6_000;

/**
 * ⚠️ A RATE LIMIT ARRIVES AS HTTP 200. The public nodes cap simulations —
 * "rate limit exceeded: max 30 simulation requests per minute" — and say so
 * in a GraphQL error inside a 200 response, so a failover that only watches
 * the status code hands the error straight to the UI. Seen live 2026-09-21:
 * a mint (which dry-runs several calls) tripped it on the fallback node and
 * the page showed "MAGI's node is not answering" while the mint itself
 * confirmed. With api.vsc.eco down, every client's load piles onto whichever
 * node answered, so this is now the normal failure, not an exotic one.
 *
 * Another node has its own budget, so this is precisely the case failover
 * fixes — but only if we look inside the body.
 */
const RATE_LIMITED = /rate limit exceeded/i;

const REMEMBER_KEY = "lc_magi_node";

/** Remembered per browser, so a reload does not wait out a dead node again.
 *  Storage can be missing or throw (private mode, server runtime). */
let preferred = (() => {
  try {
    const i = MAGI_NODES.indexOf(globalThis.localStorage?.getItem(REMEMBER_KEY) ?? "");
    return i < 0 ? 0 : i;
  } catch {
    return 0;
  }
})();

function prefer(i: number): void {
  preferred = i;
  try {
    globalThis.localStorage?.setItem(REMEMBER_KEY, MAGI_NODES[i] as string);
  } catch {
    // Not remembered; the next reload fails over once more.
  }
}

/** The node currently tried first — for display. */
export function currentMagiNode(url?: string): string {
  return url && !MAGI_NODES.includes(url) ? url : (MAGI_NODES[preferred] as string);
}

/**
 * Ask every node for the head block at once and remember whichever answers
 * FIRST.
 *
 * Failover only ever noticed a node being DEAD. It had nothing to say about a
 * node that is merely SLOW — and that is the common case. Measured 1 Oct, the
 * same mint path: 373–640 ms per request on one public node against 117–293 ms
 * on another, which is 2.5 s before the wallet opens instead of under one. The
 * client had remembered the slow node weeks earlier, when the node it used
 * before went dark, and nothing would ever have moved it off again.
 *
 * Deliberately NOT fired from `magiFetch`: a low-level helper that quietly
 * sends extra requests is a surprise, and it would make every test that counts
 * fetches wrong. The app calls this once when it starts.
 *
 * The head block is the right probe — it is the cheapest query the API has,
 * every node must answer it, and answering it fast is what "this node is
 * responsive right now" means. Racing costs two extra cheap reads once per
 * session.
 *
 * Safe by construction: if every probe fails, whatever was remembered before
 * is kept, and ordinary failover still runs on top.
 */
export async function pickFastestNode(opts: MagiFetchOptions = {}): Promise<string> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  // A configured private node is a deliberate choice; never race past it.
  if (opts.url !== undefined && !MAGI_NODES.includes(opts.url)) return opts.url;

  const body = JSON.stringify({ query: "{localNodeInfo{last_processed_block}}" });

  const ask = async (url: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_MS);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // A rate-limited node answers fast and is useless — see RATE_LIMITED.
      if (RATE_LIMITED.test(await res.text())) throw new Error("rate limited");
    } finally {
      clearTimeout(timer);
    }
  };

  // ⚠️ THE FIRST REQUEST TO A NODE IS NOT A MEASUREMENT OF THE NODE. It pays
  // DNS and the TLS handshake, which the node we are already talking to has
  // long since paid. Racing one cold request per node therefore hands the race
  // to the incumbent — the very node we might need to escape.
  //
  // Measured from Copenhagen, 2 Oct, three requests in a row:
  //   api.okinoko.io      226 ms, 79 ms, 68 ms
  //   vsc.techcoderx.com  217 ms, 254 ms, 307 ms
  //
  // Cold, they look alike. Warm, one is three times the other — and the first
  // version of this probe kept the slow one. So: one throwaway request to open
  // the connection, then time the next two and keep the better. Nine cheap
  // requests, at load and again every few minutes (chain.svelte.ts).
  const timed = await Promise.all(MAGI_NODES.map(async (url, i) => {
    try {
      await ask(url);                       // warm up; cost not counted
      // TWO measurements, keep the better. One sample let a single slow
      // moment on the fast node hand a whole session to the slow one —
      // Lasse saw 2.5–3 s mints again on 2026-10-04 (okinoko 90–270 ms with
      // spread, techcoderx a steady 600 ms).
      let best = Infinity;
      for (let k = 0; k < 2; k++) {
        const t0 = Date.now();
        await ask(url);
        best = Math.min(best, Date.now() - t0);
      }
      return { i, ms: best };
    } catch {
      return null;                          // unreachable, rate-limited, refusing
    }
  }));

  const best = timed
    .filter((r): r is { i: number; ms: number } => r !== null)
    .sort((a, b) => a.ms - b.ms)[0];
  // Nothing answered: keep what we had. magiFetch still fails over on top.
  if (best) prefer(best.i);
  return currentMagiNode();
}

/** How long a probe waits before giving up on a node. Short: this is a race,
 *  and a node that cannot answer the cheapest query quickly is not the one to
 *  send a mint through. */
const PROBE_MS = 3_000;

export interface MagiFetchOptions {
  /** A configured node. A known public node joins the failover list; any
   *  other address (a private or local node) is used alone. */
  url?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  /** Budget for the LAST attempt; earlier attempts fail over sooner. */
  timeoutMs?: number | undefined;
}

export class MagiUnreachableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MagiUnreachableError";
  }
}

/** POST a GraphQL body to a MAGI node, failing over across public nodes. */
export async function magiFetch(body: string, opts: MagiFetchOptions = {}): Promise<Response> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const custom = opts.url !== undefined && !MAGI_NODES.includes(opts.url);
  const order = custom
    ? [opts.url as string]
    : MAGI_NODES.map((_, i) => (preferred + i) % MAGI_NODES.length);

  const tried: string[] = [];
  let lastCause: unknown;
  for (let k = 0; k < order.length; k++) {
    const url = (custom ? order[k] : MAGI_NODES[order[k] as number]) as string;
    const last = k === order.length - 1;
    const ctrl = new AbortController();
    const limit = last ? timeoutMs : Math.min(timeoutMs, FAILOVER_MS);
    const timer = setTimeout(() => ctrl.abort(), limit);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      // A gateway error is the proxy saying the node behind it is gone.
      if (res.status >= 500 && !last) {
        lastCause = new Error(`HTTP ${res.status}`);
        tried.push(`${url} (HTTP ${res.status})`);
        continue;
      }
      // A body can only be read once, so read it here and hand the caller a
      // fresh Response carrying the same text.
      const text = await res.text();
      if (RATE_LIMITED.test(text) && !last) {
        lastCause = new Error("rate limited");
        tried.push(`${url} (rate limited)`);
        continue;
      }
      if (!custom && order[k] !== preferred) prefer(order[k] as number);
      return new Response(text, { status: res.status, headers: res.headers });
    } catch (cause) {
      lastCause = cause;
      // AbortError = our timeout, TypeError = the browser could not connect
      // (seen live 2026-09-07; the cause used to be thrown away).
      const c = cause as { name?: string; message?: string } | undefined;
      const why = c?.name === "AbortError"
        ? `no answer within ${limit / 1000}s`
        : c?.message ? `${c.name ?? "error"}: ${c.message}` : "no response";
      tried.push(`${url} (${why})`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!custom) prefer((preferred + 1) % MAGI_NODES.length);
  throw new MagiUnreachableError(`MAGI node unreachable — tried ${tried.join("; ")}`, lastCause);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAGI_NODES, currentMagiNode, magiFetch, pickFastestNode } from "./magi-nodes.js";

const ok = () => new Response('{"data":{}}', { status: 200 });
const as = (f: (url: string) => Promise<Response>) => f as unknown as typeof fetch;

test("a dead node is skipped, and the node that answered is tried first after", async () => {
  const seen: string[] = [];
  const dead = MAGI_NODES[0];
  const f = as(async (url) => {
    seen.push(url);
    if (url === dead) throw new TypeError("Failed to fetch");
    return ok();
  });
  assert.equal((await magiFetch("{}", { url: dead, fetch: f })).status, 200);
  assert.deepEqual(seen, [MAGI_NODES[0], MAGI_NODES[1]]);
  assert.equal(currentMagiNode(), MAGI_NODES[1]);
  seen.length = 0;
  await magiFetch("{}", { url: dead, fetch: f });
  assert.deepEqual(seen, [MAGI_NODES[1]]);
});

test("a gateway error fails over", async () => {
  const seen: string[] = [];
  const f = as(async (url) => {
    seen.push(url);
    return seen.length === 1 ? new Response("", { status: 502 }) : ok();
  });
  assert.equal((await magiFetch("{}", { fetch: f })).status, 200);
  assert.equal(seen.length, 2);
});

test("a rate limit inside a 200 moves to the next node", async () => {
  // The live shape: HTTP 200, GraphQL error, no data. Seen 2026-09-21.
  const seen: string[] = [];
  const limited = '{"errors":[{"message":"rate limit exceeded: max 30 simulation requests per minute"}]}';
  const f = as(async (url) => {
    seen.push(url);
    return seen.length === 1 ? new Response(limited, { status: 200 }) : ok();
  });
  const res = await magiFetch("{}", { fetch: f });
  assert.equal(seen.length, 2, "it must try another node, which has its own budget");
  assert.equal(await res.text(), '{"data":{}}', "the body survives being peeked at");
});

test("when every node is rate-limited the error is reported, not swallowed", async () => {
  const limited = '{"errors":[{"message":"rate limit exceeded: max 30 simulation requests per minute"}]}';
  const f = as(async () => new Response(limited, { status: 200 }));
  const res = await magiFetch("{}", { fetch: f });
  assert.match(await res.text(), /rate limit exceeded/, "the last node's answer is handed back honestly");
});

test("a private node is used alone", async () => {
  const seen: string[] = [];
  const f = as(async (url) => { seen.push(url); throw new TypeError("down"); });
  await assert.rejects(magiFetch("{}", { url: "http://localhost:9999/graphql", fetch: f }), /localhost:9999/);
  assert.deepEqual(seen, ["http://localhost:9999/graphql"]);
});

test("when every node fails, the error names each one", async () => {
  const f = as(async () => { throw new TypeError("down"); });
  const err = await magiFetch("{}", { fetch: f }).catch((e: Error) => e);
  for (const n of MAGI_NODES) assert.ok(String((err as Error).message).includes(n));
});

/**
 * ⚠️ THESE TWO RUN LAST because they move the remembered node, which the
 * tests above assert on.
 *
 * Failover only ever noticed a node being DEAD. A node that merely answers
 * slowly was kept forever — and that is the common case. Measured on
 * production 1 Oct: the same mint took 2.5 s on one public node and under a
 * second on another, purely because of which one the browser had remembered
 * weeks earlier when a different node went dark.
 */
test("the node that answers first is the one that gets remembered", async () => {
  const slow = MAGI_NODES[0] as string;
  const fast = MAGI_NODES[1] as string;
  const f = as(async (url) => {
    if (url === fast) return ok();
    // Slow enough to lose the race, fast enough not to slow the suite.
    await new Promise((r) => setTimeout(r, 80));
    return ok();
  });
  await pickFastestNode({ fetch: f });
  assert.equal(currentMagiNode(), fast, "a slower node was kept");
  assert.notEqual(currentMagiNode(), slow);
});

test("a cold connection does not lose to a node we are already talking to", async () => {
  // ⚠️ THE BUG THIS PINS, found on production 2 Oct. The first request to a
  // node pays DNS and TLS; the node the app is already using has paid that
  // long ago. One cold request each therefore hands the race to the incumbent
  // — the exact node we might need to escape. Measured from Copenhagen:
  // okinoko 226, 79, 68 ms against techcoderx 217, 254, 307 ms. Cold they look
  // alike; warm, one is three times the other.
  const incumbent = MAGI_NODES[0] as string;
  const genuinelyFaster = MAGI_NODES[1] as string;
  const calls = new Map<string, number>();
  const f = as(async (url) => {
    const n = (calls.get(url) ?? 0) + 1;
    calls.set(url, n);
    // The incumbent is warm throughout but slow; the challenger pays a big
    // handshake once and is quick afterwards.
    const ms = url === incumbent ? 60 : (n === 1 ? 200 : 5);
    await new Promise((r) => setTimeout(r, ms));
    return ok();
  });
  await pickFastestNode({ fetch: f });
  assert.equal(
    currentMagiNode(), genuinelyFaster,
    "the probe kept the incumbent because it only ever measured cold requests",
  );
  assert.ok((calls.get(genuinelyFaster) ?? 0) >= 2, "no warm-up request was made");
});

test("a probe that nothing answers keeps the node we had", async () => {
  // Offline, or every node down. Losing the remembered node here would be
  // strictly worse than keeping it: failover still runs on every request.
  const before = currentMagiNode();
  await pickFastestNode({ fetch: as(async () => { throw new TypeError("Failed to fetch"); }) });
  assert.equal(currentMagiNode(), before);
});

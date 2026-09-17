import { test } from "node:test";
import assert from "node:assert/strict";
import { MAGI_NODES, currentMagiNode, magiFetch } from "./magi-nodes.js";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { MagiBackend } from "./magi-backend.js";

const tx = (id: string, from: string, to: string, amount: string) => ({
  id, anchr_ts: "2026-11-03T18:08:18", status: "CONFIRMED",
  required_auths: [from], required_posting_auths: [], output: null,
  ops: [{ type: "transfer", data: { amount, asset: "hbd", from, to, memo: "" } }],
});

/** A node that, like the real ones since at least 3 Nov 2026, has no byLedgerToFrom. */
const backend = () => new MagiBackend({
  url: "http://node.test/graphql",
  contractId: "vsc1core",
  fetch: (async (_url: string, init: { body: string }) => {
    const { query } = JSON.parse(init.body) as { query: string };
    if (query.includes("byLedgerToFrom")) return new Response('{"errors":[{"message":"not defined"}]}', { status: 422 });
    const rows = query.includes("byAccount")
      ? [tx("in", "hive:lasseehlers", "hive:angeloextreme", "2.000"),
         tx("out", "hive:angeloextreme", "hive:lasseehlers", "1.000")]
      : [{ id: "lc", anchr_ts: "2026-11-03T18:00:00", status: "CONFIRMED",
           required_auths: ["hive:lasseehlers"], required_posting_auths: [],
           ops: [{ type: "call", data: { action: "transfer", payload: "hive:angeloextreme|100000000" } }] }];
    return new Response(JSON.stringify({ data: { findTransaction: rows } }), { status: 200 });
  }) as unknown as typeof fetch,
});

test("HBD sent and received both show, from byAccount", async () => {
  const ops = await backend().accountOps("angeloextreme");
  const row = (id: string) => ops.find((o) => o.id === id);
  assert.equal(row("in")?.action, "+ledger");
  assert.equal(row("in")?.payload, "hive:lasseehlers|hive:angeloextreme|2.000|hbd");
  assert.equal(row("out")?.action, "ledger");
});

test("incoming LASSECASH still shows beside them", async () => {
  const ops = await backend().accountOps("angeloextreme");
  assert.equal(ops.find((o) => o.id === "lc")?.action, "+transfer");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { INDEX_PAGE, MemoryIndexStore, syncIndex, type IndexedTx } from "./indexer.js";

/** A fake chain: `log` is oldest-first; the node answers newest-first. */
function chain(n: number) {
  const log: IndexedTx[] = [];
  const add = (status = "CONFIRMED") => {
    const h = log.length + 1;
    log.push({
      id: `tx${h}`, anchr_height: h, anchr_ts: `t${h}`, status,
      required_auths: ["hive:a"], required_posting_auths: [],
      ops: [{ type: "call", data: { action: "vote", payload: `p${h}` } }],
    });
  };
  for (let i = 0; i < n; i++) add();
  let calls = 0;
  const fetchPage = async (offset: number) => {
    calls += 1;
    return [...log].reverse().slice(offset, offset + INDEX_PAGE).map((t) => ({ ...t }));
  };
  return { log, add, fetchPage, calls: () => calls };
}

test("first sync backfills the whole history", async () => {
  const c = chain(318);
  const s = new MemoryIndexStore();
  const r = await syncIndex(c.fetchPage, s);
  assert.equal(s.txs.size, 318);
  assert.equal(r.complete, true);
  assert.equal(r.pages, 4);
  assert.equal(s.all()[0]?.id, "tx318");
});

test("a later sync reads only the head", async () => {
  const c = chain(318);
  const s = new MemoryIndexStore();
  await syncIndex(c.fetchPage, s);
  for (let i = 0; i < 5; i++) c.add();
  const r = await syncIndex(c.fetchPage, s);
  assert.equal(r.added, 5);
  assert.equal(r.pages, 1);
  assert.equal(s.txs.size, 323);
});

test("a pending status is corrected once it settles", async () => {
  const c = chain(150);
  c.add("UNCONFIRMED");
  const s = new MemoryIndexStore();
  await syncIndex(c.fetchPage, s);
  assert.equal(s.txs.get("tx151")!.status, "UNCONFIRMED");
  c.log[150]!.status = "FAILED";
  await syncIndex(c.fetchPage, s);
  assert.equal(s.txs.get("tx151")!.status, "FAILED");
});

test("a backfill longer than one call resumes where it stopped", async () => {
  const c = chain(950);
  const s = new MemoryIndexStore();
  const r1 = await syncIndex(c.fetchPage, s, 3);
  assert.equal(r1.complete, false);
  assert.equal(s.txs.size, 300);
  c.add(); c.add(); // arrivals between calls shift every offset
  let calls = 1, last = r1;
  while (!last.complete && calls < 10) { last = await syncIndex(c.fetchPage, s, 3); calls += 1; }
  assert.equal(last.complete, true);
  assert.equal(s.txs.size, 952);
  assert.equal(calls, 5); // 1 head page + 2 backfill pages per call after the first
  // And once complete, a quiet chain costs one page.
  const r5 = await syncIndex(c.fetchPage, s, 3);
  assert.equal(r5.pages, 1);
  assert.equal(r5.added, 0);
});

test("an empty chain is complete and stores nothing", async () => {
  const c = chain(0);
  const s = new MemoryIndexStore();
  const r = await syncIndex(c.fetchPage, s);
  assert.equal(r.complete, true);
  assert.equal(s.txs.size, 0);
});

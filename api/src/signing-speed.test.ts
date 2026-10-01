/**
 * THE WAIT BETWEEN THE PRESS AND THE WALLET.
 *
 * Before a wallet ever opens, the site asks the chain whether the call would
 * actually succeed — which is why a transaction the chain would refuse never
 * reaches the user and never costs them credits. That check is worth keeping.
 * What was not worth keeping was doing it one request at a time.
 *
 * A mint carrying catch-up slices used to walk a public node in series: read
 * the meter, dry-run slice one, read the meter, dry-run slice two, read the
 * meter, dry-run the mint. Seven or eight round trips, all before the press
 * did anything visible, and every one of them on a node shared with everyone
 * else on the chain.
 *
 * These are the two properties that fixed it, and both are easy to lose by
 * accident in an ordinary-looking edit — an `await` moved one line up puts the
 * serial version back with no test failing anywhere else. So they are pinned:
 *
 *   1. The meter is read ONCE per click, however many calls are sized.
 *   2. The dry runs are IN FLIGHT TOGETHER, not one after the other.
 *
 * Nothing about what gets signed changes here. The same calls are simulated,
 * the same limits come out, the same refusals happen — only the waiting is
 * gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AiohaSigner, AiohaWallet } from "./aioha-signer.js";

/**
 * A wallet with no browser providers, so it can be built outside a browser.
 * Everything under test here is node I/O, not wallet I/O.
 */
function headlessWallet() {
  return new AiohaWallet({
    contractId: "vsc1Test",
    chainUrl: "https://node.example/graphql",
    keychain: false,
    hiveAuth: false,
    peakVault: false,
  });
}

test("the RC meter is read once per click, not once per call sized", async () => {
  const wallet = headlessWallet();
  const realFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async () => {
    reads++;
    return new Response(
      JSON.stringify({ data: { getAccountRC: { amount: 25_000, max_rcs: 31_000 } } }),
      { status: 200 },
    );
  }) as typeof globalThis.fetch;
  try {
    // Sizing a transaction asks for the meter repeatedly: the HBD probe wants
    // it before the dry run, the clamp wants it after, and catch-up slices and
    // settlements each want it too. On a public node that was a round trip
    // every time, in series, before the wallet opened.
    const answers = await Promise.all([
      wallet.availableRc("hive:alice"),
      wallet.availableRc("hive:alice"),
      wallet.availableRc("hive:alice"),
      wallet.availableRc("hive:alice"),
    ]);
    assert.deepEqual(answers, [25_000, 25_000, 25_000, 25_000]);
    assert.equal(reads, 1, `the meter was fetched ${reads} times for one click`);

    // Overlapping callers share the request in flight, so parallel sizing does
    // not stampede the node either.
    assert.equal(await wallet.availableRc("hive:alice"), 25_000);
    assert.equal(reads, 1);

    // ...and the moment anything is signed the reading is void.
    wallet.forgetRc();
    await wallet.availableRc("hive:alice");
    assert.equal(reads, 2, "a stale meter survived a broadcast");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** A wallet that records how its node was used and answers instantly. */
function spyWallet() {
  const log = { forgotten: 0, simStarted: 0, maxConcurrentSims: 0, inFlight: 0 };
  let release: (() => void)[] = [];
  const wallet = {
    // Dry runs are held open until every one of them has started, so "they
    // overlapped" is observed rather than inferred from timing.
    async simulate() {
      log.simStarted++;
      log.inFlight++;
      log.maxConcurrentSims = Math.max(log.maxConcurrentSims, log.inFlight);
      await new Promise<void>((r) => release.push(r));
      log.inFlight--;
      return { ok: true as const, gas: 1_000_000 };
    },
    async availableRc() { return 30_000; },
    async tokenContract() { return undefined; },
    forgetRc() { log.forgotten++; },
    async broadcastCalls() {
      return { ok: true, msg: "submitted", height: 0, txId: "abc" };
    },
    aioha: {
      async vscCallContract() { return { success: true, result: "abc" }; },
    },
  } as unknown as AiohaWallet;
  return { wallet, log, releaseAll: () => { release.forEach((r) => r()); release = []; } };
}

/** Start a submit, let every dry run reach the node, then let them finish. */
async function runSubmit(
  signer: AiohaSigner,
  releaseAll: () => void,
  opts?: Parameters<AiohaSigner["submit"]>[2],
  inspect?: () => void,
) {
  const done = signer.submit("mint", "100000000|30", opts);
  await new Promise((r) => setTimeout(r, 20));
  inspect?.();
  releaseAll();
  // sizeRc may start late work after its simulation resolves; drain rather
  // than deadlock.
  await new Promise((r) => setTimeout(r, 20));
  releaseAll();
  return done;
}

test("the dry runs go out together, not one after the other", async () => {
  const { wallet, log, releaseAll } = spyWallet();
  const signer = new AiohaSigner(wallet, "hive:alice", "vsc1Test", 2_000);

  const res = await runSubmit(signer, releaseAll, {
    preCalls: [
      { entrypoint: "advance", args: "" },
      { entrypoint: "advance", args: "" },
    ],
    sideCalls: [{ entrypoint: "payout", args: "hive:bob|a-post" }],
  }, () => {
    // Two catch-up slices, the mint, and one settlement — all four must
    // already be waiting on the node. Sized in series, only the first would
    // have started and this reads 1.
    assert.equal(
      log.maxConcurrentSims, 4,
      `only ${log.maxConcurrentSims} dry run(s) were in flight — sizing is serial again`,
    );
  });
  assert.equal(res.ok, true);
});

test("a lone call forgets the meter too, not just a bundled one", async () => {
  // A transaction with no slices and no settlements does not go through the
  // bundling path, so it has to void the reading itself. Missing this meant
  // the next click inside the cache window sized itself against credits this
  // one had already spent.
  const { wallet, log, releaseAll } = spyWallet();
  const signer = new AiohaSigner(wallet, "hive:alice", "vsc1Test", 2_000);

  const res = await runSubmit(signer, releaseAll);
  assert.equal(res.ok, true);
  assert.ok(log.forgotten > 0, "a lone call left a stale meter reading behind");
});

/**
 * THE CATCH-UP READS, STARTED EARLY AND SHARED.
 *
 * A mint press costs four sequential node round trips: the form confirms the
 * share rate, `catchUp` reads where the accrual walk stands, reads how many
 * mints mature on those days, and then the call is dry-run. The rate check and
 * the catch-up reads need nothing from each other, so the form starts them
 * together — but only if the warm-up and the press that follows SHARE one pair
 * of reads instead of each making their own.
 *
 * Hence a cache, and hence this test. It is deliberately engine-free: the
 * promise is cached before anything is awaited, so identity proves the sharing
 * whatever the reads themselves return.
 */
import { LasseCashClient } from "./client.js";
import type { Backend } from "./backend.js";

function bareClient() {
  // Reads are irrelevant here; what is under test is who asks, and how often.
  const backend = {
    async state() { return {}; },
    async chain() { return { height: 0 } as never; },
  } as unknown as Backend;
  return new LasseCashClient({ backend });
}

test("warming and pressing share one pair of catch-up reads", () => {
  const c = bareClient();
  c.warmCatchUp();
  // The press, a moment later, must land on the warm-up's own promise — not
  // start a second pair of reads and wait for them.
  assert.equal(c.catchUp(), c.catchUp(), "each call started its own reads");
});

test("anything signed spends the cached catch-up reading", async () => {
  // A transaction may have carried the slices away with it, so the next press
  // must look again rather than bundle slices that are already sent.
  const c = bareClient();
  const before = c.catchUp();
  await c.burn("1").catch(() => {}); // no signer: clears the cache, then refuses
  assert.notEqual(c.catchUp(), before, "a stale catch-up survived a transaction");
});

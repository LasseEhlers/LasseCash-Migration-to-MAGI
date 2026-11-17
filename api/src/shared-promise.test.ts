import { test } from "node:test";
import assert from "node:assert/strict";
import { joinShared, isCrossRequestError } from "./shared-promise.js";

const DEAD = new Error("This promise was created by a request that has since ended, so it can never settle.");

test("a shared build from an ended request is replaced by our own", async () => {
  assert.equal(isCrossRequestError(DEAD), true);
  assert.equal(await joinShared(Promise.reject(DEAD), async () => "own"), "own");
});

test("an ordinary failure keeps its meaning", async () => {
  await assert.rejects(joinShared(Promise.reject(new Error("node down")), async () => "own"), /node down/);
});

test("a healthy shared build is used as is", async () => {
  assert.equal(await joinShared(Promise.resolve("shared"), async () => "own"), "shared");
});

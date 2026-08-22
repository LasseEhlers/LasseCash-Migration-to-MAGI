/**
 * Tagged posts from any Hive frontend.
 *
 * THE RULE, and the reason it is tested rather than eyeballed: a post on Hive
 * tagged `lassecash` whose AUTHOR holds the viral posting threshold in
 * L-Shares is SHOWN on LasseCash before anybody registers it. It earns nothing
 * until the first vote, which is what registers it. Getting this wrong in
 * either direction is bad — showing an ineligible author's post promises a
 * registration the chain will refuse, and hiding an eligible one silently
 * withholds the whole feature.
 *
 * `mergeTagged` is the pure half, split out precisely so it can be tested with
 * no network and no chain: hand it a stubbed `bridge.get_ranked_posts`
 * response and it must decide identically to the contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadEngine, constants } from "./engine.js";
import { mergeTagged, type HiveTaggedPost } from "./magi-backend.js";
import { toBaseUnitArg } from "./amount.js";

createRequire(import.meta.url)("./wasm/wasm_exec.cjs");
const { readFile } = await import("node:fs/promises");
await loadEngine(undefined, await readFile(new URL("./wasm/engine.wasm", import.meta.url)));

/** The viral threshold in force in these fixtures: 1,000 L-Shares. */
const THRESHOLD = toBaseUnitArg("1000");

function row(over: Partial<HiveTaggedPost> = {}): HiveTaggedPost {
  return {
    author: "alice",
    permlink: "hello-world",
    title: "Hello World",
    body: "the body",
    created: "2026-08-22T09:14:12",
    depth: 0,
    json_metadata: {},
    ...over,
  };
}

const RICH = { "hive:alice": toBaseUnitArg("5000"), "hive:bob": toBaseUnitArg("1000") };

test("an eligible author's tagged post is shown, unregistered", () => {
  const out = mergeTagged([], [row()], RICH, THRESHOLD);
  assert.equal(out.length, 1);
  const p = out[0]!;
  assert.equal(p.registered, false);
  // The chain address, never the bare Hive name — a vote is keyed by it.
  assert.equal(p.author, "hive:alice");
  assert.equal(p.permlink, "hello-world");
  assert.equal(p.window, "viral", "a vote can only ever open the viral window");
  assert.equal(p.title, "Hello World");
  assert.equal(p.body_excerpt, "the body");
});

test("EVERY economic field is a zero, not an estimate", () => {
  const p = mergeTagged([], [row()], RICH, THRESHOLD)[0]!;
  assert.equal(p.pending_payout, "0.00000000");
  assert.equal(p.curator_pot, "0.00000000");
  assert.equal(p.promoted, "0.00000000");
  assert.equal(p.rshares, "0");
  assert.equal(p.votes, 0);
  assert.equal(p.paid_out, false);
  assert.equal(p.payable, false, "a post with no window cannot have a closed one");
  assert.equal(p.created_height, 0, "there is no registration height to report");
  assert.equal(p.payout_height, 0);
  assert.equal(p.curation_expires_at, 0);
});

test("the threshold is the ENGINE's, at the base unit", () => {
  // Exactly at the threshold qualifies; one base unit short does not. This is
  // engine.CanPost — the same comparison the contract makes before it will
  // accept a post — and it must not be re-derived anywhere.
  const shares = {
    "hive:alice": THRESHOLD,
    "hive:bob": (BigInt(THRESHOLD) - 1n).toString(),
  };
  const rows = [row({ author: "alice" }), row({ author: "bob", permlink: "bobs-post" })];
  const got = mergeTagged([], rows, shares, THRESHOLD).map((p) => p.author);
  assert.deepEqual(got, ["hive:alice"]);
});

test("an author with no shares row at all is refused, never defaulted", () => {
  // A missing key on MAGI reads back as an empty string, not as absent. It
  // must mean "no shares", which is below every threshold — the floor is one
  // L-Share, so nobody is admitted by an absent row.
  const rows = [row({ author: "nobody", permlink: "p" })];
  assert.deepEqual(mergeTagged([], rows, {}, THRESHOLD), []);
  assert.deepEqual(mergeTagged([], rows, { "hive:nobody": "" }, THRESHOLD), []);
});

test("a post the chain already knows about is never duplicated", () => {
  const registered = [{ author: "hive:alice", permlink: "hello-world" }];
  assert.deepEqual(mergeTagged(registered, [row()], RICH, THRESHOLD), []);
});

test("the same tagged post twice in one response yields one row", () => {
  const out = mergeTagged([], [row(), row()], RICH, THRESHOLD);
  assert.equal(out.length, 1);
});

test("replies are not articles, and depth is what says so", () => {
  // A reply on Hive is a comment record here, and comments arrive through the
  // `comment` entrypoint. One surfacing in the feed as an article would put an
  // unregisterable row in front of every reader.
  //
  // ⚠️ `bridge.get_ranked_posts` does NOT return `parent_author` — verified
  // against api.hive.blog 2026-08-22 — so a check that looked only at that
  // field would let every reply through. `depth` is the field that is there.
  assert.deepEqual(mergeTagged([], [row({ depth: 1 })], RICH, THRESHOLD), []);
  assert.deepEqual(mergeTagged([], [row({ parent_author: "carol" })], RICH, THRESHOLD), []);
  // depth 0, no parent: a root post, and the listing omits parent_author.
  assert.equal(mergeTagged([], [row({ depth: 0 })], RICH, THRESHOLD).length, 1);
});

test("metadata is read whether Hive parsed it or not", () => {
  // VERIFIED against api.hive.blog 2026-08-22: `bridge.get_ranked_posts`
  // returns json_metadata as an OBJECT, while `condenser_api.get_content`
  // returns the same field as a STRING. Reading only the string form loses
  // every tag and description, which looks exactly like an author who never
  // filled them in.
  const meta = { description: "a summary", tags: ["lassecash", "ancap"] };
  for (const form of [meta, JSON.stringify(meta)]) {
    const p = mergeTagged([], [row({ json_metadata: form })], RICH, THRESHOLD)[0]!;
    assert.equal(p.summary, "a summary");
    assert.deepEqual(p.tags, ["lassecash", "ancap"]);
  }
});

test("malformed author metadata is the author's problem, not a crash", () => {
  const p = mergeTagged([], [row({ json_metadata: "{not json" })], RICH, THRESHOLD)[0]!;
  assert.equal(p.summary, "");
  assert.equal(p.tags, null);
});

test("Hive's zone-less timestamps are read as UTC", () => {
  // Hive stamps `2026-08-22T09:14:12` with no suffix. Read as local time it
  // would be hours out, which is enough to reorder a chronological feed.
  const p = mergeTagged([], [row({ created: "2026-08-22T09:14:12" })], RICH, THRESHOLD)[0]!;
  assert.equal(p.created_time, "2026-08-22T09:14:12.000Z");
});

test("a junk row cannot become a post", () => {
  const rows = [
    { author: "", permlink: "x" },
    { author: "alice", permlink: "" },
  ] as HiveTaggedPost[];
  assert.deepEqual(mergeTagged([], rows, RICH, THRESHOLD), []);
});

test("the threshold key the backend reads is the engine's, not a literal", () => {
  assert.equal(constants().paramPostThresholdViral, "post.threshold_viral");
});

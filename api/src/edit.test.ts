/**
 * Editing a post is a CONTENT write and nothing else.
 *
 * The rule this file exists to keep: an edit must never reach the chain. A
 * post's window, payout mode and accumulated rshares froze the moment it was
 * registered, and curators vote on the strength of what they read — if fixing
 * a typo could also change the payout mode, every curator's share would depend
 * on text the author can rewrite after the vote.
 *
 * So the test is adversarial about the one thing that would break that: it
 * fails if `editPost` makes ANY contract call, by handing it a signer whose
 * every chain method throws.
 *
 * It also pins the category round trip, which is not cosmetic. Hive refuses a
 * comment operation whose parent changed, and a post registered here by its
 * first vote may well have been written on another frontend, in another
 * category. Sending our own back would make such a post uneditable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MagiBackend } from "./magi-backend.js";
import type { Signer } from "./backend.js";

/** A signer that can write to Hive and screams if the chain is touched. */
function contentOnlySigner() {
  const calls: { permlink: string; title: string; body: string; tags: string[]; category?: string }[] = [];
  const signer = {
    account: "hive:alice",
    async submit(): Promise<never> {
      throw new Error("editing must not call the contract");
    },
    async publishToHive(): Promise<never> {
      throw new Error("an edit is not a publish");
    },
    async editOnHive(input: {
      permlink: string; title: string; body: string; tags: string[];
      summary?: string; image?: string | null; category?: string;
    }) {
      calls.push({
        permlink: input.permlink, title: input.title, body: input.body,
        tags: input.tags, ...(input.category ? { category: input.category } : {}),
      });
    },
  } as unknown as Signer;
  return { signer, calls };
}

function backend() {
  return new MagiBackend({
    contractId: "vsc1Test",
    // Any network use at all would be a bug in this path: an edit reads
    // nothing and broadcasts nothing through a node.
    fetch: () => { throw new Error("editing must not touch a MAGI node"); },
  });
}

test("editing a post writes to the content layer and never calls the chain", async () => {
  const { signer, calls } = contentOnlySigner();
  const res = await backend().editPost({
    permlink: "my-post",
    title: "Fixed title",
    body: "Fixed body",
    summary: "a summary",
    tags: ["energy", "ancap"],
    signer,
  });
  assert.equal(res.ok, true);
  assert.equal(res.permlink, "my-post", "the address must come back unchanged");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.title, "Fixed title");
  assert.equal(calls[0]?.body, "Fixed body");
});

test("an edit sends the post's own Hive category back unchanged", async () => {
  const { signer, calls } = contentOnlySigner();
  // Written on another frontend, registered here by its first vote: its
  // category is whatever ITS first tag was, and Hive will refuse any other.
  await backend().editPost({
    permlink: "someone-elses-category",
    title: "t", body: "b", summary: "", tags: ["lassecash"],
    category: "hive-167922",
    signer,
  });
  assert.equal(calls[0]?.category, "hive-167922");
});

test("editing refuses a signer that cannot write to Hive, rather than skipping it", async () => {
  // A backend that quietly did nothing would report success while the post
  // stayed as it was — the author would believe a correction had landed.
  const signer = { account: "hive:alice" } as unknown as Signer;
  await assert.rejects(
    () => backend().editPost({
      permlink: "p", title: "t", body: "b", summary: "", tags: [], signer,
    }),
    /wallet/,
  );
});

test("editing nothing is refused before any write", async () => {
  const { signer, calls } = contentOnlySigner();
  const res = await backend().editPost({
    permlink: "", title: "t", body: "b", summary: "", tags: [], signer,
  });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});

/**
 * THE RULE THAT PROTECTS OTHER APPS' POSTS.
 *
 * A post tagged `lassecash` from any frontend is registered here by its first
 * vote, so the Edit button appears on posts we did not publish. Actifit,
 * Waivio and the NFT apps identify their own posts by `json_metadata` fields
 * and pay out on that basis. An edit that replaced the metadata would cost
 * their author money somewhere else — for fixing a typo on our site.
 */
import { editMetadata, postMetadata } from "./hive-metadata.js";

const FIELDS = {
  author: "jjprac",
  permlink: "my-actifit-report-card-september-22-2026",
  tags: ["lassecash", "actifit"],
  summary: "a new summary",
  image: "https://files.peakd.com/x.png",
  siteUrl: "https://lassecash.com",
};

test("editing somebody else's app's post keeps the fields that app pays on", () => {
  const actifit = {
    app: "actifit/1.4.0",
    format: "markdown",
    tags: ["actifit", "lassecash"],
    description: "the original",
    // Actifit's own payload — invisible to us, load-bearing to them.
    appData: { activity_count: 10432, activity_type: "Walking" },
  };
  const out = editMetadata(actifit, FIELDS);
  assert.equal(out.app, "actifit/1.4.0", "their app id must survive our edit");
  assert.deepEqual(out.appData, actifit.appData, "unknown fields must survive");
  // What the author actually changed, and only that.
  assert.deepEqual(out.tags, FIELDS.tags);
  assert.equal(out.description, "a new summary");
  assert.deepEqual(out.image, [FIELDS.image]);
  // We do not claim to be the publisher of a post we did not publish.
  assert.equal(out.canonical_url, undefined);
});

test("editing our own post keeps our canonical claim and our app id", () => {
  // Published here, so the metadata is already ours: an edit must leave the
  // SEO ownership exactly where publishing put it.
  const ours = postMetadata({ ...FIELDS, summary: "the original" }) as unknown as Record<string, unknown>;
  const out = editMetadata(ours, { ...FIELDS, summary: "edited" });
  assert.equal(out.app, "lassecash/2.0");
  assert.equal(
    out.canonical_url,
    "https://lassecash.com/@jjprac/my-actifit-report-card-september-22-2026",
  );
  assert.equal(out.description, "edited");
});

test("a post with no claim at all is still not claimed by editing it", () => {
  // Written in some bare client, registered here by its first vote. One Edit
  // click must not hand us the search ranking for it — `canonical_url` is a
  // statement about origin, and ours would be false. `format` is supplied
  // because it only says how to render the body.
  const out = editMetadata(null, FIELDS);
  assert.equal(out.app, undefined);
  assert.equal(out.canonical_url, undefined);
  assert.equal(out.format, "markdown");
});

test("removing the cover image from the body removes it from the metadata", () => {
  // Left behind, a stale `image` makes every frontend keep showing a picture
  // the author deleted.
  const out = editMetadata({ image: ["https://old/x.png"] }, { ...FIELDS, image: null });
  assert.equal(out.image, undefined);
});

/**
 * THE REAL SIGNER MUST FORWARD EVERY CONTENT METHOD.
 *
 * The backend is handed a Signer, never the wallet, and `AiohaSigner`
 * forwards the wallet's content methods one explicit line at a time. It
 * REFUSES rather than skips when one is missing — which is right, but it
 * means a forgotten line reports "needs a wallet that can write to Hive" to
 * someone whose wallet is connected and working.
 *
 * That shipped on 1 Oct: `editOnHive` was implemented on the wallet and
 * nowhere else, so every Save was refused. The tests above did not catch it
 * because they hand `editPost` a hand-rolled stub signer — which is the right
 * way to test the RULES, and no way at all to test the WIRING.
 */
import { AiohaSigner, AiohaWallet } from "./aioha-signer.js";

test("the signer the app actually uses forwards every content write", () => {
  // The prototype, not an instance: building a signer needs a logged-in
  // wallet, and this is about method wiring, not about being signed in.
  const forwarded = AiohaSigner.prototype as unknown as Record<string, unknown>;
  const onWallet = AiohaWallet.prototype as unknown as Record<string, unknown>;
  for (const method of ["publishToHive", "publishCommentToHive", "editOnHive"]) {
    assert.equal(
      typeof onWallet[method], "function",
      `AiohaWallet is missing ${method}`,
    );
    assert.equal(
      typeof forwarded[method], "function",
      `AiohaSigner does not forward ${method} — the backend will refuse it `
        + `with "needs a wallet that can write to Hive", on a working wallet`,
    );
  }
});

/**
 * A HOLDER MUST NEVER READ A FILE OFFSET.
 *
 * The float shortfall surfaces as the TOKEN's `Insufficient balance` — capital
 * I, because our own contract says it lowercase. Shown raw it reaches the mint
 * card as `msg: Insufficient balance file: :65460:65460`, under a badge
 * reading READY TO CLAIM, which tells a holder nothing and looks exactly like
 * their money has gone. It has not: the position is on chain and nothing
 * expires before 29 December.
 *
 * CLAUDE.md's rule is older than this bug — contract messages are diagnostics
 * and must never be rendered verbatim — and this is the case that proves why.
 */
test("the token's refusal is translated, never shown raw", async () => {
  const wallet = {
    async simulate() {
      return {
        ok: false as const,
        msg: "msg: Insufficient balance\nfile: :65460:65460",
        gasLimitHit: false,
      };
    },
    async availableRc() { return 30_000; },
    async tokenContract() { return undefined; },
    forgetRc() {},
  } as unknown as import("./aioha-signer.js").AiohaWallet;

  const { AiohaSigner } = await import("./aioha-signer.js");
  const signer = new AiohaSigner(wallet, "hive:alice", "vsc1Test", 2_000);
  const res = await signer.submit("claim_mint", "1");

  assert.equal(res.ok, false);
  assert.doesNotMatch(res.msg, /file:|65460/, "a file offset reached the user");
  assert.match(res.msg, /safe/i, "it must say the position is safe");
  assert.match(res.msg, /29 December/, "it must say nothing expires");
});

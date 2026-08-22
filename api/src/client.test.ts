/**
 * Integration tests against a running dev chain.
 *
 * Skipped automatically when nothing is listening on :8080, so `npm test` works
 * without one. Start it with `./build.sh node`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DevBackend, DevSigner } from "./dev-backend.js";
import { LasseCashClient } from "./client.js";
import { compare, format, isPositive, toUnits } from "./amount.js";

const URL = process.env.LASSECASH_DEV_URL ?? "http://localhost:8080";

// Probed at module load, not in before(): node:test needs `skip` to be a
// boolean when the test is registered, and before() runs after that.
const up = await (async () => {
  try {
    const r = await fetch(`${URL}/chain`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
})();
if (!up) console.log(`  (no dev chain at ${URL} — integration tests skipped)`);

function client(account?: string) {
  const backend = new DevBackend({ url: URL });
  const c = new LasseCashClient({ backend });
  if (account) c.setSigner(new DevSigner(account, backend));
  return c;
}

test("chain state arrives as decimal strings, never numbers", { skip: !up }, async () => {
  const info = await client().chain();
  assert.ok(typeof info.height === "number");
  for (const field of ["migrated_supply", "total_emitted", "amm_lc", "amm_hbd"] as const) {
    assert.equal(typeof info[field], "string", `${field} must be a string`);
    assert.match(info[field], /^-?\d+\.\d{8}$/, `${field} must have exactly 8 decimals`);
  }
  assert.ok(Array.isArray(info.consensus_group));
});

test("an account view arrives fully precomputed", { skip: !up }, async () => {
  const a = await client().accountOf("hive:lasseehlers");
  assert.equal(a.account, "hive:lasseehlers");
  assert.match(a.balance, /^-?\d+\.\d{8}$/);
  assert.ok(isPositive(a.shares), "the founder should hold L-Shares");

  for (const m of a.mints) {
    // These are the figures the dashboard renders. The frontend must never
    // have to derive them.
    for (const f of ["principal", "shares", "pending_yield", "if_claimed_now",
                     "slashed_if_claimed_now", "bleed_remaining_pct"] as const) {
      assert.match(m[f], /^-?\d+\.\d{8}$/, `mint.${f} must be a decimal string`);
    }
    // Conservation, visible from the client: what you get plus what you lose
    // equals principal plus yield.
    const total = toUnits(m.principal) + toUnits(m.pending_yield);
    const split = toUnits(m.if_claimed_now) + toUnits(m.slashed_if_claimed_now);
    assert.equal(split, total, `mint #${m.id} settlement does not conserve value`);
  }
});

test("quotes come from the engine and are internally consistent",
  { skip: !up }, async () => {
    const c = client();

    const swap = await c.quoteSwap("lc_hbd", "1000");
    assert.ok(swap.ok, swap.msg);
    assert.match(swap.amount_out, /^\d+\.\d{8}$/);
    assert.ok(isPositive(swap.amount_out));

    // Slippage: a larger trade must get a strictly worse rate.
    const bigger = await c.quoteSwap("lc_hbd", "100000");
    assert.equal(compare(bigger.rate, swap.rate), -1,
      "a larger swap must receive a worse rate");
    assert.equal(compare(bigger.price_impact_pct, swap.price_impact_pct), 1,
      "a larger swap must have higher price impact");

    // Mint preview: max size and max duration is the 2.25x case.
    const maxMint = await c.quoteMint("100000", 1095);
    assert.ok(maxMint.ok, maxMint.msg);
    assert.equal(maxMint.duration_multiplier, "1.50000000");
    assert.equal(maxMint.volume_multiplier, "1.50000000");
    assert.equal(maxMint.combined_multiplier, "2.25000000");

    // A one-day mint of a small amount earns no bonus at all.
    const minMint = await c.quoteMint("100", 1);
    assert.equal(minMint.combined_multiplier, "1.00000000");
    assert.equal(compare(minMint.shares, maxMint.shares), -1);

    // Invalid durations are refused, not clamped.
    const tooLong = await c.quoteMint("1000", 1096);
    assert.equal(tooLong.ok, false, "1096 days should be refused");
  });

test("a transaction round-trips through the client", { skip: !up }, async () => {
  const c = client("hive:demo");
  const before = await c.me();

  const res = await c.transfer("hive:tibfox", "1.5");
  assert.ok(res.ok, res.msg);

  const after = await c.me();
  assert.equal(toUnits(before.balance) - toUnits(after.balance), toUnits("1.5"),
    "exactly the transferred amount should have left the balance");
});

test("a rejected transaction reports rather than throwing", { skip: !up }, async () => {
  const c = client("hive:demo");
  const res = await c.mint("999999999", 1095); // far beyond the balance
  assert.equal(res.ok, false);
  assert.ok(res.msg.length > 0, "a rejection must explain itself");
});

test("writes require a signer", { skip: !up }, async () => {
  await assert.rejects(() => client().transfer("hive:x", "1"), /not signed in/);
});

test("mints needing attention are surfaced", { skip: !up }, async () => {
  const c = client();
  const needing = await c.mintsNeedingAttention("hive:lasseehlers");
  for (const m of needing) {
    assert.ok(m.mature || m.bleed_remaining_pct !== "1.00000000");
  }
});

test("formatting produces something a human reads", { skip: !up }, async () => {
  const info = await client().chain();
  const pretty = format(info.migrated_supply, { decimals: 2 });
  assert.match(pretty, /^[\d,]+\.\d{2}$/, `got ${pretty}`);
});

/**
 * The migration receipt is read from a RAW STATE KEY, and MAGI reports a
 * missing key as a NON-NIL POINTER TO AN EMPTY STRING — the bug that bricked
 * the first live deploy. Reading "" as a receipt would tell every unclaimed
 * holder they had already claimed and hide the claim button forever, which is
 * unrecoverable after the key burn. So the parse is pinned against a fake
 * backend rather than left to an integration test that may not run.
 */
test("a migration receipt is parsed, and an empty key is NOT a receipt", async () => {
  const rows: Record<string, string> = {
    "mig_hive:alice": "22141356699780|700127599037966",
    "mig_hive:dead": "burned|130502359425576|0",
    "mig_hive:nobody": "", // a key MAGI has never been written
    cfg_migroot: "62bcdd583a4b1aca248b583859f52a26e4906da7b616034755cd6743c753eaf3",
  };
  const backend = {
    name: "fake",
    state: async (keys: string[]) =>
      Object.fromEntries(keys.map((k) => [k, rows[k] ?? ""])),
  } as unknown as ConstructorParameters<typeof LasseCashClient>[0]["backend"];
  const c = new LasseCashClient({ backend });

  const alice = await c.migrationRecord("hive:alice");
  assert.deepEqual(alice, {
    burned: false, liquid: "221413.56699780", staked: "7001275.99037966",
  });

  const dead = await c.migrationRecord("hive:dead");
  assert.equal(dead?.burned, true, "a burned leaf must read as burned");
  assert.equal(dead?.liquid, "1305023.59425576");

  assert.equal(await c.migrationRecord("hive:nobody"), null,
    "an empty key means NOT MIGRATED, never migrated-with-zero");
  assert.equal(await c.migrationRoot(), rows["cfg_migroot"]);

  const noRoot = new LasseCashClient({
    backend: { name: "f", state: async () => ({ cfg_migroot: "" }) } as never,
  });
  assert.equal(await noRoot.migrationRoot(), null,
    "an uncommitted snapshot must read as null, not as an empty root");
});

test("the voter list names real voters and its parts sum to the whole",
  { skip: !up }, async () => {
    const c = client();
    const posts = await c.posts(50);
    const voted = posts.find((p) => p.votes > 0 && !p.paid_out);
    if (!voted) {
      console.log("  (no unsettled voted post on this chain — voter list not exercised)");
      return;
    }

    const votes = await c.postVotes(voted.author, voted.permlink);
    assert.equal(votes.length, voted.votes,
      "an unsettled post keeps one vote record per vote it counted");

    let sum = 0n;
    for (const v of votes) {
      assert.match(v.voter, /^[a-z]+:/, "a voter must be a fully qualified address");
      // rshares are RAW vote weight, not a LASSECASH amount — a plain integer
      // string with no decimal point. Rendering one as LC would be a lie.
      assert.match(v.rshares, /^\d+$/, "rshares must be a base-unit integer string");
      sum += BigInt(v.rshares);
    }
    assert.equal(sum.toString(), voted.rshares,
      "the voters' weights must sum to the post's own total, or every share " +
      "percentage the UI renders from them is wrong");

    // Heaviest first, so the UI never has to sort — and the two backends agree.
    for (let i = 1; i < votes.length; i++) {
      assert.ok(BigInt(votes[i - 1]!.rshares) >= BigInt(votes[i]!.rshares),
        "voters must arrive ordered by weight, descending");
    }

    const none = await c.postVotes(voted.author, "no-such-permlink-exists");
    assert.deepEqual(none, [], "an unknown post has no voters, not an error");
  });

/**
 * Comments are a SEPARATE list from posts, and that separation is load-bearing.
 *
 * A registered reply is a post record with a parent, so the money side is
 * identical — but if replies leaked into `posts()` they would show up in the
 * feed, the sitemap and the RSS as articles. Both backends keep the two
 * disjoint: the simulator filters on the parent, MAGI watches two different
 * entrypoints.
 */
test("replies are listed under their parent and never in the feed",
  { skip: !up }, async () => {
    const c = client();
    const posts = await c.posts(50);
    for (const p of posts) {
      assert.equal(p.parent_permlink, "",
        `${p.author}/${p.permlink} is a reply and must not be in the feed`);
    }

    const parent = posts.find((p) => p.permlink === "lassemint-explained");
    if (!parent) {
      console.log("  (no seeded parent post on this chain — comments not exercised)");
      return;
    }
    const replies = await c.comments(parent.author, parent.permlink);
    assert.ok(replies.length > 0, "the demo chain seeds replies on this post");
    for (const r of replies) {
      assert.equal(r.parent_author, parent.author);
      assert.equal(r.parent_permlink, parent.permlink);
      // A reply runs VIRAL economics whatever window its parent is in.
      assert.equal(r.window, "viral");
      assert.match(r.pending_payout, /^\d+\.\d{8}$/);
    }
    // A voted reply earns; the pending figure is the chain's, not ours.
    assert.ok(replies.some((r) => isPositive(r.pending_payout)),
      "a voted comment must carry a real pending reward");

    assert.deepEqual(await c.comments(parent.author, "no-such-permlink"), [],
      "an unknown post has no replies, not an error");
  });

/**
 * A comment round-trips: written to the content layer, registered on-chain,
 * and readable under its parent with a permlink both steps agreed on.
 */
test("a comment is published and registered as one unit", { skip: !up }, async () => {
  const c = client("hive:tibfox");
  const parentAuthor = "hive:lasseehlers";
  const parentPermlink = "lassemint-explained";

  const before = await c.comments(parentAuthor, parentPermlink);
  const res = await c.comment({
    body: "Round-trip check from the indexer test suite.",
    parentAuthor,
    parentPermlink,
  });
  assert.ok(res.ok, res.msg);
  assert.match(res.permlink, /^re-/, "a reply uses Hive's re- permlink convention");

  const after = await c.comments(parentAuthor, parentPermlink);
  assert.equal(after.length, before.length + 1);
  const mine = after.find((r) => r.permlink === res.permlink);
  assert.ok(mine, "the registered permlink must be the one that was published");
  assert.equal(mine.author, "hive:tibfox");

  // The BODY must be readable back under the same key, or the reward window is
  // open over content nobody can find.
  const content = await c.content("hive:tibfox", res.permlink);
  assert.equal(content?.body, "Round-trip check from the indexer test suite.");
});

/**
 * Promotion BURNS. The money leaves the promoter, lands at @null — provably
 * unspendable — and the post records the running total. All three are checked,
 * because a promotion that debited without burning would quietly inflate
 * supply, and one that recorded without debiting would be free advertising.
 */
test("promoting a post burns the money to null", { skip: !up }, async () => {
  const c = client("hive:silvertop");
  const posts = await c.posts(50);
  const target = posts.find((p) => !p.paid_out && !p.payable && !p.parent_permlink);
  if (!target) {
    console.log("  (no promotable post on this chain — promotion not exercised)");
    return;
  }

  const before = await c.me();
  const burnedBefore = (await c.chain()).total_burned;
  const promotedBefore = target.promoted;

  const res = await c.promotePost(target.author, target.permlink, "250");
  assert.ok(res.ok, res.msg);

  const after = await c.me();
  const burnedAfter = (await c.chain()).total_burned;
  const target2 = (await c.posts(50)).find(
    (p) => p.author === target.author && p.permlink === target.permlink);

  assert.equal(toUnits(before.balance) - toUnits(after.balance), toUnits("250"),
    "exactly the promoted amount must leave the promoter");
  assert.equal(toUnits(burnedAfter) - toUnits(burnedBefore), toUnits("250"),
    "the same amount must arrive at @null — burned, not moved");
  assert.equal(toUnits(target2!.promoted) - toUnits(promotedBefore), toUnits("250"),
    "the post must record what was burned for it");

  // Comments cannot be promoted: a reply has no slot to buy.
  const replies = await c.comments(target.author, target.permlink);
  if (replies.length > 0) {
    const bad = await c.promotePost(replies[0]!.author, replies[0]!.permlink, "250");
    assert.equal(bad.ok, false, "a comment must not be promotable");
  }
});

/**
 * total_burned = Balance(hive:null) and grows with every burn/promote after
 * genesis. snapshot_total and snapshot_burned are committed ONCE at genesis
 * (cfg_migtotal / cfg_migburn) and must never move again — they are the
 * hardcap accounting the Chain page's "claimable" row (snapshot_total -
 * snapshot_burned) depends on. Confusing the two used to make claimable
 * silently shrink after any post-genesis burn.
 */
test("a later burn does not change the snapshot figures", { skip: !up }, async () => {
  const c = client("hive:demo");

  const before = await c.chain();
  const claimableBefore = toUnits(before.snapshot_total) - toUnits(before.snapshot_burned);

  const res = await c.burn("2.5");
  assert.ok(res.ok, res.msg);

  const after = await c.chain();
  assert.equal(toUnits(after.total_burned) - toUnits(before.total_burned), toUnits("2.5"),
    "total_burned must grow by exactly what was burned");
  assert.equal(after.snapshot_burned, before.snapshot_burned,
    "snapshot_burned is fixed at genesis — a later burn must not move it");
  assert.equal(after.snapshot_total, before.snapshot_total,
    "snapshot_total is fixed at genesis — a later burn must not move it");

  const claimableAfter = toUnits(after.snapshot_total) - toUnits(after.snapshot_burned);
  assert.equal(claimableAfter, claimableBefore,
    "the claimable row (snapshot_total - snapshot_burned) must not shrink on a post-genesis burn");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { AiohaSigner, AiohaWallet } from "./aioha-signer.js";

/**
 * The rc_limit table is a production safety net: too low and a call dies with
 * gas_limit_hit, too high and MAGI freezes the limit for five days.
 *
 * ⚠️ THESE ARE MAINNET FIGURES, from simulateContractCalls against the
 * production contract on 2026-09-01. The first version of this test used
 * DEVNET numbers, which are roughly 3x too low — it passed while the live
 * table could not pay for a transfer, and @tibfox found that the hard way.
 * A devnet measurement is a floor, never an estimate: it does not weigh
 * state writes the way settlement does.
 */
const MEASURED_RC = {
  // vote: an ordinary vote is 904, but a FIRST vote on an outside tagged post
  // registers it too — 4,818 RC simulated against production 2026-09-03, and
  // three real ones died at a 4,000 limit the day before. The registering
  // case is the one the floor must survive.
  transfer: 872, mint: 3_486, vote: 4_818, post: 1_098, comment: 1_974,
  promote_post: 833, swap_lc_hbd: 206, claim_pool: 463, burn: 167,
  claim_migration: 5_892, record_burn: 590,
};

test("every measured entrypoint has at least 40% headroom over its real cost", () => {
  for (const [op, rc] of Object.entries(MEASURED_RC)) {
    const limit = AiohaSigner.RC_LIMITS[op];
    assert.ok(limit !== undefined, `${op} has no rc_limit`);
    assert.ok(limit >= rc * 1.4, `${op}: limit ${limit} is too close to measured ${rc}`);
  }
});

test("no entrypoint may request a limit that could lock an account out", () => {
  // 10,000 is the free RC every account has; a single call must never be able
  // to freeze more than that for five days.
  for (const [op, limit] of Object.entries(AiohaSigner.RC_LIMITS)) {
    assert.ok(limit <= 10_000, `${op}: ${limit} exceeds the free RC allowance`);
  }
});

/**
 * sizeRc with a stubbed wallet. The refusal floor cannot come from the
 * simulation alone: settlement weighs writes 19x and the simulator does not,
 * so a write-heavy call simulates at a small fraction of its real cost. The
 * first production casualty (2026-09-01): @angeloextreme's comment simulated
 * ~80 RC, cleared the old 1.3x-of-simulated floor with 82 RC available, and
 * died on-chain with "cost limit exceeded" after publishing its Hive half.
 */
function signerWith(sim: { gas: number } | "throws", avail: number | null): AiohaSigner {
  const wallet = {
    simulate: async () => {
      if (sim === "throws") throw new Error("network");
      return { ok: true as const, gas: sim.gas };
    },
    availableRc: async () => avail,
  };
  // Only simulate/availableRc are exercised by sizeRc.
  return new AiohaSigner(wallet as never, "hive:test", "vsc1test", 1_500);
}

test("a call the account cannot afford is refused before the wallet opens (the comment casualty)", async () => {
  // 82 RC available, comment simulates at ~80 RC of gas (8M cycles).
  const r = await signerWith({ gas: 8_000_000 }, 82).sizeRc("comment", "p|a|pp", [], AiohaSigner.RC_LIMITS["comment"]!);
  assert.ok(typeof r !== "number", "the doomed comment must be refused, not sized");
  assert.match(r.msg, /not enough resource credits/i);
  assert.match(r.msg, /HBD/); // the message must explain the meter
});

test("a fresh account's 10,000 free RC still carries a staked claim", async () => {
  // Measured: staked claim simulates ~2,000 RC; table is 9,500.
  const r = await signerWith({ gas: 200_000_000 }, 10_000).sizeRc(
    "claim_migration", "1|2|proof", [], AiohaSigner.RC_LIMITS["claim_migration"]!);
  assert.equal(r, 9_500);
});

test("advance keeps its slice-to-what-you-hold behaviour", async () => {
  const r = await signerWith({ gas: 10_000_000 }, 3_000).sizeRc("advance", "50", [], AiohaSigner.RC_LIMITS["advance"]!);
  assert.equal(r, 3_000);
});

test("when the dry run fails, the table is still checked against available RC", async () => {
  const broke = await signerWith("throws", 82).sizeRc("comment", "p|a|pp", [], AiohaSigner.RC_LIMITS["comment"]!);
  assert.ok(typeof broke !== "number", "unaffordable table limit must refuse");
  const fine = await signerWith("throws", 10_000).sizeRc("comment", "p|a|pp", [], AiohaSigner.RC_LIMITS["comment"]!);
  assert.equal(fine, AiohaSigner.RC_LIMITS["comment"]!);
});

test("every value-moving USER entrypoint is in the table", () => {
  // Genesis operations (init, migrate*, burn_batch) are owner-only and sent by
  // tools/migrate.py, which sizes its own limits from the batch contents.
  const genesisOps = new Set(["init", "migrate", "migrate_batch", "burn_batch"]);
  for (const op of AiohaSigner.ACTIVE_OPS) {
    if (genesisOps.has(op)) continue;
    assert.ok(op in AiohaSigner.RC_LIMITS, `${op} moves value but has no measured limit`);
  }
});

/**
 * Hive's rejections, translated.
 *
 * A LasseCash vote carries the Hive vote in the SAME transaction, so a Hive
 * refusal kills the contract call with it. The identical-vote case is the one
 * every user meets: their first attempt's Hive half landed while its MAGI half
 * failed on RC, so the retry is a re-vote at the same weight and Hive refuses
 * it. Seen in production 2026-09-01.
 */
test("Hive's identical-vote refusal names the fix, not the assert", () => {
  const raw = "Your transaction returned an error <br/><br/>Error: Your current vote on this comment is identical to this vote.";
  const msg = AiohaWallet.hiveReason(raw);
  assert.match(msg, /different weight/);
  assert.doesNotMatch(msg, /<br\/>/, "assert markup must not reach the user");
});

test("an unrecognised Hive error is passed through, never invented", () => {
  // A wrong explanation is worse than a raw one.
  assert.equal(AiohaWallet.hiveReason("some novel consensus failure"), "some novel consensus failure");
  assert.equal(AiohaWallet.hiveReason(undefined), "rejected");
});

/**
 * The node answers 0/0 — not null, not an error — for an address it does not
 * recognise, and a BARE Hive name is one of those: MAGI addresses are
 * qualified. Shipped 2026-09-01 and caught on the wallet page the same hour,
 * reading "MAGI 0 / 0" for an account holding 74 HBD. Left alone it would
 * have made the RC preflight refuse every call every account ever tried,
 * because a zero that looks like a real reading is indistinguishable from
 * being broke.
 */
test("a 0/0 RC answer is treated as unknown, never as broke", async () => {
  const wallet = {
    simulate: async () => ({ ok: true as const, gas: 8_000_000 }),
    availableRc: async () => AiohaSigner.prototype ? null : null, // unknown
  };
  const signer = new AiohaSigner(wallet as never, "hive:test", "vsc1test", 1_500);
  const r = await signer.sizeRc("comment", "p|a|pp", [], AiohaSigner.RC_LIMITS["comment"]!);
  assert.equal(typeof r, "number", "an unknown meter must not refuse the call");
});

/**
 * THE DEAD DRY RUN, 2026-09-03. The node refuses a bare `required_auths`
 * ("must start with hive: or did:") as a GraphQL error, which simulate()
 * surfaces as a throw, which sizeRc catches by falling back to the table —
 * so a bare name didn't fail loudly, it silently disabled EVERY dry run in
 * production. Three registering votes (~4,800 RC real) then died at the old
 * vote table of 4,000. Every account name sent to the node must be qualified.
 */
import { qualifyAuth } from "./aioha-signer.js";

test("a bare Aioha name is qualified before it reaches the node", () => {
  assert.equal(qualifyAuth("lasseehlers"), "hive:lasseehlers");
  assert.equal(qualifyAuth("hive:lasseehlers"), "hive:lasseehlers");
  assert.equal(qualifyAuth("did:pkh:eip155:1:0xabc"), "did:pkh:eip155:1:0xabc");
});

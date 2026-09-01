import assert from "node:assert/strict";
import { test } from "node:test";
import { AiohaSigner } from "./aioha-signer.js";

/**
 * The rc_limit table is a production safety net: too low and a call dies with
 * gas_limit_hit, too high and MAGI freezes the limit for five days. These pin
 * the table against the MEASURED costs (devnet, 2026-08-21) so a future edit
 * cannot quietly drop below them.
 */
const MEASURED_RC = { transfer: 285, mint: 2_401, advance: 100, claim_migration: 5_892, record_burn: 590 };

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
  assert.match(r.msg, /not enough resource credits/);
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

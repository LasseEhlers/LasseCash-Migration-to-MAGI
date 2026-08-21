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

test("every value-moving USER entrypoint is in the table", () => {
  // Genesis operations (init, migrate*, burn_batch) are owner-only and sent by
  // tools/migrate.py, which sizes its own limits from the batch contents.
  const genesisOps = new Set(["init", "migrate", "migrate_batch", "burn_batch"]);
  for (const op of AiohaSigner.ACTIVE_OPS) {
    if (genesisOps.has(op)) continue;
    assert.ok(op in AiohaSigner.RC_LIMITS, `${op} moves value but has no measured limit`);
  }
});

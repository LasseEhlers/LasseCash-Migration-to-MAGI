#!/usr/bin/env node
/**
 * Broadcast a REAL LasseCash contract call to MAGI mainnet.
 *
 * The wire format (verified in go-vsc-node's own devnet harness): a Hive
 * custom_json op, id "vsc.call", signed with ACTIVE authority, whose json is
 *   {net_id, contract_id, action, payload, rc_limit, intents}
 *
 * SCOPE — agreed with Lasse 2026-08-21:
 *   - THROWAWAY contract only (the id below is pinned; no argument overrides it)
 *   - costs RC only; a vsc.call spends no HIVE and no HBD by itself
 *   - the only value that can move is what an explicit transfer.allow intent
 *     permits, and nothing here attaches one unless the caller passes it
 *
 * The active key is read from deploy-data and NEVER printed.
 */
const { Client, PrivateKey } = require("/tmp/keycheck/node_modules/@hiveio/dhive");
const fs = require("fs");

const CONTRACT = "vsc1BqLfLpKdMSfmHCe4o15ssWMiWJZw3yoZ8C"; // throwaway #3: flat keys + TESTWINDOWS 240x clock
const cfgPath = `${__dirname}/../../deploy-data/config/identityConfig.json`;

async function main() {
  // rc_limit default is SMALL on purpose. MAGI freezes the FULL rc_limit for
  // its 5-day thaw — not the RC actually used — so an oversized limit locks
  // the account out of the chain for days. Learned the hard way 2026-08-21:
  // six calls at rc_limit=100000 against a ~22k meter froze @lassecashmagi
  // solid and silently discarded the state of the one call that "succeeded".
  const [action, payload = "", rcLimit = "1500", intentsJson = "[]"] =
    process.argv.slice(2);
  if (!action) {
    console.error("usage: call.js <action> [payload] [rc_limit] [intents-json]");
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const key = PrivateKey.fromString(cfg.HiveActiveKey);

  const json = JSON.stringify({
    net_id: "vsc-mainnet",
    contract_id: CONTRACT,
    action,
    payload,
    rc_limit: Number(rcLimit),
    intents: JSON.parse(intentsJson),
  });

  const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);
  const res = await client.broadcast.json(
    { id: "vsc.call", required_auths: [cfg.HiveUsername], required_posting_auths: [], json },
    key,
  );
  console.log(JSON.stringify({ tx_id: res.id, block: res.block_num, action, payload }));
}

main().catch((e) => {
  console.error("broadcast failed:", e.message);
  process.exit(1);
});

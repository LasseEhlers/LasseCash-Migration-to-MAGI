#!/usr/bin/env node
/**
 * Broadcast an OWNER call to the PRODUCTION LasseCash contract on MAGI.
 *
 * Differences from call.js (which stays pinned to the throwaway, on purpose):
 *  - the contract id is read from deploy-data/production-contract-id, a file
 *    written by hand right after `./deploy.sh deploy` prints the real id.
 *    No file -> refuse. Nothing here defaults to any contract.
 *  - it exists for exactly three broadcasts on launch day (§4 of the
 *    runbook): `init <genesisHeight>`, `set_snapshot <root>|<qt>|<bt>`,
 *    and the MAGI->MAGI HBD transfer to @lasseehlers afterwards.
 *
 * usage: launch-call.js <action> [payload] [rc_limit] [intents-json]
 */
const { Client, PrivateKey } = require("@hiveio/dhive");
const fs = require("fs");

const idPath = `${__dirname}/../../deploy-data/production-contract-id`;
const cfgPath = `${__dirname}/../../deploy-data/config/identityConfig.json`;

async function main() {
  if (!fs.existsSync(idPath)) {
    console.error(
      `refusing: ${idPath} does not exist.\n` +
      "After ./deploy.sh deploy prints the production contract id, write it " +
      "into that file (one line) and re-run.");
    process.exit(2);
  }
  const CONTRACT = fs.readFileSync(idPath, "utf8").trim();
  if (!/^vsc1[A-Za-z0-9]{20,}$/.test(CONTRACT)) {
    console.error(`refusing: "${CONTRACT}" does not look like a contract id`);
    process.exit(2);
  }
  const [action, payload = "", rcLimit = "1500", intentsJson = "[]"] =
    process.argv.slice(2);
  if (!action) {
    console.error("usage: launch-call.js <action> [payload] [rc_limit] [intents-json]");
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
  console.log(JSON.stringify({ tx_id: res.id, block: res.block_num, contract: CONTRACT, action, payload }));
}

main().catch((e) => {
  console.error("broadcast failed:", e.message);
  process.exit(1);
});

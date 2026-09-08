#!/usr/bin/env node
/**
 * Cancel a still-pending contract update.
 *
 *   node tools/chain-test/cancel-update.js <contractId> [queueTxId]
 *
 * Wire format read from the node source (system_txs.go TxCancelContractUpdate):
 * a `vsc.cancel_contract_update` custom_json carrying { net_id, id, tx_id? }.
 * Omitting tx_id cancels EVERY pending update for the contract; naming one
 * cancels exactly that queue transaction, which is what this tool insists on
 * so a second pending update can never be taken down by accident.
 *
 * Authorised against the contract's CURRENT owner, with the ACTIVE key —
 * posting is explicitly refused by the node. There is NO FEE (the node says so
 * in as many words), and the 10 HBD already paid to queue the update is NOT
 * refunded: cancelling buys time, never money.
 *
 * Nothing is reversible about this. A cancelled update is tombstoned and can
 * never activate; putting it back means queueing again, at 10 HBD and a fresh
 * 48-hour timelock.
 */
const fs = require("fs");
const { Client, PrivateKey } = require("@hiveio/dhive");

async function main() {
  const [contractId, queueTxId] = process.argv.slice(2);
  if (!contractId || !queueTxId) {
    console.error("usage: cancel-update.js <contractId> <queueTxId>");
    console.error("  both required: naming the queue tx prevents cancelling more than intended");
    process.exit(2);
  }
  const cfg = JSON.parse(
    fs.readFileSync(`${__dirname}/../../deploy-data/config/identityConfig.json`, "utf8"),
  );
  const json = JSON.stringify({
    net_id: "vsc-mainnet",
    id: contractId,
    tx_id: queueTxId,
  });
  console.log("cancelling:", json);
  const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);
  const res = await client.broadcast.json(
    { id: "vsc.cancel_contract_update", required_auths: [cfg.HiveUsername], required_posting_auths: [], json },
    PrivateKey.fromString(cfg.HiveActiveKey),
  );
  console.log(JSON.stringify({ tx_id: res.id, block: res.block_num }));
  console.log("\nVerify with findPendingContractUpdates — an empty list means it is gone.");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

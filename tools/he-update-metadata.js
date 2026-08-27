#!/usr/bin/env node
/**
 * Update LASSECASH's token metadata on Hive-Engine (url / icon / desc).
 *
 * The hive-engine.com / tribaldex.com "edit token" form no longer appears, but
 * the form only ever broadcast this custom_json — the `tokens` contract's
 * issuer-only `updateMetadata` action. Signed with the ISSUER's ACTIVE key
 * (@lasseehlers). Nothing else changes: supply, precision, balances untouched.
 *
 *   HIVE_ACTIVE_KEY=5K... node tools/he-update-metadata.js            # dry run: prints the op
 *   HIVE_ACTIVE_KEY=5K... node tools/he-update-metadata.js --broadcast
 *
 * Verify afterwards (public, no key):
 *   curl -s https://api.hive-engine.com/rpc/contracts -H 'Content-Type: application/json' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"findOne","params":{"contract":"tokens","table":"tokens","query":{"symbol":"LASSECASH"}}}'
 *
 * The key is read from the environment and never printed or written.
 */
const { Client, PrivateKey } = require("/tmp/keycheck/node_modules/@hiveio/dhive");

const ISSUER = "lasseehlers";
const SYMBOL = "LASSECASH";

// Current values (read 2026-08-26): url http://www.lassecash.com, icon the
// images.hive.blog PNG, desc "LasseCash:\nAnarchy. Crypto. Truth."
// Edit the text below in Lasse's voice before broadcasting.
const metadata = {
  url: "https://lassecash.com",
  icon: "https://images.hive.blog/DQmVTNMH9QjFbGhDunq8XtEP6Ke1Zsu7KD9ztL2SCGo4Mm1/image.png",
  desc:
    "LasseCash: Anarchy. Crypto. Truth.\n\n" +
    "THIS HIVE-ENGINE TOKEN IS BEING RETIRED. LasseCash migrates to the MAGI chain " +
    "with a one-time snapshot (announced 2026-08-23); after the snapshot this token " +
    "is dead and Hive-Engine LASSECASH is not honoured. Rules, dates and how to " +
    "claim: https://peakd.com/@lasseehlers/lassecash-migrates-to-magi and " +
    "https://lassecash.com/about",
};

const json = JSON.stringify({
  contractName: "tokens",
  contractAction: "updateMetadata",
  contractPayload: { symbol: SYMBOL, metadata },
});
const op = ["custom_json", { id: "ssc-mainnet-hive", required_auths: [ISSUER], required_posting_auths: [], json }];

async function main() {
  console.log(JSON.stringify(op, null, 1));
  if (!process.argv.includes("--broadcast")) {
    console.log("\n(dry run — add --broadcast to send)");
    return;
  }
  const wif = process.env.HIVE_ACTIVE_KEY;
  if (!wif) throw new Error("HIVE_ACTIVE_KEY not set");
  const key = PrivateKey.fromString(wif);
  const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);
  const res = await client.broadcast.sendOperations([op], key);
  console.log(JSON.stringify({ tx_id: res.id, block: res.block_num }));
  console.log("Hive-Engine picks it up within ~1 minute; verify with the findOne query in the header.");
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

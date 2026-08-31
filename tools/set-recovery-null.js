#!/usr/bin/env node
/**
 * Close the account-recovery loophole on the contract owner account.
 *
 * Hive account recovery lets the recovery partner + any owner key valid in
 * the last 30 days RESTORE an account's authorities. For @lassecashmagi that
 * would mean the "burned" owner key could be brought back for 30 days after
 * the burn. Setting the recovery account to `null` (an account with no keys)
 * makes recovery impossible. The change takes effect 30 DAYS after broadcast,
 * so it must be sent at or before genesis to be in force by the day-40 burn.
 *
 * Requires the OWNER key of @lassecashmagi (change_recovery_account is an
 * owner-authority operation). The key is read from the environment and never
 * printed or written.
 *
 *   HIVE_OWNER_KEY=<owner WIF 5... or master password P5...>
 *   HIVE_OWNER_KEY=5... node tools/set-recovery-null.js              # dry run
 *   HIVE_OWNER_KEY=5... node tools/set-recovery-null.js --broadcast
 *
 * Verify (public): condenser_api.get_accounts -> recovery_account, and
 * database_api.find_change_recovery_account_requests -> the pending request
 * with its effective_on date.
 */
const { Client, PrivateKey } = require(`${__dirname}/chain-test/node_modules/@hiveio/dhive`);

const ACCOUNT = "lassecashmagi";
const NEW_RECOVERY = "null";
const op = ["change_recovery_account", { account_to_recover: ACCOUNT, new_recovery_account: NEW_RECOVERY, extensions: [] }];

async function main() {
  const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);
  const [acct] = await client.database.getAccounts([ACCOUNT]);
  console.log(`current recovery_account of @${ACCOUNT}: ${acct.recovery_account}`);
  console.log(JSON.stringify(op));
  if (!process.argv.includes("--broadcast")) { console.log("\n(dry run — add --broadcast to send)"); return; }
  const wif = process.env.HIVE_OWNER_KEY;
  if (!wif) throw new Error("HIVE_OWNER_KEY not set");
  // Accept either the owner WIF (5...) or the master password (P5...), from
  // which the owner key is derived the way every Hive wallet does it.
  const key = wif.startsWith("P") ? PrivateKey.fromLogin(ACCOUNT, wif, "owner") : PrivateKey.fromString(wif);
  if (key.createPublic().toString() !== acct.owner.key_auths[0][0]) throw new Error("that key is not the OWNER key of @" + ACCOUNT);
  const res = await client.broadcast.sendOperations([op], key);
  console.log(JSON.stringify({ tx_id: res.id, block: res.block_num }));
  const pending = await client.call("database_api", "find_change_recovery_account_requests", { accounts: [ACCOUNT] });
  console.log("pending request:", JSON.stringify(pending.requests));
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

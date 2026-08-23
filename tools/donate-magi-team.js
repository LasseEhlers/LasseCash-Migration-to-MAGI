#!/usr/bin/env node
/**
 * One-off: stake 5,000 LASSECASH POWER to each of the twelve MAGI witnesses
 * who have never held LASSECASH, from @lassecashmagi on Hive-Engine.
 *
 * WHY THESE TWELVE: they run MAGI witnesses and have literally zero LASSECASH
 * history — Lasse donated to the rest of the team years ago, but never to
 * these. Checked 2026-08-22 against the full Hive-Engine token history; every
 * name below was verified to be a real Hive account the same day.
 *
 * ⚠️ THIS DOES NOT MAKE THEM ELIGIBLE FOR THE MIGRATION. Under the C6 rule a
 * migrating account must have SIGNED a LASSECASH operation itself within six
 * months. A stake sent by someone else is signed by the sender. So each of
 * these will hold 5,000 that BURNS unless they act on it before the snapshot
 * block. That is the point of the announcement, not of this script.
 *
 * Staking TO another account is `tokens.stake` with a `to` field — the same
 * operation Lasse has used for years (e.g. lasseehlers -> cedricguillas).
 *
 * Usage:
 *     node tools/donate-magi-team.js --dry-run     # print, broadcast nothing
 *     node tools/donate-magi-team.js               # broadcast, 12 transactions
 *
 * The active key is read from deploy-data and is never printed.
 */
const { Client, PrivateKey } = require("/tmp/keycheck/node_modules/@hiveio/dhive");
const fs = require("fs");

const SENDER = "lassecashmagi";
const SYMBOL = "LASSECASH";
const EACH = "5000";
const RECIPIENTS = [
  "mahdiyari", "v4vapp", "atexoras", "herman",
  "prime", "milo", "delta-p", "comptroller",
  "botlord", "magi-team-node", "sisygoboom", "bala",
];

const DRY = process.argv.includes("--dry-run");
const cfgPath = `${__dirname}/../deploy-data/config/identityConfig.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const total = Number(EACH) * RECIPIENTS.length;
  console.log(`${DRY ? "DRY RUN — " : ""}staking ${EACH} ${SYMBOL} to each of ` +
    `${RECIPIENTS.length} accounts (${total.toLocaleString()} total) from @${SENDER}\n`);

  // Refuse rather than half-finish: a partial run is worse than none, because
  // it silently favours whoever happens to be early in the list.
  const bal = await balanceOf(SENDER);
  console.log(`  @${SENDER} liquid ${SYMBOL}: ${bal}`);
  if (Number(bal) < total) {
    console.error(`\n  REFUSING: need ${total}, have ${bal}. Send the tokens first.`);
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const key = PrivateKey.fromString(cfg.HiveActiveKey);
  const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);

  for (const to of RECIPIENTS) {
    const json = JSON.stringify({
      contractName: "tokens",
      contractAction: "stake",
      contractPayload: { symbol: SYMBOL, to, quantity: EACH },
    });
    if (DRY) { console.log(`  would stake ${EACH} -> @${to}`); continue; }
    const res = await client.broadcast.json(
      { id: "ssc-mainnet-hive", required_auths: [cfg.HiveUsername], required_posting_auths: [], json },
      key,
    );
    console.log(`  staked ${EACH} -> @${to.padEnd(16)} tx ${res.id}`);
    await sleep(3500); // one Hive block apart, so nothing is dropped as a dup
  }
  if (!DRY) console.log("\n  done. Verify with tools/verify-donations.js");
}

async function balanceOf(account) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "find",
    params: { contract: "tokens", table: "balances",
              query: { account, symbol: SYMBOL }, limit: 2 },
  });
  const r = await fetch("https://api.hive-engine.com/rpc/contracts", {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  const d = await r.json();
  return d.result?.[0]?.balance ?? "0";
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

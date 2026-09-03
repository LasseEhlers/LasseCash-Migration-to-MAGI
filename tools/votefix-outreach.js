#!/usr/bin/env node
/**
 * ONE-OFF: tell the four accounts whose votes failed on 2 September that the
 * bug is fixed and how to re-vote.
 *
 * Their LasseCash votes died with "cost limit exceeded" (the RC dry-run was
 * silently broken and every call fell back to a table limit too small for a
 * vote that also registers a post). Each of them thinks they voted; the chain
 * refused it. The Hive half DID land, so the re-vote must use a DIFFERENT
 * percentage or Hive rejects it as identical.
 *
 * Same channel and discipline as tools/outreach.js: 0.001 HBD memos from
 * @lassecashmagi (its active key is in deploy-data; never printed), one send
 * per block, progress recorded so a rerun cannot double-send.
 *
 *   node tools/votefix-outreach.js --dry
 *   node tools/votefix-outreach.js
 */
const fs = require("fs");
const { Client, PrivateKey } = require("./chain-test/node_modules/@hiveio/dhive");

const ROOT = `${__dirname}/..`;
const cfg = JSON.parse(fs.readFileSync(`${ROOT}/deploy-data/config/identityConfig.json`, "utf8"));
const ACCOUNT = cfg.HiveUsername;
const ACTIVE = PrivateKey.fromString(cfg.HiveActiveKey);
const PROGRESS = `${ROOT}/deploy-data/votefix-progress.json`;

const client = new Client(
  ["https://api.hive.blog", "https://api.deathwing.me", "https://anyx.io"],
  { timeout: 20_000 },
);

// Each account's ACTUAL failed votes, read from the chain 2026-09-03.
const AFFECTED = {
  tonyz:    "your votes on @offgridlife and @barski's posts",
  bokica80: "your votes on @lasseehlers and @offgridlife's posts",
  zaxan:    "your vote on @elizabethbit's post",
  andy4475: "your vote on @barski/water-fantasies",
};

const memo = (what) =>
  `Heads up: ${what} on lassecash.com on 2 Sept did not land — a launch bug ` +
  `set the fee limit too low and the chain refused them. Fixed the same day. ` +
  `Please vote again, at a DIFFERENT percent than last time (your Hive vote ` +
  `landed, and Hive refuses an identical re-vote). Sorry for the trouble — ` +
  `Lasse (this account is mine).`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dry = process.argv.includes("--dry");
  let progress = {};
  try { progress = JSON.parse(fs.readFileSync(PROGRESS, "utf8")); } catch { /* first run */ }

  for (const [account, what] of Object.entries(AFFECTED)) {
    if (progress[account]) { console.log(`  skip  @${account} (already sent)`); continue; }
    const body = memo(what);
    if (dry) { console.log(`\n--- @${account} ---\n${body}`); continue; }
    try {
      await client.broadcast.transfer(
        { from: ACCOUNT, to: account, amount: "0.001 HBD", memo: body }, ACTIVE);
      progress[account] = new Date().toISOString();
      fs.writeFileSync(PROGRESS, JSON.stringify(progress, null, 2));
      console.log(`  ok    @${account}`);
    } catch (e) {
      console.log(`  FAIL  @${account} ${(e.message || e).toString().slice(0, 120)}`);
    }
    await sleep(3_000);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

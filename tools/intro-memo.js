#!/usr/bin/env node
/**
 * The introduction letter: one 0.001 HBD memo from @lassecashmagi to every
 * active Hive account on the 23 Aug list (4,443), the first time LasseCash as
 * it now exists is described to people who never used it.
 *
 * Lasse's letter, 7 Sep. Sent to all 4,443 including the 1,510 who got the
 * August gift — that was a different letter about a snapshot that has since
 * happened.
 *
 *   node tools/intro-memo.js --dry               show the memo and the count
 *   node tools/intro-memo.js --limit 3           send three, then stop
 *   node tools/intro-memo.js                     send to everyone
 *
 * Resumable: every success is written to deploy-data/intro-memo-progress.json
 * before the next send. The active key is read from deploy-data and never
 * printed. Cost: 0.001 HBD per memo, 4.443 HBD for the whole list.
 */
const fs = require("fs");
const { Client, PrivateKey } = require("./chain-test/node_modules/@hiveio/dhive");

const ROOT = `${__dirname}/..`;
const cfg = JSON.parse(fs.readFileSync(`${ROOT}/deploy-data/config/identityConfig.json`, "utf8"));
const FROM = cfg.HiveUsername;
const KEY = PrivateKey.fromString(cfg.HiveActiveKey);
const LIST = `${ROOT}/tools/snapshot/data/hive_active_users_2026-08.json`;
const PROGRESS = `${ROOT}/deploy-data/intro-memo-progress.json`;

const MEMO = `Hallo, this is a serious message, even if it comes in a memo... I created something I believe is amazing, it might be the best cryptocurrency product ever::: LasseCash on MAGI.

No fees. A hardcap of 51M written down in 2019 and now enforced by the contract, with emission halving every 3 years. Mints inspired by HEX's certificates of deposit, and your mint is also your voting weight on posts and thresholds. The pool has zero swap fee, hardcoded, and the LPs are paid in LASSECASH from emission instead. It is a core design, built so other things can be built on top. We burn the admin key 40 days in, on 10 October, and then the rules are immutable forever. The first big application contract on MAGI, and everything in it is unique.

Everyone in the snapshot got a 30-day mint, so on day 30 (30 September) the whole migrated supply unlocks at once... that is where real price discovery happens, and right after it there will be very few mints, so the first new minters share the whole reward pool between them for a while.

Check it out and ask in the Discord if you have questions::

The main site: https://lassecash.com
All the details: https://lassecash.com/about
The music: https://lassemusic.com

Best, Lasse Ehlers`;

const client = new Client(
  ["https://api.hive.blog", "https://api.deathwing.me", "https://anyx.io"],
  { timeout: 20_000 },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dry = process.argv.includes("--dry");
  const li = process.argv.indexOf("--limit");
  const limit = li > -1 ? parseInt(process.argv[li + 1], 10) : Infinity;

  const bytes = Buffer.byteLength(MEMO, "utf8");
  if (bytes > 2048) throw new Error(`memo is ${bytes} bytes; Hive allows 2048`);

  const list = JSON.parse(fs.readFileSync(LIST, "utf8")).recipients;
  let progress = {};
  try { progress = JSON.parse(fs.readFileSync(PROGRESS, "utf8")); } catch {}
  const todo = list.filter((a) => !progress[a]);
  console.log(`intro-memo: ${list.length} on the list, ${Object.keys(progress).length} sent, ${todo.length} to go  (${bytes} bytes)`);
  if (dry) {
    console.log(`\n--- memo ---\n${MEMO}\n---\n\nwould send to: ${todo.slice(0, Math.min(limit, 10)).join(", ")}${todo.length > 10 ? ", ..." : ""}`);
    return;
  }

  let sent = 0, failed = 0, tried = 0;
  for (const account of todo) {
    if (tried >= limit) break;
    tried++;
    try {
      await client.broadcast.transfer({ from: FROM, to: account, amount: "0.001 HBD", memo: MEMO }, KEY);
      progress[account] = new Date().toISOString();
      fs.writeFileSync(PROGRESS, JSON.stringify(progress, null, 1));
      sent++;
      if (sent % 25 === 0 || sent <= 3) console.log(`  ok    @${account}   (${sent} sent)`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  @${account}  ${(e.message || e).toString().slice(0, 120)}`);
    }
    await sleep(3_000);
  }
  console.log(`\ndone: ${sent} sent, ${failed} failed, ${todo.length - sent - failed} left`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

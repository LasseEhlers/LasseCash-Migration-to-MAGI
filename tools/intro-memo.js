#!/usr/bin/env node
/**
 * The introduction letter: one 0.001 HBD memo from @lassecashmagi to every
 * active Hive account — posted in the last 30 days, measured 7 Sep, the first time LasseCash as
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
// The FRESH list: every account that published a root post in the last 30
// days, walked from the chain on 7 Sep by tools/snapshot/hive_actives.py.
// Filters: reputation floor (REP, default 25 — drops brand-new and spam
// accounts) and the 353 claimable LasseCash holders, who already received
// two letters this week. LIST= overrides the file.
const LIST = process.env.LIST || `${ROOT}/tools/snapshot/data/hive_actives_2026-09-07.json`;
const REP = parseFloat(process.env.REP || "25");
const LEAVES = `${ROOT}/web/static/migration/leaves.json`;
// Named exclusions (bots, services, protocol accounts): one per line, # comments.
// A posting-rate rule cannot do this — the most prolific posters are mostly
// prolific humans — so the list is explicit and reviewable.
const EXCLUDE = `${ROOT}/tools/intro-memo-exclude.txt`;
// --with-lps adds the 53 liquidity providers written to on 1 Sep; only 3 of
// them posted in the last 30 days, and the pool paragraph is written for them.
const LPS = `${ROOT}/tools/lp-outreach-list.json`;
const PROGRESS = `${ROOT}/deploy-data/intro-memo-progress.json`;

const MEMO = `Hallo, this is a serious message, even if it comes in a memo... I created something I believe is amazing, it might be the best cryptocurrency product ever::: LasseCash on MAGI.

No fees. A hardcap of 51M written down in 2019 and now enforced by the contract, with emission halving every 3 years. Mints inspired by HEX's certificates of deposit, and your mint is also your voting weight on posts and thresholds. The pool has zero swap fee, hardcoded, and the LPs are paid in LASSECASH from emission instead. It is a core design, built so other things can be built on top. We burn the admin key 40 days in, on 10 October, and then the rules are immutable forever. The first big application contract on MAGI, and everything in it is unique.

Everyone in the snapshot got a 30-day mint, so on day 30 (30 September) the whole migrated supply unlocks at once... that is where real price discovery happens. With that much suddenly liquid the price might go real low for a while, so for the brave there could be monster buying opportunities... and right after it there will be very few mints, so the first new minters share the whole reward pool between them for a while.

To be clear, these are real opportunities in the beginning phase after day 30: almost no mints means the first new minters take most of the L-Share reward pool, and the pool pays 25% of all emission to its liquidity providers while there is still very little liquidity in it, so the return per HBD is at its highest right now. Neither lasts. Both are on the chain for anyone to check.

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
  // flags: --dry  --limit N  --with-lps   env: REP=25  LIST=path
  const limit = li > -1 ? parseInt(process.argv[li + 1], 10) : Infinity;

  const bytes = Buffer.byteLength(MEMO, "utf8");
  if (bytes > 2048) throw new Error(`memo is ${bytes} bytes; Hive allows 2048`);

  const raw = JSON.parse(fs.readFileSync(LIST, "utf8"));
  const claimable = new Set(JSON.parse(fs.readFileSync(LEAVES, "utf8"))
    .filter((L) => !L[3]).map((L) => L[0].replace("hive:", "")));
  const excluded = new Set(fs.existsSync(EXCLUDE)
    ? fs.readFileSync(EXCLUDE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : []);
  let list = raw.recipients
    ? raw.recipients
    : Object.entries(raw.accounts).filter(([a, v]) => v.rep >= REP && !claimable.has(a))
        .sort(([, x], [, y]) => y.rep - x.rep).map(([a]) => a);
  list = list.filter((a) => !excluded.has(a));
  if (process.argv.includes("--with-lps")) {
    const lp = JSON.parse(fs.readFileSync(LPS, "utf8"));
    const names = Array.isArray(lp) ? lp : (lp.lp || Object.values(lp).flat());
    const add = names.filter((a) => !list.includes(a) && !claimable.has(a) && !excluded.has(a));
    console.log(`--with-lps: +${add.length} liquidity providers`);
    list = list.concat(add);
  }
  console.log(`excluded by name: ${excluded.size}`);
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
      const msg = (e.message || e).toString();
      console.log(`  FAIL  @${account}  ${msg.slice(0, 120)}`);
      // Hive RC exhausted: every further send fails the same way, and at one
      // attempt per 3 s that is hours of noise. Stop; rerunning later resumes.
      if (/needs \d+ RC/.test(msg)) {
        console.log("\nHive RC on the sender is exhausted. It refills ~20% per day; " +
                    "delegate more HP to it or wait, then run the same command again.");
        break;
      }
    }
    await sleep(3_000);
  }
  console.log(`\ndone: ${sent} sent, ${failed} failed, ${todo.length - sent - failed} left`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

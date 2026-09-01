#!/usr/bin/env node
/**
 * ONE-OFF: tell unclaimed LASSECASH holders that the migration happened.
 *
 * 413 of the 418 accounts in the snapshot have not claimed. There is no way to
 * reach them on MAGI — they have never touched it — so the only channel is the
 * chain they are already on. Two of them:
 *
 *   comment  a reply on their most recent Hive post (free, reads best)
 *   memo     a 0.001 HBD transfer carrying the message (for the silent ones)
 *
 * Sent from @lassecashmagi, NOT @lasseehlers: the founder account sits at −12.6
 * reputation, so its comments are collapsed by default and would never be read.
 *
 * The active key is read from deploy-data and NEVER printed. On Hive the active
 * authority also satisfies posting, so one key signs both kinds.
 *
 *   node tools/outreach.js comment --dry        # show what would be sent
 *   node tools/outreach.js comment --limit 5    # send five, then stop
 *   node tools/outreach.js memo
 *
 * Resumable: every success is appended to deploy-data/outreach-progress.json
 * before the next send, so a crash or a Ctrl-C costs at most one duplicate.
 */
const fs = require("fs");
const { Client, PrivateKey } = require("./chain-test/node_modules/@hiveio/dhive");

const ROOT = `${__dirname}/..`;
const cfg = JSON.parse(fs.readFileSync(`${ROOT}/deploy-data/config/identityConfig.json`, "utf8"));
const ACCOUNT = cfg.HiveUsername;
const ACTIVE = PrivateKey.fromString(cfg.HiveActiveKey);

// COMMENTS NEED THE POSTING KEY. Verified against mainnet: Hive does NOT let an
// active key stand in for posting — the node answers "Missing Posting Authority"
// and nothing is written. deploy-data holds only the active key (it exists to
// deploy contracts), so the posting key is read from its own file, which the
// operator creates by hand and which is gitignored with the rest of deploy-data.
const POSTING_PATH = `${ROOT}/deploy-data/postingKey.txt`;
function postingKey() {
  if (!fs.existsSync(POSTING_PATH)) {
    throw new Error(
      `no posting key. Put @${cfg.HiveUsername}'s POSTING key (only that one) in ` +
      `deploy-data/postingKey.txt — it is gitignored and never printed.`);
  }
  return PrivateKey.fromString(fs.readFileSync(POSTING_PATH, "utf8").trim());
}
const PROGRESS = `${ROOT}/deploy-data/outreach-progress.json`;

// An explicit timeout matters: dhive's default is 60s AND it then retries the
// next node, so one unhealthy endpoint stalls the whole run for two minutes
// with nothing on screen.
const client = new Client(
  ["https://api.hive.blog", "https://api.deathwing.me", "https://anyx.io"],
  { timeout: 20_000 },
);

const POST = "@lasseehlers/lassecash-is-live-on-magi";

const COMMENT_BODY = `**LasseCash has migrated to MAGI.** The old Hive-Engine token is retired and the new chain is live at lassecash.com.

You hold LASSECASH in the snapshot and it is waiting to be claimed. Claiming before **30 September** matters: until then your position is a live mint that earns; after that it stops earning, and later it starts shrinking.

Full details, the snapshot and how it all works: **${POST}**

Fair warning — the site is updated most days for the first forty days while the contract can still be changed, so it may be briefly unstable. Everything on-chain is safe regardless.

This account is mine; the transfer history shows it. — Lasse`;

const MEMO = `LasseCash migrated to MAGI — your tokens are claimable at lassecash.com. Claim before 30 Sept while the position still earns. Details: ${POST} — this account is mine, Lasse.`;

// ---------------------------------------------------------------- progress

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS, "utf8")); }
  catch { return { comment: {}, memo: {} }; }
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- channels

async function latestPost(account) {
  const posts = await client.call("bridge", "get_account_posts", {
    sort: "posts", account, limit: 1,
  });
  return posts && posts.length ? posts[0] : null;
}

async function sendComment(account) {
  const parent = await latestPost(account);
  if (!parent) throw new Error("no posts to reply to");
  const permlink = `re-lassecash-${parent.permlink}`.slice(0, 200).toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  await client.broadcast.comment({
    parent_author: parent.author,
    parent_permlink: parent.permlink,
    author: ACCOUNT,
    permlink,
    title: "",
    body: COMMENT_BODY,
    // Deliberately NOT tagged `lassecash`: a tag would put 35 identical notices
    // into our own feed. This is outreach, not content.
    json_metadata: JSON.stringify({ app: "lassecash/2.0" }),
  }, postingKey());
  return `${parent.author}/${parent.permlink}`;
}

async function sendMemo(account) {
  await client.broadcast.transfer({
    from: ACCOUNT, to: account, amount: "0.001 HBD", memo: MEMO,
  }, ACTIVE);
  return "0.001 HBD";
}

// ---------------------------------------------------------------- main

async function main() {
  const mode = process.argv[2];
  if (mode !== "comment" && mode !== "memo") {
    console.error("usage: node tools/outreach.js <comment|memo> [--limit N] [--dry]");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const li = process.argv.indexOf("--limit");
  const limit = li > -1 ? parseInt(process.argv[li + 1], 10) : Infinity;

  const split = JSON.parse(fs.readFileSync(`${ROOT}/tools/outreach-list.json`, "utf8"));
  const progress = loadProgress();
  const todo = split[mode].filter((a) => !progress[mode][a]);

  console.log(`${mode}: ${split[mode].length} on the list, ${todo.length} still to send`);
  if (dry) {
    console.log(`\n--- body ---\n${mode === "memo" ? MEMO : COMMENT_BODY}\n---`);
    console.log(`\nwould send to: ${todo.slice(0, limit).join(", ")}`);
    return;
  }

  // Straight through, one send per block. Lasse's call: the spam-flag risk to
  // @lassecashmagi does not matter because the account has no role after the
   // day-40 key burn. A 3s gap remains only so each op lands in its own block.
  const GAP = 3_000;

  let sent = 0, failed = 0, tried = 0;
  for (const account of todo) {
    if (tried >= limit) break;
    tried++;
    try {
      const where = mode === "comment" ? await sendComment(account) : await sendMemo(account);
      progress[mode][account] = { at: new Date().toISOString(), where };
      saveProgress(progress);
      sent++;
      console.log(`  ok    @${account.padEnd(20)} ${where}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  @${account.padEnd(20)} ${(e.message || e).toString().slice(0, 120)}`);
    }
    await sleep(GAP);
  }
  console.log(`\ndone: ${sent} sent, ${failed} failed, ${todo.length - sent - failed} left`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

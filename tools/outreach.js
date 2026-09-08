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

// THE LP LETTER — deliberately no APY and no pool size.
//
// The pool pays a number that reads as a scam when you state it and reads as
// an opportunity when you find it. These people compare yields for a living;
// they will see it in ten seconds. What they cannot see from outside is that
// the reward comes from the token's own emission rather than from trading
// fees, and that nobody can ever change it — so that is what the letter says.
//
// The line about the published record is there for the ones who used to hold
// LASSECASH and were burned at the snapshot. It points them at the truth
// without a per-person calculation, and without a marketing letter being the
// thing that quietly omits it.
const LP_MEMO = `LasseCash has moved from Hive-Engine to MAGI — the first substantial contract on that chain. As someone who provides liquidity you may find it interesting: the pool is funded by 25% of every block reward, not by trading fees, and the swap fee is zero and can never be changed. The keys burn on 10 October — after that nobody can alter the contract, including me. Every account that ever held LASSECASH is published at lassecash.com/check. Have a look: lassecash.com/pool — Lasse (this account is mine)`;

// ---------------------------------------------------------------- ROUND 2
//
// Written 6 Sep. 325 of 353 claimable accounts had not claimed; every one
// holding >= 1,000 LASSECASH had already received round 1 and not acted. So
// this is not the same letter again. It says the three things they were not
// told: what RC is, that the free allowance covers the claim but little after
// it (measured on production 6 Sep: a claim costs 7,100-7,600 of the free
// 10,000).
//
// Lasse's call 6 Sep: send NOW, and write it for normies — no "resource
// credits", no "mint", no "snapshot". The standard-token line was dropped so
// nothing in it depends on Tuesday's activation. The burn is 10 October,
// unchanged, and the letter says so.
//
// Register matches round 1 deliberately: this account's outreach voice is
// clean prose signed by Lasse, and a change of register is what reads as
// outsourced, not polish.
const COMMENT2_BODY = `**Your LasseCash tokens are still waiting for you. Collecting them is free.**

Go to **lassecash.com**, log in with your Hive wallet (Keychain, PeakVault or HiveAuth — the same one you use for Hive) and press **Claim**. One click, one signature, done.

**Please do it before 30 September.** Until then your tokens earn from the day you collect them. After 30 September you still get all of them, but they stop earning. From 29 December they slowly start to shrink, and after 29 March 2027 they can no longer be claimed at all — so sooner really is better.

**One thing that confuses everyone, explained properly this time.** LasseCash now runs on MAGI, and MAGI has no fees. Instead, every account gets a free energy allowance (the site calls it RC). That free allowance is enough to collect your tokens. But it does not stretch much further — if you try to post or stake right after collecting, it may say you have run out, and it takes about five days to refill. The fix is simple: keep one or two HBD in your MAGI wallet. It is not a fee and it is never taken from you — it just sits there, works as your energy, and you can withdraw it whenever you like.

The admin keys burn on 10 October, as promised. After that nobody can change anything on the core, including me.

More details: **${POST}**

This account is mine — the transfer history shows it. — Lasse`;

const MEMO2 = `Your LasseCash tokens are still waiting — collecting is free: log in at lassecash.com with your Hive wallet and press Claim. Do it before 30 Sept while they still earn; from 29 Dec they slowly shrink, and after 29 Mar 2027 they are gone. Tip: keep 1-2 HBD in your MAGI wallet as energy (never taken, withdraw any time) or posting after claiming may fail. Admin keys burn 10 Oct as promised; the core can never be changed after. Details: ${POST} — this account is mine, Lasse.`;

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

async function sendComment(account, body = COMMENT_BODY) {
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
    body,
    // Deliberately NOT tagged `lassecash`: a tag would put 35 identical notices
    // into our own feed. This is outreach, not content.
    json_metadata: JSON.stringify({ app: "lassecash/2.0" }),
  }, postingKey());
  return `${parent.author}/${parent.permlink}`;
}

async function sendMemo(account, memo = MEMO) {
  await client.broadcast.transfer({
    from: ACCOUNT, to: account, amount: "0.001 HBD", memo,
  }, ACTIVE);
  return "0.001 HBD";
}

// ---------------------------------------------------------------- round-2 fix
//
// The letter sent 6 Sep said the unclaimed position "starts to shrink from
// 30 October". Wrong: grace is 90 days (engine.GraceDays), so the bleed starts
// day 120 = 29 December and the claim is refused after day 210 = 29 March
// 2027. The date came from a stale table that predates the grace widening.
// Hive lets an author edit a comment, so the 64 comments are rewritten in
// place with the corrected body; the 6 memos cannot be edited.
async function fixRound2(dry) {
  const progress = loadProgress();
  const sent = Object.entries(progress.round2 || {})
    .filter(([, v]) => String(v.where).startsWith("comment "));
  progress.round2fix = progress.round2fix || {};
  const todo = sent.filter(([a]) => !progress.round2fix[a]);
  console.log(`round2-fix: ${sent.length} comments sent, ${todo.length} still to correct`);
  if (dry) { console.log(`would edit: ${todo.map(([a]) => a).join(", ")}`); return; }
  let ok = 0, fail = 0;
  for (const [account, v] of todo) {
    const [parent_author, parent_permlink] = String(v.where).slice("comment ".length).split("/");
    const permlink = `re-lassecash-${parent_permlink}`.slice(0, 200).toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    try {
      await client.broadcast.comment({
        parent_author, parent_permlink, author: ACCOUNT, permlink, title: "",
        body: COMMENT2_BODY, json_metadata: JSON.stringify({ app: "lassecash/2.0" }),
      }, postingKey());
      progress.round2fix[account] = { at: new Date().toISOString() };
      saveProgress(progress); ok++;
      console.log(`  ok    @${account}`);
    } catch (e) {
      fail++; console.log(`  FAIL  @${account}  ${(e.message || e).toString().slice(0, 100)}`);
    }
    // Hive allows ONE comment edit per block per account. At a 3 s gap two
    // edits landed in the same block whenever the node was slow: 11 of 64
    // failed on 7 Sep with "one comment edit per block" and its mirror image,
    // "duplicate transaction". Two blocks of margin.
    await sleep(6_500);
  }
  console.log(`\ndone: ${ok} corrected, ${fail} failed`);
}

// A memo cannot be edited, so the 6 who got one get a second memo that says
// what was wrong and what is right, and nothing else.
const MEMO_FIX = `Correction to my memo of 6 Sept: your unclaimed LasseCash starts to shrink from 29 December (not 30 October), and can no longer be claimed after 29 March 2027. Before 30 September it still earns. Claim at lassecash.com — sorry for the wrong date. This account is mine, Lasse.`;

async function fixMemos(dry) {
  const progress = loadProgress();
  const got = Object.entries(progress.round2 || {})
    .filter(([, v]) => String(v.where).startsWith("memo ")).map(([a]) => a);
  progress.memofix = progress.memofix || {};
  const todo = got.filter((a) => !progress.memofix[a]);
  console.log(`memo-fix: ${got.length} got a memo, ${todo.length} still to correct`);
  console.log(`\n--- memo ---\n${MEMO_FIX}\n---`);
  if (dry) { console.log(`\nwould send to: ${todo.join(", ")}`); return; }
  let ok = 0, fail = 0;
  for (const account of todo) {
    try {
      await sendMemo(account, MEMO_FIX);
      progress.memofix[account] = { at: new Date().toISOString() };
      saveProgress(progress); ok++; console.log(`  ok    @${account}`);
    } catch (e) { fail++; console.log(`  FAIL  @${account}  ${(e.message || e).toString().slice(0, 100)}`); }
    await sleep(3_000);
  }
  console.log(`\ndone: ${ok} sent, ${fail} failed`);
}

// ---------------------------------------------------------------- main

async function main() {
  const mode = process.argv[2];
  if (mode === "round2-fix") return fixRound2(process.argv.includes("--dry"));
  if (mode === "memo-fix") return fixMemos(process.argv.includes("--dry"));
  if (!["comment", "memo", "lp", "round2"].includes(mode)) {
    console.error("usage: node tools/outreach.js <comment|memo|lp|round2> [--limit N] [--dry] [--all]");
    console.error("  round2: unclaimed holders from tools/unclaimed-2026-09-06.json, >= 1,000 LASSECASH");
    console.error("          (--all includes the 255 smaller ones). Tries a comment on their latest");
    console.error("          post; if they have none, sends the memo instead. Own progress bucket.");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const li = process.argv.indexOf("--limit");
  const limit = li > -1 ? parseInt(process.argv[li + 1], 10) : Infinity;

  let split;
  if (mode === "round2") {
    // The audit file is ranked by value and records who got round 1. Every
    // account >= 1,000 did; that is the point of writing to them again.
    const all = JSON.parse(fs.readFileSync(`${ROOT}/tools/unclaimed-2026-09-06.json`, "utf8"));
    const floor = process.argv.includes("--all") ? 0 : 1000;
    split = { round2: all.filter((r) => r.lassecash >= floor).map((r) => r.account) };
  } else {
    const listFile = mode === "lp" ? "lp-outreach-list.json" : "outreach-list.json";
    split = JSON.parse(fs.readFileSync(`${ROOT}/tools/${listFile}`, "utf8"));
  }
  const progress = loadProgress();
  // A mode added after the file was first written has no bucket in it yet.
  if (!progress[mode]) progress[mode] = {};
  const todo = split[mode].filter((a) => !progress[mode][a]);

  console.log(`${mode}: ${split[mode].length} on the list, ${todo.length} still to send`);
  if (dry) {
    const body = mode === "memo" ? MEMO : mode === "lp" ? LP_MEMO
      : mode === "round2" ? `${COMMENT2_BODY}\n\n--- memo fallback ---\n${MEMO2}` : COMMENT_BODY;
    console.log(`\n--- body ---\n${body}\n---`);
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
      let where;
      if (mode === "round2") {
        // Comment where there is something to reply to — it reads best and
        // costs nothing — otherwise the memo, so nobody is skipped for being
        // quiet on Hive. Progress records which one happened.
        const parent = await latestPost(account);
        where = parent ? `comment ${await sendComment(account, COMMENT2_BODY)}`
                       : `memo ${await sendMemo(account, MEMO2)}`;
      } else {
        where = mode === "comment" ? await sendComment(account)
          : await sendMemo(account, mode === "lp" ? LP_MEMO : MEMO);
      }
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

#!/usr/bin/env node
/**
 * The last manual-era donation: a letter and a little LASSECASH to every
 * active Hive account that has never used LasseCash.
 *
 * For six years Lasse did this by hand — 592 signed operations to 275 people,
 * 12,750,853 LASSECASH. This is the same act with a script behind it, and it
 * is meant to be the final entry in that record before the MAGI migration.
 *
 * LIQUID, NOT POWER — deliberately. Measured on Lasse's own history:
 * tokens_stake carries NO memo (32 stake ops, zero memos) while
 * tokens_transfer does. The letter is the entire point, so the tokens go
 * liquid to keep it. At this size the distinction is worth a fraction of a
 * cent and both count identically in the snapshot.
 *
 * ⚠️ RECEIVING IS NOT QUALIFYING. Under the C6 rule a migrating account must
 * have SIGNED a LASSECASH operation itself. This gift does not put anyone in
 * the snapshot — it gives them a reason to put themselves there. The memo says
 * so.
 *
 * Usage:
 *     node tools/donate-hive-actives.js --dry-run          print, send nothing
 *     node tools/donate-hive-actives.js --dry-run --limit 3
 *     node tools/donate-hive-actives.js --limit 1          send ONE, verify it
 *     node tools/donate-hive-actives.js                    send to everyone
 *
 * Resumable: every successful recipient is appended to sent.json, and a rerun
 * skips them. A crash mid-run costs nothing.
 */
const { Client, PrivateKey } = require("/tmp/keycheck/node_modules/@hiveio/dhive");
const fs = require("fs");
const path = require("path");

const SENDER_CFG = `${__dirname}/../deploy-data/config/identityConfig.json`;
const LIST = `${__dirname}/../tools/snapshot/data/hive_gift_list.json`;
const SENT = `${__dirname}/../tools/snapshot/data/hive_gift_sent.json`;
const SYMBOL = "LASSECASH";
const OPS_PER_TX = 5;          // Hive caps custom_json at 5 per account per block
const BLOCK_MS = 3200;

const DRY = process.argv.includes("--dry-run");
const li = process.argv.indexOf("--limit");
const LIMIT = li > -1 ? parseInt(process.argv[li + 1], 10) : Infinity;

/** Lasse's letter. The one factual edit from his draft: the 2019 publication
 *  was a hardcap and an inflation cap — the halving is what Hive-Engine
 *  refused to implement and what MAGI finally delivers. His own about page
 *  now says it this way, so the letter matches it. */
const LETTER = (amount) =>
`Dear Stranger, I first cameup with the tokenomics for LasseCash at inception in summer 2019 before day 1 where everything was set... few believed that I would not touch those unissued tokens for inflation only, because the way hive engine is build I had to hold the keys for that, I hacked the system and made my own rules writting on the chain, I published a hardcap and a halving schedule before day one and never changed either. I held the keys to 20 million unissued tokens for seven years and never touched one of them. You could have verified that at any point, and you can verify it now. That is the only claim I need to make. Here 7 years later I still didnt abuse those keys, so you could have trusted me, but I dont blame anybody, that system was suppose to be trustless. With the invention of MAGI that is now possible. We are working on a huge MAGI contract that write my vision of tokenomics ffrom sommer 2019 in stone forever in history via an immutable smart contract witten in FOREVER blocks, the vision became true (or will be most likely very soon), the design is being finished and its the best I have ever seen in crypto, thats why I want YOU (as an active Hive user) to be part of LasseCash and experience it by yourself. I been donating LASSECASH POWER and LASSECASH so many times over the years that I cannot count it (its on the chain), but first now was I able to make a script that reach all active users on Hive, so here is a gift from Lasse Ehlelrs to you,p set in stone, I know its not much, but it might be a good start and its more than any stranger proberbly ever gave you as a gift from a far distance, across the Flat Earth... Remember to read the announcement that comes soon, to make sure you are in the snapshot and you are good to go, on the future of LasseCash, Yours Lasse Ehlers

Here is the gift: ${amount} LASSECASH, remember to be active on LasseCash before the snapshot to make the tokens transfer to MAGI, details on my blog @lasseehlers at announcement!`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : d);

async function balance(account) {
  const res = await fetch("https://api.hive-engine.com/rpc/contracts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "find", params: {
      contract: "tokens", table: "balances",
      query: { account, symbol: SYMBOL }, limit: 2 } }),
  });
  const d = await res.json();
  return Number(d.result?.[0]?.balance ?? 0);
}

async function main() {
  const list = load(LIST, null);
  if (!list) { console.error(`no list at ${LIST} — build it first`); process.exit(1); }
  const sent = new Set(load(SENT, []));
  const todo = list.recipients.filter((a) => !sent.has(a)).slice(0, LIMIT);
  const each = list.each;

  console.log(`${DRY ? "DRY RUN — " : ""}${SYMBOL} gift`);
  console.log(`  recipients in list : ${list.recipients.length.toLocaleString()}`);
  console.log(`  already sent       : ${sent.size.toLocaleString()}`);
  console.log(`  sending now        : ${todo.length.toLocaleString()} × ${each}`);
  console.log(`  memo bytes         : ${Buffer.byteLength(LETTER(each))}`);

  const cfg = JSON.parse(fs.readFileSync(SENDER_CFG, "utf8"));
  const bal = await balance(cfg.HiveUsername);
  const need = todo.length * Number(each);
  console.log(`  @${cfg.HiveUsername} holds ${bal.toLocaleString()}, needs ${need.toLocaleString()}`);
  if (!DRY && bal < need) {
    console.error(`\n  REFUSING: short by ${(need - bal).toFixed(8)}. Top up first.`);
    process.exit(1);
  }

  if (DRY) {
    for (const to of todo.slice(0, 3)) console.log(`  would send ${each} -> @${to}`);
    if (todo.length > 3) console.log(`  …and ${todo.length - 3} more`);
    console.log(`\n--- memo as sent ---\n${LETTER(each)}`);
    return;
  }

  const key = PrivateKey.fromString(cfg.HiveActiveKey);
  const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);
  let done = 0;

  for (let i = 0; i < todo.length; i += OPS_PER_TX) {
    const chunk = todo.slice(i, i + OPS_PER_TX);
    const ops = chunk.map((to) => ["custom_json", {
      id: "ssc-mainnet-hive",
      required_auths: [cfg.HiveUsername],
      required_posting_auths: [],
      json: JSON.stringify({
        contractName: "tokens", contractAction: "transfer",
        contractPayload: { symbol: SYMBOL, to, quantity: each, memo: LETTER(each) },
      }),
    }]);
    try {
      const res = await client.broadcast.sendOperations(ops, key);
      chunk.forEach((a) => sent.add(a));
      fs.writeFileSync(SENT, JSON.stringify([...sent]));
      done += chunk.length;
      console.log(`  ${String(done).padStart(5)}/${todo.length}  tx ${res.id}  (${chunk.length} recipients)`);
    } catch (e) {
      console.error(`  ! batch at ${i} failed: ${e.message} — rerun to resume`);
      await sleep(BLOCK_MS * 2);
      continue;
    }
    await sleep(BLOCK_MS);
  }
  console.log(`\n  done. ${sent.size.toLocaleString()} recipients recorded in ${path.basename(SENT)}`);
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

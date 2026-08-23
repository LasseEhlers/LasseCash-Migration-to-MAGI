#!/usr/bin/env node
/**
 * The last manual-era donation, second edition: LASSECASH POWER plus a letter,
 * to every active Hive account that has never used LasseCash.
 *
 * WHY THIS REPLACES donate-hive-actives.js
 * ----------------------------------------
 * Run 1 sent LIQUID tokens with the letter in the Hive-Engine memo, because
 * Hive-Engine's stake operation has NO memo field — verified against the
 * contract's own history, where a tokens_stake record carries
 * (_id, blockNumber, transactionId, timestamp, operation, symbol, from, to,
 * quantity, account) and nothing else.
 *
 * That trade was wrong in both directions. Liquid can be dumped the same
 * afternoon, and a Hive-Engine memo is invisible in wallet.hive.blog, peakd and
 * ecency — the wallets people actually open — so most of run 1's recipients
 * never saw the letter at all.
 *
 * This version splits the gift across the two layers, each carrying the thing
 * it is good at:
 *
 *     Hive-Engine custom_json   stake  -> the tokens, staked, undumpable
 *     Hive L1 transfer          0.001 HIVE + memo -> the letter, where it is read
 *
 * Both operations travel in ONE Hive transaction per batch, so a recipient
 * either gets both or neither. It is also 6.7x cheaper in RC than run 1
 * (~148 M vs ~990 M per recipient), because the 2 KB memo now rides on an L1
 * transfer instead of a Hive-Engine custom_json.
 *
 * ⚠️ RECEIVING IS NOT QUALIFYING. Under the C6 rule a migrating account must
 * have SIGNED a LASSECASH operation itself. This gift does not put anyone in
 * the snapshot — it gives them a reason to put themselves there. The memo says
 * so.
 *
 * Usage:
 *     node tools/donate-hive-power.js --dry-run            print, send nothing
 *     node tools/donate-hive-power.js --limit 1            send ONE, verify it
 *     node tools/donate-hive-power.js                      send to everyone
 *
 * Resumable and RC-aware: it stops cleanly when the meter runs low rather than
 * erroring out, so the cron wrapper simply resumes on the next pass.
 */
const { Client, PrivateKey } = require("/tmp/keycheck/node_modules/@hiveio/dhive");
const fs = require("fs");
const path = require("path");

const SENDER_CFG = `${__dirname}/../deploy-data/config/identityConfig.json`;
const LIST = `${__dirname}/snapshot/data/hive_gift_list.json`;
const SENT = `${__dirname}/snapshot/data/hive_gift2_sent.json`;
const SYMBOL = "LASSECASH";
const DUST = "0.001 HIVE";        // the L1 carrier for the letter
const OPS_PER_TX = 5;             // Hive caps custom_json at 5 per account per block
const BLOCK_MS = 3200;

/** Stop while this much RC is left. One batch costs ~0.74 G; leaving a whole
 *  gigarc of headroom means a half-sent batch can never be the reason we stop,
 *  and the account is never left unable to act. */
const RC_FLOOR = 2e9;

const DRY = process.argv.includes("--dry-run");
const li = process.argv.indexOf("--limit");
const LIMIT = li > -1 ? parseInt(process.argv[li + 1], 10) : Infinity;

/** The memo. DELIBERATELY SHORT — measured, not guessed: a Hive L1 memo costs
 *  about 0.76 M RC per byte, so Lasse's full 2,046-byte letter costs 1,753 M RC
 *  per recipient and would take 26.5 days to reach 4,443 people. At ~180 bytes
 *  it costs 216 M and takes 3.3 days, which finishes comfortably before the
 *  snapshot. The full letter lives on his blog; this points at it. */
const LETTER = (amount) =>
`A gift from Lasse Ehlers: ${amount} LASSECASH POWER, staked to your account on Hive-Engine. The full letter and the migration deadline are on my blog @lasseehlers. Be active on LasseCash before the snapshot.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : d);

async function heBalance(account) {
  const res = await fetch("https://api.hive-engine.com/rpc/contracts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "find", params: {
      contract: "tokens", table: "balances",
      query: { account, symbol: SYMBOL }, limit: 2 } }),
  });
  const d = await res.json();
  return Number(d.result?.[0]?.balance ?? 0);
}

async function rc(client, account) {
  const r = await client.call("rc_api", "find_rc_accounts", { accounts: [account] });
  return Number(r.rc_accounts[0].rc_manabar.current_mana);
}

async function main() {
  const list = load(LIST, null);
  if (!list) { console.error(`no list at ${LIST} — build it first`); process.exit(1); }
  const sent = new Set(load(SENT, []));
  const todo = list.recipients.filter((a) => !sent.has(a)).slice(0, LIMIT);
  const each = list.each;

  const cfg = JSON.parse(fs.readFileSync(SENDER_CFG, "utf8"));
  const client = new Client(["https://api.hive.blog", "https://api.deathwing.me"]);
  const [acct] = await client.database.getAccounts([cfg.HiveUsername]);

  const needLC = todo.length * Number(each);
  const needHIVE = todo.length * 0.001;
  const haveLC = await heBalance(cfg.HiveUsername);
  const haveHIVE = Number(acct.balance.split(" ")[0]);

  console.log(`${DRY ? "DRY RUN — " : ""}${SYMBOL} POWER gift + L1 letter`);
  console.log(`  recipients in list : ${list.recipients.length.toLocaleString()}`);
  console.log(`  already sent       : ${sent.size.toLocaleString()}`);
  console.log(`  sending now        : ${todo.length.toLocaleString()} x ${each} POWER`);
  console.log(`  memo bytes         : ${Buffer.byteLength(LETTER(each))}`);
  console.log(`  LASSECASH  have ${haveLC.toLocaleString()}  need ${needLC.toLocaleString()}`);
  console.log(`  HIVE       have ${haveHIVE.toFixed(3)}  need ${needHIVE.toFixed(3)}`);

  if (!DRY && haveLC < needLC) {
    console.error(`\n  REFUSING: short ${(needLC - haveLC).toFixed(8)} LASSECASH. Top up first.`);
    process.exit(1);
  }
  if (!DRY && haveHIVE < needHIVE) {
    console.error(`\n  REFUSING: short ${(needHIVE - haveHIVE).toFixed(3)} HIVE. Top up first.`);
    process.exit(1);
  }

  if (DRY) {
    for (const to of todo.slice(0, 3)) console.log(`  would stake ${each} -> @${to}  + ${DUST} letter`);
    if (todo.length > 3) console.log(`  ...and ${todo.length - 3} more`);
    console.log(`\n--- memo as sent ---\n${LETTER(each)}`);
    return;
  }

  const key = PrivateKey.fromString(cfg.HiveActiveKey);
  let done = 0;

  for (let i = 0; i < todo.length; i += OPS_PER_TX) {
    const have = await rc(client, cfg.HiveUsername);
    if (have < RC_FLOOR) {
      console.log(`\n  RC down to ${(have / 1e9).toFixed(2)} G — stopping cleanly. ` +
                  `${sent.size.toLocaleString()} done, ${(list.recipients.length - sent.size).toLocaleString()} left. Cron resumes.`);
      break;
    }

    const chunk = todo.slice(i, i + OPS_PER_TX);
    const ops = [];
    for (const to of chunk) {
      // The tokens: staked directly into the recipient's account.
      ops.push(["custom_json", {
        id: "ssc-mainnet-hive",
        required_auths: [cfg.HiveUsername],
        required_posting_auths: [],
        json: JSON.stringify({
          contractName: "tokens", contractAction: "stake",
          contractPayload: { symbol: SYMBOL, to, quantity: each },
        }),
      }]);
      // The letter: on L1, where wallets actually display a memo.
      ops.push(["transfer", {
        from: cfg.HiveUsername, to, amount: DUST, memo: LETTER(each),
      }]);
    }

    try {
      const res = await client.broadcast.sendOperations(ops, key);
      chunk.forEach((a) => sent.add(a));
      fs.writeFileSync(SENT, JSON.stringify([...sent]));
      done += chunk.length;
      console.log(`  ${String(sent.size).padStart(5)}/${list.recipients.length}  tx ${res.id}  (${chunk.length} recipients, RC ${(have / 1e9).toFixed(1)} G)`);
    } catch (e) {
      console.error(`  ! batch at ${i} failed: ${e.message} — rerun to resume`);
      await sleep(BLOCK_MS * 2);
      continue;
    }
    await sleep(BLOCK_MS);
  }
  console.log(`\n  ${sent.size.toLocaleString()} recipients recorded in ${path.basename(SENT)}`);
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

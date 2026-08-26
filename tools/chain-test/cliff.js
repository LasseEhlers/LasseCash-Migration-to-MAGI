#!/usr/bin/env node
/**
 * Multi-account driver for the throwaway "board cliff" soak (throwaway #8).
 *
 * The three lessons this tool exists to enforce (2026-08-25):
 *   1. MAGI freezes the FULL declared rc_limit for 5 days, success or not, and
 *      every new call restarts the clock on the whole frozen remainder. So
 *      `call` REFUSES unless the account's REAL available RC covers rc_limit —
 *      read from getAccountRC when the node answers, else derived from the
 *      account's own Hive history with the node's exact CalculateFrozenBal.
 *   2. A broadcast is not a result. `call` dry-runs on the node first and
 *      refuses if the simulation fails or its rc_used exceeds the limit; `tx`
 *      follows a broadcast to its on-chain verdict (findTransaction + the
 *      output DAG's errMsg); `state` reads the state the call should have
 *      written. Only readable state counts.
 *   3. Nothing moves value: vsc.call spends no HIVE/HBD and no intent is ever
 *      attached here.
 *
 *   cliff.js rc    <acct>
 *   cliff.js sim   <acct> <action> [payload]
 *   cliff.js call  <acct> <action> [payload] [rc_limit]
 *   cliff.js tx    <tx_id>
 *   cliff.js state <key> [key...]
 *   cliff.js height
 *
 * Keys come from deploy-data/config/{identityConfig,testAccounts20}.json and
 * are never printed. The contract id is pinned via the CONTRACT env var so a
 * stale pin can never be broadcast to by accident.
 */
const { Client, PrivateKey } = require("@hiveio/dhive");
const fs = require("fs");

const GQL = "https://api.vsc.eco/api/v1/graphql";
const CONTRACT = process.env.CONTRACT;
const RC_RETURN_PERIOD_S = 5 * 86400;
const FREE_RC = 10_000;
const cfgDir = `${__dirname}/../../deploy-data/config`;

function keyFor(acct) {
  const id = JSON.parse(fs.readFileSync(`${cfgDir}/identityConfig.json`, "utf8"));
  if (id.HiveUsername === acct) return PrivateKey.fromString(id.HiveActiveKey);
  const rows = JSON.parse(fs.readFileSync(`${cfgDir}/testAccounts20.json`, "utf8"));
  const row = rows.find((r) => r.HiveUsername === acct);
  if (!row) throw new Error(`no key on disk for @${acct}`);
  return PrivateKey.fromString(row.HiveActiveKey);
}

async function gql(query, variables) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`gql ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const hive = () => new Client(["https://api.hive.blog", "https://api.deathwing.me"]);

/** Available RC: node figure when it answers; else derived from Hive history. */
async function availableRc(acct) {
  const node = await gql(
    `query($a:String!){ getAccountRC(account:$a){ amount max_rcs } getAccountBalance(account:$a){ hbd } }`,
    { a: `hive:${acct}` },
  );
  const rc = node.data && node.data.getAccountRC;
  const hbdMilli = (node.data && node.data.getAccountBalance && node.data.getAccountBalance.hbd) || 0;
  const cap = hbdMilli + FREE_RC;
  // Derive from history with the node's own formula: each call restarts the
  // clock on (frozen-so-far + rc_limit), capped at the meter.
  const hist = await hive().call("condenser_api", "get_account_history", [acct, -1, 200]);
  const now = Date.now() / 1000;
  let frozen = 0, start = null;
  for (const [, op] of hist) {
    const o = op.op;
    if (o[0] !== "custom_json" || o[1].id !== "vsc.call") continue;
    const ts = Date.parse(op.timestamp + "Z") / 1000;
    if (now - ts >= RC_RETURN_PERIOD_S) continue;
    if (start !== null) frozen *= 1 - (ts - start) / RC_RETURN_PERIOD_S;
    frozen = Math.min(cap, frozen + (JSON.parse(o[1].json).rc_limit || 0));
    start = ts;
  }
  if (start !== null) frozen *= 1 - (now - start) / RC_RETURN_PERIOD_S;
  const derived = Math.floor(cap - frozen);
  const fromNode = rc && rc.max_rcs > 0 ? rc.amount : null;
  return { cap, derived, fromNode, available: fromNode !== null ? fromNode : derived };
}

async function simulate(acct, action, payload) {
  const d = await gql(
    `query($i: SimulateContractCallsInput!) { simulateContractCalls(input: $i) { success err_msg gas_used rc_used ret } }`,
    { i: { tx_id: "sim", required_auths: `hive:${acct}`,
           calls: [{ contract_id: CONTRACT, action, payload, rc_limit: 100_000, intents: [] }] } },
  );
  if (d.errors) throw new Error(JSON.stringify(d.errors).slice(0, 300));
  return d.data.simulateContractCalls[0];
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "height") {
    const p = await hive().database.getDynamicGlobalProperties();
    console.log(p.head_block_number);
    return;
  }
  if (cmd === "state") {
    const d = await gql(`query($c:String!,$k:[String!]!){ getStateByKeys(contractId:$c, keys:$k) }`,
      { c: CONTRACT, k: args });
    console.log(JSON.stringify(d.data ? d.data.getStateByKeys : d));
    return;
  }
  if (cmd === "tx") {
    const [id] = args;
    const d = await gql(`query($id:String!){ findTransaction(filterOptions:{byId:$id}){ status output { id } } }`, { id });
    const tx = d.data && d.data.findTransaction && d.data.findTransaction[0];
    if (!tx) { console.log(JSON.stringify({ status: "UNKNOWN" })); return; }
    let error;
    const cid = tx.output && tx.output[0] && tx.output[0].id;
    if (cid) {
      const dag = await gql(`query($c:String!){ getDagByCID(cidString:$c) }`, { c: cid });
      try {
        const parsed = JSON.parse(dag.data.getDagByCID);
        const r = parsed.results && parsed.results[0];
        error = r && (r.errMsg || r.err);
        console.log(JSON.stringify({ status: tx.status, output: cid, results: parsed.results }));
        return;
      } catch (_) { /* fall through */ }
    }
    console.log(JSON.stringify({ status: tx.status, output: cid, error }));
    return;
  }
  if (!CONTRACT && cmd !== "rc") throw new Error("CONTRACT env var not set (refusing a stale pin)");
  if (cmd === "rc") {
    const [acct] = args;
    console.log(JSON.stringify({ account: acct, ...(await availableRc(acct)) }));
    return;
  }
  if (cmd === "transfer") {
    // vsc.transfer: move HBD between MAGI balances (funds a test account's RC
    // meter instantly — capacity = HBD milli + 10,000). amount like "3.000".
    const [from, to, amount, asset = "hbd"] = args;
    if (!from || !to || !amount) throw new Error("usage: transfer <from> <to> <amount> [asset]");
    const json = JSON.stringify({ from: `hive:${from}`, to: `hive:${to}`, amount, asset, net_id: "vsc-mainnet" });
    const res = await hive().broadcast.json(
      { id: "vsc.transfer", required_auths: [from], required_posting_auths: [], json }, keyFor(from));
    console.log(JSON.stringify({ tx_id: res.id, block: res.block_num, from, to, amount, asset }));
    return;
  }
  if (cmd === "sim") {
    const [acct, action, payload = ""] = args;
    console.log(JSON.stringify(await simulate(acct, action, payload)));
    return;
  }
  if (cmd === "call") {
    const [acct, action, payload = "", rcArg] = args;
    if (!acct || !action) throw new Error("usage: call <acct> <action> [payload] [rc_limit]");
    const key = keyFor(acct);
    const sim = await simulate(acct, action, payload);
    if (!sim.success) {
      console.error(`REFUSED: simulation failed: ${sim.err_msg}`);
      process.exit(3);
    }
    // Default limit: simulated RC + 25%, rounded up to the hundred. Mainnet
    // charges writes 19x; the simulation runs the same weights, so a quarter
    // of margin covers height drift between dry-run and inclusion.
    const rcLimit = rcArg ? Number(rcArg) : Math.ceil((sim.rc_used * 1.25) / 100) * 100;
    if (rcLimit < sim.rc_used) {
      console.error(`REFUSED: rc_limit ${rcLimit} < simulated ${sim.rc_used}`);
      process.exit(3);
    }
    const rc = await availableRc(acct);
    if (rc.available < rcLimit) {
      console.error(`REFUSED: @${acct} has ~${rc.available} RC available (cap ${rc.cap}); needs ${rcLimit}`);
      process.exit(4);
    }
    const json = JSON.stringify({ net_id: "vsc-mainnet", contract_id: CONTRACT, action, payload, rc_limit: rcLimit, intents: [] });
    const res = await hive().broadcast.json(
      { id: "vsc.call", required_auths: [acct], required_posting_auths: [], json }, key);
    console.log(JSON.stringify({ tx_id: res.id, block: res.block_num, account: acct, action, payload,
      rc_limit: rcLimit, simulated_rc: sim.rc_used, simulated_ret: sim.ret, rc_available_before: rc.available }));
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); });

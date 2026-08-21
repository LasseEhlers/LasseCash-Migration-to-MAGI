/**
 * The test that justifies the whole approach: the browser engine must agree
 * with the chain EXACTLY, not approximately.
 *
 * If these ever diverge, the frontend is showing users a number the chain will
 * not honour — which is precisely what the golden rule exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  blockSplit, consensusGroup, constants, durationMultiplier, effectiveValue,
  engineReady, estimateLiquidity, estimateSwap, loadEngine, loyaltyMultiplier,
  mintQuote, previewMintClose, routePayout, shareRate, voteCost, volumeMultiplier,
} from "./engine.js";
import { toBaseUnitArg, toUnits } from "./amount.js";
import { DevBackend } from "./dev-backend.js";
import { LasseCashClient } from "./client.js";

// TinyGo's shim is a classic script; load it before instantiating.
createRequire(import.meta.url)("./wasm/wasm_exec.cjs");
// Supply the bytes directly: the library never imports node:fs, so that a
// browser bundle stays clean.
const { readFile } = await import("node:fs/promises");
await loadEngine(undefined, await readFile(new URL("./wasm/engine.wasm", import.meta.url)));

const DEV = process.env.LASSECASH_DEV_URL ?? "http://localhost:8080";
const up = await (async () => {
  try {
    return (await fetch(`${DEV}/chain`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch { return false; }
})();

test("the engine loads and reports the protocol constants", () => {
  assert.ok(engineReady());
  const c = constants();
  assert.equal(c.decimals, 8);
  assert.equal(c.minMintDays, 1);
  assert.equal(c.maxMintDays, 1095);
  assert.equal(c.graceDays, 30);
  assert.equal(c.bleedDays, 90);
  assert.equal(c.goodAcctArmDays, 30); // the grace month AFTER maturity
  assert.equal(c.goodAcctGrace, 1095);
  assert.equal(c.loyaltyMaxDays, 90);
  assert.equal(c.fullVoteCostPct, 10);
  assert.equal(c.viralPayoutDays, 7);
  assert.equal(c.deepPayoutDays, 30);
});

test("multipliers match the specification exactly", () => {
  assert.equal(durationMultiplier(1), "1.00000000");
  assert.equal(durationMultiplier(1095), "1.50000000");
  assert.equal(durationMultiplier(99999), "1.50000000", "must clamp, not extrapolate");

  const start = toBaseUnitArg("10000");
  const end = toBaseUnitArg("100000");
  assert.equal(volumeMultiplier(toBaseUnitArg("10000"), start, end), "1.00000000");
  assert.equal(volumeMultiplier(toBaseUnitArg("100000"), start, end), "1.50000000");
  assert.equal(volumeMultiplier(toBaseUnitArg("55000"), start, end), "1.25000000");

  assert.equal(loyaltyMultiplier(0), "1.00000000");
  assert.equal(loyaltyMultiplier(30), "1.30000000");
  assert.equal(loyaltyMultiplier(90), "1.90000000");
  assert.equal(loyaltyMultiplier(365), "1.90000000", "must cap at 90 days");
});

test("the headline 2.25x case", () => {
  const q = mintQuote(toBaseUnitArg("100000"), 1095,
    toBaseUnitArg("1"), toBaseUnitArg("10000"), toBaseUnitArg("100000"));
  assert.ok(q.ok);
  assert.equal(q.durationMultiplier, "1.50000000");
  assert.equal(q.volumeMultiplier, "1.50000000");
  assert.equal(q.combinedMultiplier, "2.25000000");
  assert.equal(q.shares, "225000.00000000");
});

test("the share rate ratchets 7% a year and never falls", () => {
  const genesis = 109_200_000;
  const year = 365 * 28_800; // heights per year
  assert.equal(shareRate(genesis, genesis), "1.00000000");
  assert.equal(shareRate(genesis, genesis + year), "1.07000000");
  // Compounding, not linear.
  assert.equal(shareRate(genesis, genesis + 2 * year), "1.14490000");
  assert.equal(shareRate(genesis, genesis - year), "1.00000000", "pre-genesis must not underflow");
});

test("vote cost and the 20/80 payout routing", () => {
  assert.equal(voteCost(100), "0.10000000", "a full vote costs 10% of power");
  assert.equal(voteCost(50), "0.05000000");
  assert.equal(voteCost(0), "0.00000000");

  const r = routePayout(toBaseUnitArg("100"));
  assert.equal(r.liquid, "20.00000000");
  assert.equal(r.pending, "80.00000000");
  assert.equal(toUnits(r.liquid) + toUnits(r.pending), toUnits("100.00000000"));
});

test("the block split loses nothing", () => {
  const s = blockSplit(toBaseUnitArg("100"));
  const total = toUnits(s.lshare) + toUnits(s.liquidity) + toUnits(s.proofOfBrain);
  assert.equal(total, toUnits("100.00000000"));
  assert.equal(toUnits(s.viral) + toUnits(s.deep), toUnits(s.proofOfBrain));
  assert.equal(s.lshare, "25.00000000");
  assert.equal(s.liquidity, "25.00000000");
  assert.equal(s.proofOfBrain, "50.00000000");
});

test("closing a mint: recovery rises 50% to 100%, yield forfeited early", () => {
  const genesis = 109_200_000;
  const day = 28_800;
  const mint = {
    principal: "10000.00000000",
    shares: "15000.00000000",
    start_height: genesis,
    days: 1095,
    good_accounting: false,
  };
  const yieldUnits = toBaseUnitArg("500");

  const atStart = previewMintClose(mint, genesis, yieldUnits);
  assert.ok(atStart.early);
  assert.equal(atStart.recoveryFraction, "0.50000000");
  assert.equal(atStart.toOwner, "5000.00000000", "half the principal, no yield");

  const atMaturity = previewMintClose(mint, genesis + 1095 * day, yieldUnits);
  assert.equal(atMaturity.early, false);
  assert.ok(atMaturity.mature);
  assert.equal(atMaturity.toOwner, "10500.00000000", "principal plus yield");

  // Conservation holds at every point.
  for (const h of [genesis, genesis + day, genesis + 500 * day, genesis + 1095 * day]) {
    const p = previewMintClose(mint, h, yieldUnits);
    assert.equal(
      toUnits(p.toOwner) + toUnits(p.toRewardPool),
      toUnits(mint.principal) + toUnits("500.00000000"),
      `value leaked at height ${h}`,
    );
  }
});

test("Good Accounting arms only during the 30-day grace AFTER maturity", () => {
  // Decided 2026-08-21: never before maturity (nothing to decide yet), never
  // once the bleed has started (no retroactive opt-out).
  const genesis = 109_200_000;
  const day = 28_800;
  const mint = {
    principal: "1000.00000000", shares: "1000.00000000",
    start_height: genesis, days: 365, good_accounting: false,
  };
  const maturity = genesis + 365 * day;
  assert.equal(previewMintClose(mint, genesis, "0").canArmGoodAccounting, false);
  assert.equal(previewMintClose(mint, maturity - day, "0").canArmGoodAccounting, false,
    "not before maturity");
  assert.equal(previewMintClose(mint, maturity, "0").canArmGoodAccounting, true, "opens at maturity");
  assert.equal(previewMintClose(mint, maturity + 29 * day, "0").canArmGoodAccounting, true,
    "last day of grace");
  assert.equal(previewMintClose(mint, maturity + 30 * day, "0").canArmGoodAccounting, false,
    "closed once the bleed starts");
});

test("governed values: the default, the LOWER median, and bounds no vote can leave", () => {
  const key = constants().paramVolumeStart;
  // Every figure below is the registration in engine/governance.go:
  // ParamVolumeStart = LC(10_000), bounded [LC(100), LC(50_000)].
  const m = (account: string, shares: string, preference: string | null) => ({
    account,
    shares: toBaseUnitArg(shares),
    preference: preference === null ? null : toBaseUnitArg(preference),
  });

  const none = effectiveValue(key, []);
  assert.ok(none.ok);
  assert.equal(none.defaultValue, "10000.00000000");
  assert.equal(none.min, "100.00000000");
  assert.equal(none.max, "50000.00000000");
  assert.equal(none.value, "10000.00000000", "no board at all: the default stands");
  assert.equal(
    effectiveValue(key, [m("hive:alice", "500", null), m("hive:bob", "400", null)]).value,
    "10000.00000000", "a board that has never voted: still the default");

  // Four votes -> 1000, 2000, 3000, 4000. The lower of the two middle values
  // wins, so 2000 and never 2500: integer, exact, identical on every node.
  assert.equal(effectiveValue(key, [
    m("hive:alice", "500", "4000"),
    m("hive:bob", "400", "2000"),
    m("hive:carol", "300", "3000"),
    m("hive:dave", "200", "1000"),
  ]).value, "2000.00000000", "an even count takes the LOWER middle vote");

  // The hardcoded bounds hold even against a member voting alone.
  assert.equal(effectiveValue(key, [m("hive:whale", "900", "1000000")]).value,
    "50000.00000000", "above Max clamps to LC(50_000), it is not honoured");
  assert.equal(effectiveValue(key, [m("hive:whale", "900", "1")]).value,
    "100.00000000", "below Min clamps to LC(100)");

  // A missing MAGI key reads back as an EMPTY STRING, not as nil (CLAUDE.md's
  // empty-vs-nil bug). It must mean "never voted", never "voted for zero" —
  // which would clamp to Min and drag the median down.
  assert.equal(effectiveValue(key, [
    { account: "hive:alice", shares: toBaseUnitArg("500"), preference: "" },
  ]).value, "10000.00000000");

  // A board entry holding no shares holds no seat, so it casts no vote.
  assert.equal(effectiveValue(key, [
    m("hive:alice", "500", "4000"), m("hive:ghost", "0", "1000"),
  ]).value, "4000.00000000");

  assert.equal(effectiveValue("mint.no_such_param", [m("hive:alice", "500", "2000")]).ok,
    false, "an unknown key must fail closed, not read as zero");
});

test("consensusGroup: shares-desc, name-asc ties, zero-share drop, capped at 10", () => {
  // Every rule below is engine.ConsensusGroup / betterThan in
  // engine/governance.go: more shares first, then lower account name; a
  // holder with Shares <= 0 never takes a seat; the window is fixed at
  // ConsensusSize = 10 regardless of how many candidates are offered.
  const m = (account: string, shares: string) => ({ account, shares: toBaseUnitArg(shares) });

  assert.deepEqual(
    consensusGroup([m("hive:bob", "100"), m("hive:alice", "200")]).map((x) => x.account),
    ["hive:alice", "hive:bob"], "more shares ranks first");

  assert.deepEqual(
    consensusGroup([m("hive:zed", "100"), m("hive:amy", "100")]).map((x) => x.account),
    ["hive:amy", "hive:zed"], "equal shares: lower account name wins the tie");

  assert.deepEqual(
    consensusGroup([m("hive:alice", "100"), m("hive:ghost", "0")]).map((x) => x.account),
    ["hive:alice"], "a zero-share holder takes no seat");

  const eleven = Array.from({ length: 11 }, (_, i) =>
    m(`hive:acct${String(i).padStart(2, "0")}`, String(1000 - i)));
  const top = consensusGroup(eleven);
  assert.equal(top.length, 10, "at most ConsensusSize = 10 seats, even with 11 candidates");
  assert.deepEqual(top.map((x) => x.account),
    eleven.slice(0, 10).map((x) => x.account), "the ten highest-share candidates win");
  assert.equal(top[0]?.shares, "1000.00000000");
});

test("swap estimate has slippage and refuses nonsense", () => {
  const resIn = toBaseUnitArg("1000000");
  const resOut = toBaseUnitArg("1030");

  const small = estimateSwap(resIn, resOut, toBaseUnitArg("100"));
  const big = estimateSwap(resIn, resOut, toBaseUnitArg("100000"));
  assert.ok(small.ok && big.ok);
  assert.ok(toUnits(big.rate) < toUnits(small.rate), "larger trade must get a worse rate");
  assert.ok(toUnits(big.priceImpactPct) > toUnits(small.priceImpactPct));

  assert.equal(estimateSwap("0", resOut, toBaseUnitArg("1")).ok, false);
  assert.equal(estimateSwap(resIn, resOut, "0").ok, false);
});

test("liquidity estimate keeps the pool ratio", () => {
  const e = estimateLiquidity(
    toBaseUnitArg("10000"), toBaseUnitArg("100000"),
    toBaseUnitArg("25000"), toBaseUnitArg("100000"));
  assert.ok(e.ok);
  assert.equal(e.hbdNeeded, "2500.00000000", "10% of LC needs 10% of HBD");
  assert.equal(e.shares, "10000.00000000");

  const first = estimateLiquidity(toBaseUnitArg("1000"), "0", "0", "0");
  assert.ok(first.isFirstDeposit);
});

// ---------------------------------------------------------------------------
// THE agreement test. Browser engine vs the chain, same inputs, same outputs.
// ---------------------------------------------------------------------------

test("browser engine agrees with the chain EXACTLY", { skip: !up }, async () => {
  const backend = new DevBackend({ url: DEV });
  const client = new LasseCashClient({ backend });
  const info = await client.chain();

  for (const [amount, days] of [
    ["100000", 1095], ["10000", 365], ["1", 1], ["55000", 500], ["999.99999999", 90],
  ] as const) {
    const chainQuote = await client.quoteMint(amount, days);
    const localQuote = mintQuote(
      toBaseUnitArg(amount), days,
      toBaseUnitArg(chainQuote.share_rate),
      toBaseUnitArg("10000"), toBaseUnitArg("100000"),
    );
    assert.equal(localQuote.shares, chainQuote.shares,
      `shares disagree for ${amount} LC / ${days}d`);
    assert.equal(localQuote.durationMultiplier, chainQuote.duration_multiplier);
    assert.equal(localQuote.volumeMultiplier, chainQuote.volume_multiplier);
    assert.equal(localQuote.combinedMultiplier, chainQuote.combined_multiplier);
  }

  // And the swap, against live reserves.
  for (const amount of ["100", "1000", "50000"]) {
    const chainSwap = await client.quoteSwap("lc_hbd", amount);
    const localSwap = estimateSwap(
      toBaseUnitArg(info.amm_lc), toBaseUnitArg(info.amm_hbd),
      toBaseUnitArg(amount));
    assert.equal(localSwap.amountOut, chainSwap.amount_out,
      `swap output disagrees for ${amount} LC`);
    assert.equal(localSwap.priceImpactPct, chainSwap.price_impact_pct);
  }
});

test("the share rate agrees with the chain", { skip: !up }, async () => {
  const client = new LasseCashClient({ backend: new DevBackend({ url: DEV }) });
  const info = await client.chain();
  const chainQuote = await client.quoteMint("1000", 365);
  assert.equal(shareRate(info.genesis_height, info.height), chainQuote.share_rate);
});

test("previews are fast enough for a 60fps slider", () => {
  const t0 = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i++) durationMultiplier((i % 1095) + 1);
  const per = (performance.now() - t0) / N;
  assert.ok(per < 16, `${per.toFixed(3)}ms per call exceeds the 16ms frame budget`);
  console.log(`  ${per.toFixed(3)}ms per engine call`);
});

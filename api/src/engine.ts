/**
 * The LasseCash engine, in the browser.
 *
 * THIS IS NOT A REIMPLEMENTATION. It loads the SAME Go engine that runs on-chain
 * and in the dev chain, compiled to WASM. Every function here is a thin typed
 * wrapper around a call into that binary. Adding a formula to this file would be
 * exactly the drift the golden rule exists to prevent — if a preview needs a
 * number the engine does not expose, add it to `api/engine-wasm/main.go`.
 *
 * Measured: ~104KB wasm + 16KB shim, ~0.36ms per call. A 60fps slider has a
 * 16ms budget, so this is roughly 45x faster than it needs to be.
 *
 * ESTIMATE vs EXACT — the distinction matters and is marked on every method:
 *   - Pure functions of user input are EXACT. Nothing can make them stale.
 *   - Functions of live pool state are ESTIMATES: reserves and pool balances
 *     move between preview and broadcast. Label them in the UI, and always
 *     submit swaps with a minOut.
 */
import type { Amount } from "./amount.js";
import { fromUnits, toUnits, toBaseUnitArg } from "./amount.js";

/** Raw bridge shape. All values cross as base-unit strings. */
interface Bridge {
  mintQuote(principal: string, days: number, shareRate: string,
    volumeStart: string, volumeEnd: string): {
      ok: boolean; shares: string; durationMultiplier: string;
      volumeMultiplier: string; combinedMultiplier: string;
    };
  shareRate(genesisHeight: string, height: string): string;
  shareRateHbd(genesisHeight: string, height: string,
    lcReserve: string, hbdReserve: string): string;
  supplyLimits(snapshotTotal: string): {
    hardcap: string; emissionCap: string; maxEver: string; lost: string;
  };
  dailyRewards(genesisHeight: string, height: string): {
    total: string; proofOfBrain: string; lshare: string;
    liquidity: string; viral: string; deep: string;
  };
  poolApy(dailyLiquidity: string, lcReserve: string, totalShares: string, totalWeight: string): {
    ok: boolean; apy: string;
  };
  durationMultiplier(days: number): string;
  volumeMultiplier(principal: string, start: string, end: string): string;
  loyaltyMultiplier(ageDays: number): string;
  voteCost(weightPct: number): string;
  canPost(shares: string, threshold: string): boolean;
  voteWeight(shares: string, powerSpent: string): string;
  votePower(power: string, lastHeight: string, height: string, window: number): string;
  trancheView(
    shares: string, startHeight: string, weight: string, accStart: string, height: string,
    totalShares: string, lcReserve: string, hbdReserve: string,
    poolLiq: string, accSeen: string, accHeld: string, acc: string, totalWeight: string,
  ): { age_days: number; loyalty: string; value_lc: string; value_hbd: string; pending_reward: string };
  trancheHealth(lastTouch: string, height: string): {
    phase: number; daysUntilEvict: number; dormantDays: number;
  };
  routePayout(amount: string): { liquid: string; pending: string };
  blockSplit(amount: string): {
    proofOfBrain: string; lshare: string; liquidity: string;
    viral: string; deep: string;
  };
  entitlement(shares: string, accStart: string, accEnd: string): string;
  effectiveValue(paramKey: string, members: GovernanceRow[]): {
    ok: boolean; value: string; min: string; max: string; defaultValue: string;
  };
  consensusGroup(rows: GovernanceRow[]): { account: string; shares: string }[];
  swapOut(reserveIn: string, reserveOut: string, amountIn: string): {
    ok: boolean; amountOut: string; rate?: string; priceImpactPct?: string;
  };
  rewardShare(pool: string, userShares: string, totalShares: string): string;
  lcToHbd(amount: string, lcReserve: string, hbdReserve: string): string;
  liquidityQuote(lcIn: string, lcReserve: string, hbdReserve: string, totalShares: string): {
    ok: boolean; isFirstDeposit: boolean; hbdNeeded: string; shares: string;
  };
  withdrawQuote(shares: string, totalShares: string, lcReserve: string, hbdReserve: string): {
    ok: boolean; lc: string; hbd: string;
  };
  mintPreview(principal: string, shares: string, startHeight: string, days: number,
    goodAccounting: boolean, height: string, accruedYield: string): {
      toOwner: string; toRewardPool: string; early: boolean;
      maturityHeight: string; mature: boolean; canArm: boolean;
      recoveryFraction: string; bleedRemaining: string; liquidationHeight: string;
    };
  constants: EngineConstants;
}

/** Protocol constants, read from the engine so the UI never hardcodes a bound. */
export interface EngineConstants {
  decimals: number;
  unit: string;
  multScale: string;
  minMintDays: number;
  maxMintDays: number;
  minMintAmount: string;
  graceDays: number;
  bleedDays: number;
  goodAcctArmDays: number;
  goodAcctGrace: number;
  loyaltyMaxDays: number;
  /** Days the migration mint (legacy LASSECASH POWER) is locked for. */
  migrationMintDays: number;
  heightsPerDay: string;
  expiryChunkSize: number;
  maxRetirePerWalk: number;
  userRetireBudget: number;
  heightsPerYear: string;
  secondsPerHeight: number;
  viralPayoutDays: number;
  deepPayoutDays: number;
  fullVoteCostPct: number;
  /** Governable parameter keys. Never hardcode these; the registry owns them. */
  paramVolumeStart: string;
  paramVolumeEnd: string;
  paramPostThresholdViral: string;
  paramPostThresholdDeep: string;
  paramPostThresholdComment: string;
  paramPromoteMinBurn: string;
  /** Promotion closes once this % of a post's window has elapsed. */
  promoteCutoffPct: number;
}

/**
 * One `gov_board` account as the governance reader sees it: its live L-Shares
 * and its standing preference for the parameter being read.
 *
 * All three fields are RAW STATE, base-unit strings straight from
 * `getStateByKeys`. `preference` is absent — null, undefined or the empty
 * string a missing MAGI key reads back as — when that member has never voted.
 * Absent is not zero; the engine skips a non-voter rather than counting them.
 */
export interface GovernanceRow {
  account: string;
  shares: string;
  preference?: string | null;
}

/** A governable parameter's value in force, with the bounds no vote can leave. */
export interface EffectiveValue {
  /** False for an unregistered key — never read `value` in that case. */
  ok: boolean;
  value: Amount;
  min: Amount;
  max: Amount;
  /** The registered default, which stands until somebody votes. */
  defaultValue: Amount;
}

/** A seat in the consensus group, per `consensusGroup`. */
export interface ConsensusMember {
  account: string;
  shares: Amount;
}

export interface EngineMintQuote {
  ok: boolean;
  shares: Amount;
  durationMultiplier: Amount;
  volumeMultiplier: Amount;
  combinedMultiplier: Amount;
}

export interface SwapEstimate {
  ok: boolean;
  amountOut: Amount;
  rate: Amount;
  priceImpactPct: Amount;
}

export interface LiquidityEstimate {
  ok: boolean;
  isFirstDeposit: boolean;
  hbdNeeded: Amount;
  shares: Amount;
}

export interface MintPreview {
  toOwner: Amount;
  toRewardPool: Amount;
  early: boolean;
  mature: boolean;
  canArmGoodAccounting: boolean;
  recoveryFraction: Amount;
  bleedRemaining: Amount;
  maturityHeight: number;
  liquidationHeight: number;
}

/** Describes a mint well enough to preview closing it. */
export interface MintLike {
  principal: Amount;
  shares: Amount;
  start_height: number;
  days: number;
  good_accounting: boolean;
}

let bridge: Bridge | undefined;
let loading: Promise<void> | undefined;

/**
 * Load the engine. Idempotent and safe to call concurrently — the second caller
 * awaits the first load rather than instantiating a second copy.
 *
 * `wasmUrl` is fetched in the browser. `wasmBytes` lets a non-browser host
 * (tests, a Node script) supply the binary directly — the library deliberately
 * does NOT import `node:fs`, because a static Node import breaks browser
 * bundling and a dynamic one still trips up bundler resolution.
 */
export async function loadEngine(
  wasmUrl?: string,
  wasmBytes?: BufferSource,
): Promise<void> {
  if (bridge) return;
  if (loading) return loading;

  loading = (async () => {
    const g = globalThis as Record<string, any>;
    if (!g.Go) {
      throw new Error(
        "TinyGo's wasm_exec shim is not loaded. Import api/src/wasm/wasm_exec.cjs " +
        "before calling loadEngine().",
      );
    }
    const go = new g.Go();
    const url = wasmUrl ?? new URL("./wasm/engine.wasm", import.meta.url).href;

    let source: WebAssembly.WebAssemblyInstantiatedSource;
    if (wasmBytes) {
      source = await WebAssembly.instantiate(wasmBytes, go.importObject);
    } else {
      source = await WebAssembly.instantiateStreaming(fetch(url), go.importObject).catch(
        async () => {
          // Servers that mis-serve the WASM MIME type break streaming; fall
          // back to a plain fetch rather than failing outright.
          const buf = await fetch(url).then((r) => r.arrayBuffer());
          return WebAssembly.instantiate(buf, go.importObject);
        },
      );
    }

    // go.run resolves only when the program exits; ours blocks forever on
    // purpose so the exports stay callable. Do NOT await it.
    void go.run(source.instance);

    const b = (globalThis as Record<string, any>).__lassecashEngine as Bridge | undefined;
    if (!b) throw new Error("engine wasm loaded but exposed no bridge");
    bridge = b;
  })();

  try {
    await loading;
  } finally {
    loading = undefined;
  }
}

/** True once the engine is callable. */
export function engineReady(): boolean { return bridge !== undefined; }

function must(): Bridge {
  if (!bridge) throw new Error("engine not loaded — await loadEngine() first");
  return bridge;
}

/** Protocol constants straight from the engine. */
export function constants(): EngineConstants { return must().constants; }

const u = (s: string): Amount => fromUnits(BigInt(s));

// --- EXACT: pure functions of user input ---------------------------------

/**
 * L-Shares a mint would grant. EXACT — every input is supplied by the caller,
 * so nothing here can go stale.
 *
 * Amounts are base-unit strings; use `toBaseUnitArg` on user input.
 */
export function mintQuote(
  principalUnits: string, days: number, shareRateUnits: string,
  volumeStartUnits: string, volumeEndUnits: string,
): EngineMintQuote {
  const r = must().mintQuote(principalUnits, days, shareRateUnits,
    volumeStartUnits, volumeEndUnits);
  return {
    ok: r.ok,
    shares: u(r.shares),
    durationMultiplier: u(r.durationMultiplier),
    volumeMultiplier: u(r.volumeMultiplier),
    combinedMultiplier: u(r.combinedMultiplier),
  };
}

/**
 * A mint's accrued yield from its accumulator readings. EXACT — the readings
 * are chain state; the division is the engine's.
 */
export function entitlement(sharesUnits: string, accStart: string, accEnd: string): Amount {
  return u(must().entitlement(sharesUnits, accStart, accEnd));
}

/**
 * May an account holding `sharesUnits` L-Shares publish into a window whose
 * governed threshold is `thresholdUnits`? EXACT for the two figures passed.
 *
 * Both are BASE-UNIT strings, straight out of `shr_<account>` and
 * `effectiveValue`. The comparison itself lives in `engine.CanPost` — the same
 * function `contract/state/pob.go` calls before it will accept a post — so a
 * caller can never disagree with the chain about who is allowed to publish.
 * Re-read before acting on it: shares and the governed threshold both move.
 */
export function canPost(sharesUnits: string, thresholdUnits: string): boolean {
  return must().canPost(sharesUnits, thresholdUnits);
}

/**
 * The value in force for a governable parameter — the LOWER MEDIAN of the
 * top-10's standing preferences, each clamped into the parameter's hardcoded
 * bounds, falling back to the registered default when nobody has voted.
 *
 * EXACT for the rows you pass, in the same sense as `entitlement`: the median,
 * the clamping, the tie-broken ranking of the board and the default all happen
 * inside the engine — this is the identical code path the contract runs in
 * `EffectiveParam`. Re-read before signing, because governance and share
 * balances move.
 *
 * Pass every `gov_board` account, not a pre-selected ten: `shares` is what
 * decides who holds a seat, and selecting them outside the engine would mean
 * re-implementing its tie-break. Use `constants().paramVolumeStart` and
 * friends for `paramKey`.
 */
export function effectiveValue(paramKey: string, members: GovernanceRow[]): EffectiveValue {
  const r = must().effectiveValue(paramKey, members);
  return {
    ok: r.ok,
    value: u(r.value),
    min: u(r.min),
    max: u(r.max),
    defaultValue: u(r.defaultValue),
  };
}

/**
 * The top-10 L-Share holders, ranked exactly as `engine.ConsensusGroup` ranks
 * them on-chain: shares descending, ties broken by account ascending, holders
 * with zero shares dropped. This is the SAME ranking a foreign dApp contract
 * derives from the frozen public state ABI (`gov_board` + `shr_<account>`,
 * see CLAUDE.md's "Public state ABI") by calling the identical Go function —
 * nothing here re-sorts or re-slices the board.
 *
 * EXACT for the rows you pass: pass the whole board, not a pre-selected ten,
 * since `shares` is what decides who holds a seat. `preference` is accepted
 * but unused — `GovernanceRow` is shared with `effectiveValue` so a `gov_board`
 * read can feed both without reshaping.
 */
export function consensusGroup(rows: GovernanceRow[]): ConsensusMember[] {
  return must().consensusGroup(rows).map((m) => ({ account: m.account, shares: u(m.shares) }));
}

/** The upward-only 7%/yr share rate at a height. EXACT. */
export function shareRate(genesisHeight: number, height: number): Amount {
  return u(must().shareRate(String(genesisHeight), String(height)));
}

/**
 * The share rate converted to HBD at the pool's spot price. ESTIMATE — the
 * reserves move between reading and acting. Returns null while the pool is
 * unseeded (no reserves, no price).
 */
export function shareRateHbd(
  genesisHeight: number, height: number,
  lcReserveUnits: string, hbdReserveUnits: string,
): Amount | null {
  const v = must().shareRateHbd(
    String(genesisHeight), String(height), lcReserveUnits, hbdReserveUnits);
  return v === "" ? null : u(v);
}

/** The hardcap picture for a committed snapshot total. EXACT. */
export interface SupplyLimits {
  hardcap: Amount; emissionCap: Amount; maxEver: Amount;
  /** Issued on the old chains, held by nobody, mintable by no one. */
  lost: Amount;
}
export function supplyLimits(snapshotTotalUnits: string): SupplyLimits {
  const r = must().supplyLimits(snapshotTotalUnits);
  return { hardcap: u(r.hardcap), emissionCap: u(r.emissionCap), maxEver: u(r.maxEver), lost: u(r.lost) };
}

/** The day's emission at a height, split into pools. EXACT — closed-form. */
export interface DailyRewards {
  total: Amount; proofOfBrain: Amount; lshare: Amount;
  liquidity: Amount; viral: Amount; deep: Amount;
}
/**
 * ESTIMATE — day-one APY of a brand-new pool deposit, as a fraction
 * ("18.25000000" = 1825%). The emission numerator is exact; reserves and
 * total weight are live pool state and move as others deposit. Null when the
 * pool is empty. Formula lives in engine.PoolAPY — never recompute it here.
 */
export function poolApy(
  dailyLiquidity: Amount, lcReserve: Amount, totalShares: Amount, totalWeight: Amount,
): Amount | null {
  const r = must().poolApy(
    toBaseUnitArg(dailyLiquidity), toBaseUnitArg(lcReserve),
    toBaseUnitArg(totalShares), toBaseUnitArg(totalWeight));
  return r.ok ? u(r.apy) : null;
}

export function dailyRewards(genesisHeight: number, height: number): DailyRewards {
  const r = must().dailyRewards(String(genesisHeight), String(height));
  return {
    total: u(r.total), proofOfBrain: u(r.proofOfBrain), lshare: u(r.lshare),
    liquidity: u(r.liquidity), viral: u(r.viral), deep: u(r.deep),
  };
}

/** Longer Pays Better: 1.00x at 1 day, 1.50x at 1095. EXACT. */
export function durationMultiplier(days: number): Amount {
  return u(must().durationMultiplier(days));
}

/** Bigger Pays Better: 1.00x below start, 1.50x at end. EXACT. */
export function volumeMultiplier(
  principalUnits: string, startUnits: string, endUnits: string,
): Amount {
  return u(must().volumeMultiplier(principalUnits, startUnits, endUnits));
}

/** Liquidity loyalty: 1.00x fresh, 1.90x at 90 days. EXACT. */
export function loyaltyMultiplier(ageDays: number): Amount {
  return u(must().loyaltyMultiplier(ageDays));
}

/** Vote power a vote of this weight consumes. EXACT. */
export function voteCost(weightPct: number): Amount {
  return u(must().voteCost(weightPct));
}

/** Rshares a vote contributes. EXACT given shares and power spent. */
export function voteWeight(sharesUnits: string, powerSpentUnits: string): Amount {
  return u(must().voteWeight(sharesUnits, powerSpentUnits));
}

/**
 * Current vote power, regenerated to `height`. EXACT.
 * window: 0 = viral (7-day regen), 1 = deep (30-day regen).
 */
export function votePower(
  powerUnits: string, lastHeight: number, height: number, window: 0 | 1,
): Amount {
  return u(must().votePower(powerUnits, String(lastHeight), String(height), window));
}

/**
 * A liquidity tranche's live figures from raw chain state. EXACT for the
 * state passed in (the reserves move between read and render, as always).
 */
export function trancheView(t: {
  shares: string; startHeight: number; weight: string; accStart: string; height: number;
  totalShares: string; lcReserve: string; hbdReserve: string;
  poolLiq: string; accSeen: string; accHeld: string; acc: string; totalWeight: string;
}): { age_days: number; loyalty: Amount; value_lc: Amount; value_hbd: Amount; pending_reward: Amount } {
  const r = must().trancheView(
    t.shares, String(t.startHeight), t.weight, t.accStart, String(t.height),
    t.totalShares, t.lcReserve, t.hbdReserve, t.poolLiq, t.accSeen, t.accHeld, t.acc, t.totalWeight,
  );
  return {
    age_days: r.age_days, loyalty: u(r.loyalty), value_lc: u(r.value_lc),
    value_hbd: u(r.value_hbd), pending_reward: u(r.pending_reward),
  };
}

/**
 * The dormancy clock for a liquidity tranche. EXACT — a pure function of the
 * tranche's last-claim height and the current chain height, so it can never be
 * stale the way a pool-state figure can.
 *
 * phase: 0 healthy, 1 warning (final 90 days), 2 evictable.
 *
 * Eviction is NOT a loss: it closes the position and returns the owner's
 * LASSECASH and HBD to them whole. What a dormant provider forfeits is future
 * rewards they were not present to claim, and the loyalty age they had built —
 * which is why the warning period is as long as the climb back.
 */
export function trancheHealth(
  lastTouch: number, height: number,
): { phase: 0 | 1 | 2; daysUntilEvict: number; dormantDays: number } {
  const r = must().trancheHealth(String(lastTouch), String(height));
  return {
    phase: r.phase as 0 | 1 | 2,
    daysUntilEvict: r.daysUntilEvict,
    dormantDays: r.dormantDays,
  };
}

/** The 20% liquid / 80% pending split on a Proof-of-Brain reward. EXACT. */
export function routePayout(amountUnits: string): { liquid: Amount; pending: Amount } {
  const r = must().routePayout(amountUnits);
  return { liquid: u(r.liquid), pending: u(r.pending) };
}

/** 50/25/25 block split, with Proof-of-Brain further split 25/75. EXACT. */
export function blockSplit(amountUnits: string): {
  proofOfBrain: Amount; lshare: Amount; liquidity: Amount;
  viral: Amount; deep: Amount;
} {
  const r = must().blockSplit(amountUnits);
  return {
    proofOfBrain: u(r.proofOfBrain), lshare: u(r.lshare),
    liquidity: u(r.liquidity), viral: u(r.viral), deep: u(r.deep),
  };
}

// --- ESTIMATE: functions of live pool state -------------------------------

/**
 * Swap output. **ESTIMATE** — reserves move between preview and broadcast.
 * Label it in the UI and always submit with a `minOut` below this figure.
 *
 * There is no fee argument. The LASSECASH:HBD swap fee is hardcoded to zero
 * and is not governable, so the full input always enters the curve.
 */
export function estimateSwap(
  reserveInUnits: string, reserveOutUnits: string,
  amountInUnits: string,
): SwapEstimate {
  const r = must().swapOut(reserveInUnits, reserveOutUnits, amountInUnits);
  return {
    ok: r.ok,
    amountOut: u(r.amountOut),
    rate: r.rate ? u(r.rate) : "0.00000000",
    priceImpactPct: r.priceImpactPct ? u(r.priceImpactPct) : "0.00000000",
  };
}

/**
 * An account's slice of a reward pool. **ESTIMATE** — the pool grows every
 * block and total shares move as others mint.
 */
export function estimateRewardShare(
  poolUnits: string, userSharesUnits: string, totalSharesUnits: string,
): Amount {
  return u(must().rewardShare(poolUnits, userSharesUnits, totalSharesUnits));
}

/**
 * A LASSECASH amount at the pool's spot price. **ESTIMATE** — the reserves move
 * between reading and acting.
 *
 * Returns null while the pool is UNSEEDED: there is no price yet, and showing
 * "≈ 0.000 HBD" would read as "worthless" rather than "not known". Callers
 * should hide the figure entirely in that case.
 *
 * The division happens in Go (`engine.LcToHbd`). Do not be tempted to do it
 * here — a price conversion is money math, and money math has exactly one
 * implementation.
 */
export function lcToHbd(
  amountUnits: string, lcReserveUnits: string, hbdReserveUnits: string,
): Amount | null {
  const v = must().lcToHbd(amountUnits, lcReserveUnits, hbdReserveUnits);
  return v === "" ? null : u(v);
}

/** HBD required and shares earned for a deposit. **ESTIMATE**. */
export function estimateLiquidity(
  lcInUnits: string, lcReserveUnits: string,
  hbdReserveUnits: string, totalSharesUnits: string,
): LiquidityEstimate {
  const r = must().liquidityQuote(lcInUnits, lcReserveUnits, hbdReserveUnits, totalSharesUnits);
  return {
    ok: r.ok, isFirstDeposit: r.isFirstDeposit,
    hbdNeeded: u(r.hbdNeeded), shares: u(r.shares),
  };
}

/**
 * What closing a tranche of this size pays — an **ESTIMATE**, because it is a
 * function of reserves that move.
 *
 * The counterpart to `estimateLiquidity`, and the chart is why it exists: a
 * `remove_liquidity` call carries only a tranche id, so replaying the pool's
 * history means computing the tranche's proportional share of the reserves at
 * that moment. That division is money math, so it lives in Go.
 */
export function estimateWithdraw(
  sharesUnits: string, totalSharesUnits: string,
  lcReserveUnits: string, hbdReserveUnits: string,
): { ok: boolean; lc: string; hbd: string } {
  const r = must().withdrawQuote(sharesUnits, totalSharesUnits, lcReserveUnits, hbdReserveUnits);
  return { ok: r.ok, lc: u(r.lc), hbd: u(r.hbd) };
}

/**
 * What closing a mint right now would pay.
 *
 * The early-end curve and the bleed are EXACT; the figure is an **ESTIMATE**
 * only because `accruedYield` depends on the live pool. Show
 * `toRewardPool` alongside `toOwner` — a user ending early must see what they
 * are giving up before they sign.
 */
export function previewMintClose(
  mint: MintLike, height: number, accruedYieldUnits: string,
): MintPreview {
  const r = must().mintPreview(
    toUnits(mint.principal).toString(),
    toUnits(mint.shares).toString(),
    String(mint.start_height),
    mint.days,
    mint.good_accounting,
    String(height),
    accruedYieldUnits,
  );
  return {
    toOwner: u(r.toOwner),
    toRewardPool: u(r.toRewardPool),
    early: r.early,
    mature: r.mature,
    canArmGoodAccounting: r.canArm,
    recoveryFraction: u(r.recoveryFraction),
    bleedRemaining: u(r.bleedRemaining),
    maturityHeight: Number(r.maturityHeight),
    liquidationHeight: Number(r.liquidationHeight),
  };
}

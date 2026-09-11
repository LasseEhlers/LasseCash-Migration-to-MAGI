/**
 * The NATIVE LASSECASH/HBD pool — MAGI's own DEX contract, deployed by us.
 *
 * `vsc1BrBFAwZ3Mr8L4ijRqT9RPEPvhK9FWDaYSr`, vsc-eco's `dex` contract byte for
 * byte (code CID `bafkreiezp5u4…`), owner `hive:lassecashdapps`, initialised
 * and seeded 2026-09-09. Verified against the chain the same day: the only
 * other DEX contracts in existence are the router and two pools, all three
 * owned by `hive:vsc.dao` — so this is the first pool on MAGI deployed by
 * anyone outside the team.
 *
 * ⚠️ IT CANNOT TRADE UNTIL MAGI'S WITNESSES WHITELIST IT. The node's fee
 * module (`incentive-pendulum`) checks the calling contract against
 * `pendulumPoolWhitelist` in the node's own system config — today exactly the
 * two DAO pools — and refuses everything else with `contract not whitelisted`.
 * That is a node release adopted by witnesses, not a call anyone can make
 * on-chain. `add_liquidity` and `remove_liquidity` never reach the fee module,
 * which is why the pool could be seeded (and can be emptied) regardless.
 *
 * UNITS, and they differ from the core pool: HBD is MILLI here (the SDK's
 * unit), LASSECASH is 1e8. The core contract keeps both at 1e8 internally.
 *
 * NO ECONOMICS LIVE HERE. A swap's output is computed by the node's fee
 * module — protocol leg times a stabiliser multiplier, a slip leg, a 1% clamp,
 * a 25% network cut — none of which is in our engine and none of which may be
 * reimplemented in TypeScript. So a quote is a `simulateContractCalls` round
 * trip: the chain's own answer to the exact swap. The one derived number here
 * is the marginal price, the ratio of the two reserves, the same single
 * division `market.ts` allows itself for the ticker.
 */

export const NATIVE_POOL_ID = "vsc1BrBFAwZ3Mr8L4ijRqT9RPEPvhK9FWDaYSr";

/** Simulation is unsigned and free, so a quote may be taken as any account.
 *  This one is used when nobody is signed in, because it holds both sides. */
const PROBE_ACCOUNT = "hive:lasseehlers";

export interface NativePoolState {
  /** HBD side, in MILLI-HBD as the pool stores it. */
  reserveHbdMilli: bigint;
  /** LASSECASH side, 1e8. */
  reserveLc: bigint;
  feeBps: number;
  totalLp: bigint;
}

export type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/**
 * The pool's own report of itself — reserves, fee, LP supply.
 *
 * ⚠️ The contract stores these as raw big-endian BYTES. A plain
 * `getStateByKeys` returns them as text and replaces every byte that is not
 * valid UTF-8 with U+FFFD, so `r0` comes back as "&\uFFFD" and is ruined —
 * the same trap the token ledger sprang on 2026-09-08.
 *
 * The fix is one parameter: **`encoding: "hex"`**. Found 2026-09-11 by
 * reading how Altera queries the DAO's own pools, after a week of assuming
 * the bytes were simply unreachable through GraphQL and routing everything
 * through `simulateContractCalls`. Hex is cheaper, needs no caller identity,
 * and answers for signed-out visitors and crawlers.
 */
export async function readNativePool(q: Gql, _account?: string | null): Promise<NativePoolState | null> {
  const d = await q<{ getStateByKeys: Record<string, string | null> | null }>(
    'query($c: String!, $k: [String!]!) { getStateByKeys(contractId: $c, keys: $k, encoding: "hex") }',
    { c: NATIVE_POOL_ID, k: ["r0", "r1", "tlp", "fee", "a0n"] },
  );
  const st = d.getStateByKeys;
  if (!st) return null;
  const big = (v: string | null | undefined) => {
    const h = (v ?? "").trim();
    return /^[0-9a-f]*$/i.test(h) && h.length ? BigInt("0x" + h) : 0n;
  };
  // Assets are normalised alphabetically, so hbd is asset0 for this pair —
  // but read the stored name rather than trusting the order.
  const a0 = Buffer.from((st["a0n"] ?? ""), "hex").toString("utf8").toLowerCase();
  const hbdIsFirst = a0 === "" || a0 === "hbd";
  return {
    reserveHbdMilli: big(hbdIsFirst ? st["r0"] : st["r1"]),
    reserveLc: big(hbdIsFirst ? st["r1"] : st["r0"]),
    feeBps: Number(big(st["fee"])) || 8,
    totalLp: big(st["tlp"]),
  };
}

/** Simulation needs a fully-qualified caller; any account answers a read. */
function qualify(account?: string | null): string {
  if (!account) return PROBE_ACCOUNT;
  return account.startsWith("hive:") || account.includes(":") ? account : `hive:${account}`;
}

/**
 * HBD per LASSECASH, as a decimal string with 8 places — the marginal price a
 * constant-product pool quotes at size zero, and the same definition the Pool
 * page's PRICE tile uses. Milli on one side, 1e8 on the other, hence the 1e5.
 */
export function nativePrice(p: NativePoolState): string | null {
  if (p.reserveLc === 0n || p.reserveHbdMilli === 0n) return null;
  const scaled = (p.reserveHbdMilli * 100_000n * 100_000_000n) / p.reserveLc;
  const s = scaled.toString().padStart(9, "0");
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
}

export interface NativeQuote {
  ok: boolean;
  /** Base units of the OUTPUT asset: milli for HBD, 1e8 for LASSECASH. */
  amountOut: bigint;
  /** False when the node refused because the pool is not on its whitelist. */
  whitelisted: boolean;
  msg: string;
}

/**
 * What the chain says this swap would pay, without broadcasting.
 *
 * The LASSECASH side is drawn through the token's `transferFrom`, so the
 * allowance has to exist for the simulation to be truthful — it is granted in
 * the same simulated transaction, exactly as the real broadcast does it. The
 * HBD side needs its `transfer.allow` intent for the same reason. rc_limit
 * stays modest on purpose: an HBD-drawing call reserves its requested limit
 * out of the HBD balance before the draw is checked, so a fat probe would
 * refuse a swap the chain would accept.
 */
export async function quoteNativeSwap(
  q: Gql,
  account: string | null,
  direction: "lc_hbd" | "hbd_lc",
  amountIn: bigint,
  tokenContractId: string,
): Promise<NativeQuote> {
  const who = qualify(account);
  if (amountIn <= 0n) return { ok: false, amountOut: 0n, whitelisted: true, msg: "" };

  const swapCall = {
    contract_id: NATIVE_POOL_ID,
    action: "swap",
    payload: JSON.stringify(
      direction === "lc_hbd"
        ? { asset_in: "lassecash", amount_in: amountIn.toString(), asset_out: "hbd", to: who }
        : { asset_in: "hbd", amount_in: amountIn.toString(), asset_out: "lassecash", to: who },
    ),
    rc_limit: 4000,
    intents:
      direction === "hbd_lc"
        ? [{ type: "transfer.allow", args: { token: "hbd", limit: milliToHbd(amountIn) } }]
        : [],
  };
  const calls =
    direction === "lc_hbd"
      ? [
          {
            contract_id: tokenContractId,
            action: "increaseAllowance",
            payload: JSON.stringify({ spender: `contract:${NATIVE_POOL_ID}`, amount: amountIn.toString() }),
            rc_limit: 1500,
            intents: [],
          },
          swapCall,
        ]
      : [swapCall];

  const d = await q<{ simulateContractCalls: { success: boolean; err_msg: string | null; ret: string | null }[] | null }>(
    "query($i: SimulateContractCallsInput!) { simulateContractCalls(input: $i) { success err_msg ret } }",
    { i: { tx_id: "native-quote", required_auths: who, calls } },
  );
  const rows = d.simulateContractCalls ?? [];
  const res = rows[rows.length - 1];
  if (!res) return { ok: false, amountOut: 0n, whitelisted: true, msg: "no answer from the node" };
  if (!res.success) {
    const msg = res.err_msg ?? "refused";
    return { ok: false, amountOut: 0n, whitelisted: !/not whitelisted/i.test(msg), msg };
  }
  try {
    const out = JSON.parse(res.ret ?? "{}") as { amount_out?: string };
    return { ok: true, amountOut: BigInt(out.amount_out ?? "0"), whitelisted: true, msg: "" };
  } catch {
    return { ok: false, amountOut: 0n, whitelisted: true, msg: "unreadable answer" };
  }
}

/** Milli-HBD -> the "1.234" string an intent's limit must carry. */
export function milliToHbd(milli: bigint): string {
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, "0");
  return `${whole}.${frac}`;
}

/** 1e8 base units -> milli, rounding UP so an intent can never be short. */
export function unitsToMilli(units: bigint): bigint {
  return (units + 99_999n) / 100_000n;
}

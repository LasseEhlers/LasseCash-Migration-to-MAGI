/**
 * A contract call, in words.
 *
 * PRESENTATION ONLY. This reads the pipe-delimited payload the chain already
 * recorded and formats it — it derives no value, checks no rule and decides
 * nothing. `Result.Msg` and raw payloads carry BASE UNITS by design (see
 * CLAUDE.md: formatting on-chain would cost binary size and gas), which is
 * exactly why the frontend must not show them verbatim: "15000000000" is a
 * number nobody can read and half the people who try will read it wrong.
 *
 * UNKNOWN CALLS FALL BACK TO THE RAW PAYLOAD rather than to a guess. A wrong
 * description of what someone signed is worse than an unfriendly one.
 */
import { ASSET_SCALE, fromUnits, unitsToDecimal } from "$api/index.js";
import { displayName, lc } from "./format.js";

/** Base-unit string -> "1,234.567". Empty for anything unparseable. */
function amt(raw: string | undefined, dp = 3): string {
  if (!raw) return "";
  try { return lc(fromUnits(BigInt(raw)), dp); } catch { return raw ?? ""; }
}

/**
 * One of MAGI's own amounts, formatted at that asset's scale.
 *
 * Their pools speak base units per asset: HBD and HIVE in milli, BTC in
 * satoshis. Ours speak 1e8. The two must never be formatted by the same
 * helper, which is why this one exists beside `amt` rather than replacing it.
 */
function magiAmount(raw: string | undefined, asset: string): string {
  if (!raw) return "";
  try {
    const scale = ASSET_SCALE[asset] ?? 1_000n;
    return unitsToDecimal(BigInt(raw), scale);
  } catch {
    return raw;
  }
}

/** `hive:alice` -> `@alice`, and a bare name is left alone. */
function who(raw: string | undefined): string {
  return raw ? displayName(raw) : "";
}

/** `author|permlink` -> `@author/permlink`, shortened for a table cell. */
function post(author?: string, permlink?: string): string {
  if (!author) return "";
  return permlink ? `${who(author)}/${permlink}` : who(author);
}

const WINDOW = ["viral", "deep"];
const MODE = ["split 20/80", "all minted", "burned"];

/**
 * The governed parameters, for reading a `set_param` row back in words.
 *
 * A `set_param` is a top-ten seat's standing VOTE — the value in force is the
 * median of all ten — so the row reads as "voted: <what> <value>", not as if
 * the caller changed the rule single-handed. Values are 1e8 base units like
 * every amount; each entry names its unit. An unknown key falls back to the
 * raw payload — the frozen contract can never gain one, so that path only
 * fires on a call the chain refused anyway.
 */
const PARAMS: Record<string, { what: string; unit: string }> = {
  "mint.volume_start":      { what: "the mint-size bonus should start rising at",     unit: "LASSECASH" },
  "mint.volume_end":        { what: "the full 1.50x mint-size bonus should start at", unit: "LASSECASH" },
  "post.threshold_viral":   { what: "the viral posting threshold should be",          unit: "L-Shares" },
  "post.threshold_deep":    { what: "the deep posting threshold should be",           unit: "L-Shares" },
  "post.threshold_comment": { what: "the comment threshold should be",                unit: "L-Shares" },
  "promote.min_burn":       { what: "promoting a post should cost at least",          unit: "LASSECASH" },
};

export function describeCall(action: string, payload: string): string {
  const f = payload.split("|");

  // Rows the account did NOT sign — money arriving. Marked with a leading "+"
  // by the backend, because "you received" and "you sent" are the same call
  // seen from opposite ends and the list is useless if it cannot tell them
  // apart.
  if (action === "+transfer") return `${amt(f[1])} LASSECASH from ${who(f[2]) || "another account"}`;
  if (action === "+ledger" || action === "ledger") {
    const [from, to, amount, asset] = f;
    const unit = (asset ?? "").toUpperCase();
    return action === "+ledger"
      ? `${amount} ${unit} from ${who(from)}`
      : `${amount} ${unit} to ${who(to)}`;
  }

  switch (action) {
    // Field 2 is the memo — ignored by the contract, permanent in the payload.
    case "transfer":     return `${amt(f[1])} LASSECASH to ${who(f[0])}`
                                + (f[2] ? ` — "${f[2]}"` : "");
    case "burn":         return `${amt(f[0])} LASSECASH burned`;
    case "mint":         return `${amt(f[0])} LASSECASH locked for ${f[1]} days`;
    case "claim_mint":   return `closed mint #${f[0]}`;
    case "sweep_mint":   return `swept ${who(f[0])}'s dead mint #${f[1]}`;
    case "good_accounting": return `armed Good Accounting on mint #${f[0]}`;
    case "set_duration": return `monthly Proof-of-Brain mint set to ${f[0]} days`;

    // Both sides quote a MINIMUM out: the floor you accepted, not the fill.
    case "swap_lc_hbd":  return `sold ${amt(f[0])} LASSECASH · at least ${amt(f[1], 6)} HBD`;
    case "swap_hbd_lc":  return `bought with ${amt(f[0], 6)} HBD · at least ${amt(f[1])} LASSECASH`;
    case "add_liquidity":    return `added ${amt(f[0])} LASSECASH + ${amt(f[1], 6)} HBD`;
    case "remove_liquidity": return `withdrew tranche #${f[0]}`;
    case "claim_pool":       return `claimed rewards on tranche #${f[0]}`;
    case "sweep_tranche":    return `evicted ${who(f[0])}'s dormant tranche #${f[1]}`;

    case "post":    return `${f[0]} · ${WINDOW[Number(f[1])] ?? "?"} · ${MODE[Number(f[2])] ?? "?"}`;
    case "comment": return `replied to ${post(f[1], f[2])}`;
    // Weight 0 is the unvote — "voted 0%" would read as a vote that counts.
    // Post or comment: the payload does not say, but every reply permlink
    // this site (and every Hive frontend) generates starts with "re-".
    case "vote": {
      const kind = (f[1] ?? "").startsWith("re-") ? "comment" : "post";
      return f[2] === "0"
        ? `removed vote on ${kind}: ${post(f[0], f[1])}`
        : `voted ${f[2]}% on ${kind}: ${post(f[0], f[1])}`;
    }
    case "payout":  return `settled ${post(f[0], f[1])}`;
    case "promote_post": return `${amt(f[2])} LASSECASH burned to promote ${post(f[0], f[1])}`;
    case "claim_curation": return `claimed curation on ${post(f[0], f[1])}`;
    case "sweep_curation": return `swept expired curation on ${post(f[0], f[1])}`;

    case "claim_migration": return `claimed ${amt(f[0])} LASSECASH liquid + ${amt(f[1])} as a mint`;
    case "record_burn":     return `recorded ${who(f[0])}'s burn`;
    case "settle":          return "settled this account";
    case "settle_pending":  return "settled pending rewards";
    case "advance":         return f[0] ? `advanced the accrual by ${f[0]} days` : "advanced the accrual";
    case "promote":         return `offered ${who(f[0])} a board seat`;
    case "set_param": {
      const p = PARAMS[f[0] ?? ""];
      return p
        ? `voted: ${p.what} ${amt(f[1], 0)} ${p.unit}`
        : `${f[0]} preference set to ${f[1]}`;
    }
  }

  // MAGI's own operations (its native pools, its bridge) are JSON, not our
  // pipe format. Summarise the shape we can recognise; never invent one.
  if (payload.startsWith("{")) {
    try {
      const j = JSON.parse(payload) as Record<string, string>;
      if (j.type === "swap" && j.asset_in && j.asset_out) {
        // MAGI's amounts are BASE UNITS in each asset's own scale — HBD and
        // HIVE in milli, BTC in satoshis — so "1000" is one HBD, not a
        // thousand. Printing it raw read as a 1000x overstatement of what the
        // user had just signed.
        const inAmt = magiAmount(j.amount_in, j.asset_in);
        const floor = magiAmount(j.min_amount_out, j.asset_out);
        const tail = floor ? ` · at least ${floor} ${j.asset_out}` : ` for ${j.asset_out}`;
        return `swapped ${inAmt} ${j.asset_in}${tail}`;
      }
      if (j.type === "deposit" && j.asset0 && j.asset1) {
        return `added ${magiAmount(j.amount0, j.asset0)} ${j.asset0} + ${magiAmount(j.amount1, j.asset1)} ${j.asset1}`;
      }
      if (j.type) return String(j.type);
    } catch { /* not JSON after all: fall through */ }
  }
  return payload;
}

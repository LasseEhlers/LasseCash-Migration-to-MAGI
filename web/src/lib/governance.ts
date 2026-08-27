/**
 * Reading the governed parameters.
 *
 * NOTHING HERE DECIDES ANYTHING. It fetches the raw `gov_board` rows and hands
 * them to the engine, which ranks the top ten, clamps every preference into the
 * parameter's hardcoded bounds and takes the lower median — the identical code
 * path `contract/state/governance.go EffectiveParam` runs on-chain, and the
 * identical read a foreign dApp contract makes against the frozen public ABI.
 *
 * The labels are the only thing this file owns, and labels are presentation.
 *
 * ⚠️ THE BOUNDS COME FROM THE ENGINE, never from a literal here. They are
 * hardcoded in the contract precisely so they are un-negotiable; a copy in
 * TypeScript would be a second, mutable claim about what is un-negotiable.
 */
import {
  consensusGroup, constants, effectiveValue,
  type ConsensusMember, type EffectiveValue, type GovernanceMember,
} from "$api/index.js";
import { client } from "$lib/chain.svelte.js";

/** How a parameter's value should be read by a human. */
export type ParamUnit = "shares" | "lassecash";

export interface ParamMeta {
  key: string;
  label: string;
  /** One sentence: what moving this actually does. */
  what: string;
  unit: ParamUnit;
}

/**
 * The governable parameters, in the order they are shown.
 *
 * KEYS COME FROM `constants()`, not from strings typed here — the registry owns
 * them, and a typo would silently produce a parameter the chain has never heard
 * of. This list is closed: the core contract's code is frozen at the key burn,
 * so it can only ever read the keys it already reads (CLAUDE.md, "the registry
 * is NOT a general extension point").
 */
export function governableParams(): ParamMeta[] {
  const c = constants();
  return [
    {
      key: c.paramVolumeStart,
      label: "Bigger Pays Better — start",
      what: "The mint size at which the volume bonus begins to rise above 1.00x.",
      unit: "lassecash",
    },
    {
      key: c.paramVolumeEnd,
      label: "Bigger Pays Better — end",
      what: "The mint size that earns the full 1.50x volume bonus. The 1.50x ceiling itself is hardcoded.",
      unit: "lassecash",
    },
    {
      key: c.paramPostThresholdViral,
      label: "Posting threshold — viral",
      what: "L-Shares required to register a 7-day viral post.",
      unit: "shares",
    },
    {
      key: c.paramPostThresholdDeep,
      label: "Posting threshold — deep",
      what: "L-Shares required to register a 30-day deep post.",
      unit: "shares",
    },
    {
      key: c.paramPostThresholdComment,
      label: "Comment threshold",
      what: "L-Shares required to register a reply. This is what keeps tip bots and “nice post!” off LasseCash.",
      unit: "shares",
    },
    {
      key: c.paramPromoteMinBurn,
      label: "Promotion — minimum burn",
      what: "The smallest burn that buys a promoted slot. The ceiling is on the MINIMUM, so captured seats cannot price everyone else out of promoting.",
      unit: "lassecash",
    },
  ];
}

/** The board, the ten seats it resolves to, and what is in force. */
export interface GovernanceView {
  /** Every `gov_board` candidate — up to 20, not a pre-selected ten. */
  rows: GovernanceMember[];
  /** The ten seats, ranked by the engine: shares desc, ties by name asc. */
  seats: ConsensusMember[];
  /** paramKey -> value in force, with the bounds no vote can leave. */
  values: Map<string, EffectiveValue>;
}

/**
 * Read the board and resolve every requested parameter.
 *
 * One backend round-trip for all of them: the rows carry every preference, so
 * asking for six parameters costs the same as asking for one.
 */
export async function readGovernance(keys: string[]): Promise<GovernanceView> {
  const rows = await client.governance(keys);
  // `shares` decides who holds a seat, so the WHOLE board goes to the engine —
  // pre-selecting ten here would mean re-implementing its tie-break.
  const seats = consensusGroup(
    rows.map((r) => ({ account: r.account, shares: r.shares })),
  );
  const values = new Map<string, EffectiveValue>();
  for (const key of keys) {
    values.set(
      key,
      effectiveValue(
        key,
        rows.map((r) => ({
          account: r.account,
          shares: r.shares,
          preference: r.preferences[key] ?? null,
        })),
      ),
    );
  }
  return { rows, seats, values };
}

/**
 * The value in force for ONE parameter — the shorthand a preflight wants.
 *
 * Returns null when the chain cannot be read or the key is not registered.
 * Callers must treat null as "do not know" and refuse to preflight, never as
 * "no threshold".
 */
export async function readGovernedValue(key: string): Promise<EffectiveValue | null> {
  try {
    const v = (await readGovernance([key])).values.get(key);
    return v?.ok ? v : null;
  } catch {
    return null;
  }
}

/**
 * The shapes the frontend consumes.
 *
 * Every field here was computed on-chain. If you find yourself wanting to add a
 * field the backend does not already provide, the fix is a backend quote
 * endpoint — not a calculation in TypeScript. See CLAUDE.md, golden rule.
 */
import type { Amount } from "./amount.js";

/** Content windows. Viral pays in 7 days, Deep in 30. */
export const Window = { Viral: 0, Deep: 1 } as const;
export type Window = (typeof Window)[keyof typeof Window];

/** Global chain position. */
export interface ChainInfo {
  height: number;
  timestamp: string;
  epoch: number;
  genesis_height: number;
  settled_height: number;
  migrated_supply: Amount;
  /** Burned + claimable as committed at genesis; the hardcap figure. */
  snapshot_total: Amount;
  /** The burn half of the snapshot, fixed at genesis. NOT the same as
   *  total_burned, which also carries every burn since. */
  snapshot_burned: Amount;
  total_emitted: Amount;
  total_burned: Amount;
  total_shares: Amount;
  pool_lshare: Amount;
  pool_viral: Amount;
  pool_deep: Amount;
  pool_liquidity: Amount;
  amm_lc: Amount;
  amm_hbd: Amount;
  amm_shares: Amount;
  /** Total loyalty-weighted shares across all open tranches. */
  amm_weight: Amount;
  consensus_group: string[];
}

/** One time-lock position, with every displayed figure precomputed. */
export interface MintView {
  id: number;
  principal: Amount;
  shares: Amount;
  start_height: number;
  days: number;
  maturity_height: number;
  maturity_time: string;
  mature: boolean;
  good_accounting: boolean;
  can_arm_good_accounting: boolean;
  ended: boolean;
  pending_yield: Amount;
  /** What the owner receives if they claim right now. Engine-computed. */
  if_claimed_now: Amount;
  /** What would be slashed or bled away if they claimed right now. */
  slashed_if_claimed_now: Amount;
  /** Fraction of value surviving the post-maturity bleed, 1.0 = untouched. */
  bleed_remaining_pct: Amount;
}

/** One liquidity position. */
export interface TrancheView {
  id: number;
  shares: Amount;
  start_height: number;
  age_days: number;
  /** 1.00 fresh, rising to 1.90 at 90 days. */
  loyalty_multiplier: Amount;
  weight: Amount;
  closed: boolean;
  value_lc: Amount;
  value_hbd: Amount;
  /** What "Claim rewards" would pay right now. Engine-computed. */
  pending_reward: Amount;
  /**
   * Height of the last proof of life (deposit, or the last claim/withdraw
   * that touched this tranche) — the anti-zombie clock's zero point. Feed
   * this straight into `engine.trancheHealth(shares, last_touch, height)`;
   * it is a pure function of these two heights, so the frontend computes it
   * itself rather than waiting on a re-fetch.
   */
  last_touch: number;
}

/** Everything shown for one account. */
export interface AccountView {
  account: string;
  balance: Amount;
  shares: Amount;
  pending: Amount;
  /**
   * Curation claims queued for automatic settlement on the 1st.
   * Informational — the user never has to act on it.
   */
  pending_curation: number;
  mint_duration_days: number;
  hbd: number;
  vote_power: { viral: Amount; deep: Amount };
  mints: MintView[];
  tranches: TrancheView[];
  is_consensus_member: boolean;
}

/** One post, with its payout position already worked out on the backend. */
export interface PostView {
  author: string;
  permlink: string;
  window: "viral" | "deep";
  created_height: number;
  created_time: string;
  payout_height: number;
  payout_time: string;
  rshares: string;
  /** 0 = 20/80 split, 1 = 100% to the monthly mint, 2 = burned. Author only. */
  payout_mode: number;
  /** Set when this is a COMMENT (a registered reply); empty for a root post. */
  parent_author: string;
  parent_permlink: string;
  /** Total LASSECASH burned to promote this post — buys a labelled slot. */
  promoted: Amount;
  title: string;
  summary: string;
  /** The opening of the article — enough for a cover image and a preview. */
  body_excerpt: string;
  tags: string[] | null;
  votes: number;
  paid_out: boolean;
  /** True once the window has closed and anyone may trigger the payout. */
  payable: boolean;
  /** What the post would earn if it paid out right now. Engine-computed. */
  pending_payout: Amount;
  curator_pot: Amount;
  /** Height at which an unclaimed curator pot may be recycled. 0 until paid out. */
  curation_expires_at: number;
  /**
   * False for a post that exists on Hive under the `lassecash` tag but that
   * nobody has voted on yet.
   *
   * A tagged post whose AUTHOR clears the viral posting threshold is SHOWN here
   * before anyone registers it — that is the whole point of the tag — but it
   * has no contract record, so every economic field above is a zero rather than
   * a reading. The FIRST VOTE registers it (the contract's `vote` entrypoint
   * calls `registerForAuthor` on an unknown author|permlink), and from that
   * moment it is an ordinary viral post. Until then it earns nothing, and the
   * UI must say so instead of showing a 0.00000000 payout as if it were a
   * fact about the chain.
   */
  registered: boolean;
}

/**
 * A post's CONTENT metadata — everything except the money.
 *
 * Exists so that server rendering (canonical pages, the sitemap, RSS,
 * /llms.txt) can list posts without loading the economic engine. `PostView` is
 * the full picture and needs the engine for its payout figures; this is the
 * half that is safe to compute anywhere and safe to cache, because none of it
 * changes after the post is written.
 */
export interface PostMeta {
  author: string;
  permlink: string;
  window: "viral" | "deep";
  created_height: number;
  created_time: string;
  /** From the content layer; empty when only the registration is known. */
  title: string;
  summary: string;
  /** The opening of the article — enough to derive a cover image. */
  body_excerpt: string;
  tags: string[] | null;
  /** False for a Hive post under the `lassecash` tag with no contract record. */
  registered: boolean;
}

/**
 * One voter's recorded weight on a post.
 *
 * `rshares` is the raw 1e8-scaled vote weight the contract stored — a STRING,
 * because a popular post's total leaves JavaScript's safe integer range. It is
 * NOT a LASSECASH amount and must never be rendered as one.
 *
 * ⚠️ The record is DELETED when its curator is paid, so a settled post lists
 * fewer voters than its `votes` counter. That is the chain's own bookkeeping,
 * not a gap in this list — say so in the UI rather than papering over it.
 */
export interface PostVote {
  voter: string;
  rshares: string;
}

/** Result of submitting a transaction. */
export interface TxResult {
  ok: boolean;
  /** Diagnostic. Contains RAW BASE UNITS — never render this to a user. */
  msg: string;
  height: number;
  /**
   * Set by wallet signers: the Hive L1 transaction id. On MAGI, `ok` only
   * means Hive ACCEPTED the custom_json — the contract runs it 30–90 s later
   * and may refuse. `Backend.txStatus(txId)` reads the real verdict.
   */
  txId?: string | undefined;
}

/** The chain's verdict on a broadcast transaction. */
export interface TxStatus {
  status: "PENDING" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  /** Error text for FAILED, when the node exposes it. */
  error?: string | undefined;
}

export interface SwapQuote {
  amount_in: Amount;
  amount_out: Amount;
  rate: Amount;
  price_impact_pct: Amount;
  reserve_in: Amount;
  reserve_out: Amount;
  ok: boolean;
  msg: string;
}

export interface MintQuote {
  principal: Amount;
  days: number;
  shares: Amount;
  share_rate: Amount;
  duration_multiplier: Amount;
  volume_multiplier: Amount;
  combined_multiplier: Amount;
  maturity_height: number;
  maturity_time: string;
  ok: boolean;
  msg: string;
}

export interface LiquidityQuote {
  lc_in: Amount;
  hbd_needed: Amount;
  shares: Amount;
  pool_share_pct: Amount;
  is_first_deposit: boolean;
  ok: boolean;
  msg: string;
}

/**
 * How an author's own reward is delivered. Set at publication, frozen with the
 * post, and applying to the AUTHOR only — curators always take the standard
 * split, because one person's choice must not dictate another's pay.
 */
export const PayoutMode = {
  /** 20% liquid now, 80% into the monthly mint. */
  Split: 0,
  /** 100% into the monthly mint. */
  PowerUp: 1,
  /** Destroyed. Recorded against total burned. */
  Burn: 2,
} as const;
export type PayoutMode = (typeof PayoutMode)[keyof typeof PayoutMode];

/** An article body. Lives off-chain — on Hive in production. */
export interface Content {
  title: string;
  body: string;
  summary: string;
  tags: string[] | null;
}

/** What publishing returns. */
export interface PublishResult {
  ok: boolean;
  msg: string;
  height: number;
  /** The slug the post was registered under — the contract's key for it. */
  permlink: string;
  /** Wallet signers: the L1 tx id of the contract registration (see TxResult). */
  txId?: string | undefined;
}

/**
 * An account's resource credits.
 *
 * RC is what a transaction actually costs on MAGI — there are no fees. Spending
 * it all leaves a user unable to post, vote or transfer, so any background work
 * the app does on their behalf has to leave them plenty.
 */
export interface ResourceCredits {
  /** Currently available. */
  amount: number;
  /** Ceiling, from staked balance. */
  max: number;
}

/**
 * One `gov_board` account as RAW STATE, ready to hand to the engine.
 *
 * ⚠️ THESE ARE BASE-UNIT STRINGS, not the decimal `Amount`s everything else in
 * this file carries. That is deliberate: they exist to be passed straight into
 * `engine.effectiveValue` and `engine.consensusGroup`, which is where the
 * median, the clamping and the top-10 ranking happen. Formatting them on the
 * way through would mean converting back before the engine could use them, and
 * every conversion is a chance to lose a base unit.
 *
 * `preferences[key]` is null when that member has never voted on that
 * parameter. Absent is NOT zero — the engine skips a non-voter rather than
 * counting them at the floor.
 */
export interface GovernanceMember {
  /** Fully qualified, e.g. `hive:lasseehlers` — never a bare name. */
  account: string;
  /** `shr_<account>`: HELD L-Shares, which is what decides who holds a seat. */
  shares: string;
  preferences: Record<string, string | null>;
}

/** Swap direction. */
export type SwapDirection = "lc_hbd" | "hbd_lc";

/** Contract entrypoints, exactly as the WASM exports them. */
export const Entrypoint = {
  Transfer: "transfer",
  Burn: "burn",
  Settle: "settle",
  Mint: "mint",
  ClaimMint: "claim_mint",
  GoodAccounting: "good_accounting",
  SetDuration: "set_duration",
  SettlePending: "settle_pending",
  Promote: "promote",
  SetParam: "set_param",
  Post: "post",
  Comment: "comment",
  PromotePost: "promote_post",
  Vote: "vote",
  Payout: "payout",
  ClaimCuration: "claim_curation",
  AddLiquidity: "add_liquidity",
  RemoveLiquidity: "remove_liquidity",
  ClaimPool: "claim_pool",
  SwapLcHbd: "swap_lc_hbd",
  SwapHbdLc: "swap_hbd_lc",
  ClaimMigration: "claim_migration",
  RecordBurn: "record_burn",
} as const;
export type Entrypoint = (typeof Entrypoint)[keyof typeof Entrypoint];

/**
 * An account's permanent migration receipt — the `mig_<account>` key.
 *
 * Written once and never rewritten: by a claim, by `record_burn`, or by the
 * old push-model batches. Its PRESENCE is the one-credit guard, so a non-null
 * result means "this account is done, whatever it holds now".
 */
export interface MigrationRecord {
  /** True when the account did not qualify and its holdings went to @null. */
  burned: boolean;
  /** What it held on Hive-Engine at the snapshot. */
  liquid: Amount;
  staked: Amount;
}

/** Governable parameter keys, with their hardcoded bounds enforced on-chain. */
export const Param = {
  VolumeStart: "mint.volume_start",
  VolumeEnd: "mint.volume_end",
  PostThresholdViral: "post.threshold_viral",
  PostThresholdDeep: "post.threshold_deep",
  PostThresholdComment: "post.threshold_comment",
  PromoteMinBurn: "promote.min_burn",
  // No swap-fee key: the LASSECASH:HBD fee is hardcoded to zero, not governed.
} as const;
export type Param = (typeof Param)[keyof typeof Param];

/**
 * One event in the pool's history, with the price it left behind.
 *
 * Built by replaying the chain's own calls through the engine — see
 * `LasseCashClient.poolTrades` for why it is a replay and not a reading.
 */
export interface PoolTrade {
  /** ISO 8601, UTC. */
  time: string;
  /** `open` is the deposit that set the price; `liquidity` moves depth only. */
  side: "open" | "liquidity" | "sell" | "buy";
  amountIn: Amount;
  amountOut: Amount;
  lcReserve: Amount;
  hbdReserve: Amount;
  /** HBD per LASSECASH, after this event. */
  price: Amount;
}

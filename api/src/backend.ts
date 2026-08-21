/**
 * The backend boundary.
 *
 * THIS INTERFACE IS THE WHOLE POINT OF THE INDEXER. The frontend talks to one
 * client; behind it sits either the local dev chain or a real MAGI node. The
 * simulator deliberately does NOT imitate MAGI's GraphQL — keeping a partial
 * imitation in sync would be a second, subtly-wrong API, and the day it drifted
 * the frontend would break on deploy. The adapter lives here instead, where it
 * is typed and testable.
 */
import type {
  AccountView, ChainInfo, Content, LiquidityQuote, MintQuote, PostView,
  PublishResult, ResourceCredits, SwapDirection, SwapQuote, TxResult,
} from "./types.js";

/** A signer produces authorised transactions. */
export interface Signer {
  /** The account these transactions come from, e.g. "hive:lasseehlers". */
  readonly account: string;
  /**
   * Submit a call. On the dev chain this is unsigned; against MAGI it is
   * signed through Aioha and broadcast.
   */
  submit(entrypoint: string, args: string): Promise<TxResult>;
}

/** Read access to chain state. */
export interface Backend {
  readonly name: string;
  chain(): Promise<ChainInfo>;
  account(name: string): Promise<AccountView>;
  state(keys: string[]): Promise<Record<string, string>>;
  posts(limit?: number): Promise<PostView[]>;
  content(author: string, permlink: string): Promise<Content | null>;
  /**
   * Publish an article and register it on-chain.
   *
   * Two steps behind one call: the body goes to the content layer (Hive in
   * production), then the contract is told a payout window has opened. A real
   * implementation signs both through Aioha.
   */
  publish(input: {
    title: string; body: string; summary: string; tags: string[];
    window: number; payoutMode: number;
  }): Promise<PublishResult>;
  quoteSwap(direction: SwapDirection, amountUnits: string): Promise<SwapQuote>;
  quoteMint(amountUnits: string, days: number): Promise<MintQuote>;
  quoteLiquidity(amountUnits: string): Promise<LiquidityQuote>;
  /**
   * An account's resource credits, or null if the backend has no RC model.
   *
   * Null means UNKNOWN, not unlimited — callers that spend RC on a user's
   * behalf should treat it as "cannot verify" and stay conservative.
   */
  resourceCredits?(account: string): Promise<ResourceCredits | null>;

  /** Dev chains can move their own clock. Real nodes cannot; returns null. */
  advanceDays?(days: number): Promise<number | null>;
}

/** Thrown when a backend request fails. Carries the status for retry logic. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

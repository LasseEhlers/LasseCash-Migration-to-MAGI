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
  AccountView, ChainInfo, Content, LiquidityQuote, MintQuote, PostMeta, PostVote,
  PostView, PublishResult, ResourceCredits, SwapDirection, SwapQuote, TxResult,
} from "./types.js";

/** A signer produces authorised transactions. */
export interface Signer {
  /** The account these transactions come from, e.g. "hive:lasseehlers". */
  readonly account: string;
  /**
   * Submit a call. On the dev chain this is unsigned; against MAGI it is
   * signed through Aioha and broadcast.
   */
  submit(entrypoint: string, args: string, opts?: SubmitOptions): Promise<TxResult>;
}

/** Per-call overrides a caller may pass when it knows more than the table. */
export interface SubmitOptions {
  /**
   * rc_limit for this call. MAGI freezes the FULL limit for five days, so a
   * caller that knows a cheaper path applies (a liquid-only or already
   * matured migration claim) should pass the smaller measured figure rather
   * than the worst case the table must assume.
   */
  rcLimit?: number;
}

/** Read access to chain state. */
export interface Backend {
  readonly name: string;
  chain(): Promise<ChainInfo>;
  account(name: string): Promise<AccountView>;
  state(keys: string[]): Promise<Record<string, string>>;
  posts(limit?: number): Promise<PostView[]>;
  /**
   * The same list, CONTENT ONLY — no payout figures, and therefore no engine.
   *
   * Server rendering runs in an edge worker where the engine WASM is not
   * loaded, and it has no business showing money anyway: HTML is cached, and a
   * pending payout moves every block. This is the half of `posts()` that is
   * both cacheable and computable anywhere.
   */
  postsMeta(limit?: number): Promise<PostMeta[]>;
  /**
   * Who voted on a post, and with what weight.
   *
   * The contract cannot enumerate its own vote records — unbounded iteration
   * does not fit in the gas budget — so the two backends reach the same rows by
   * different routes: the simulator scans its keyspace, and MAGI rediscovers
   * the voters from transaction history before reading each record. Votes whose
   * curator has already been paid have no record left and are simply absent.
   */
  postVotes(author: string, permlink: string): Promise<PostVote[]>;
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

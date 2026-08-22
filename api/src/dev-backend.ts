/**
 * Backend for the local dev chain (`./build.sh node`).
 *
 * The dev chain runs the SAME Go engine the MAGI contract runs, so every number
 * here is already the number the real chain would produce. What it lacks is
 * signing, finality and a real clock — so this backend can also drive time,
 * which the MAGI backend cannot.
 */
import { BackendError, type Backend, type Signer } from "./backend.js";
import type { TxStatus } from "./types.js";
import type {
  AccountView, ChainInfo, Content, GovernanceMember, LiquidityQuote, MintQuote,
  PostMeta, PostVote, PostView, PublishResult, SwapDirection, SwapQuote, TxResult,
} from "./types.js";

export interface DevBackendOptions {
  url?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class DevBackend implements Backend {
  readonly name = "dev";
  readonly #url: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(opts: DevBackendOptions = {}) {
    this.#url = (opts.url ?? "http://localhost:8080").replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async #req<T>(path: string, init?: RequestInit): Promise<T> {
    // Always time out. A hung dev chain must surface as an error the UI can
    // show, not a spinner that never resolves.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(`${this.#url}${path}`, { ...init, signal: ctrl.signal });
    } catch (cause) {
      throw new BackendError(`dev chain unreachable at ${this.#url}${path}`, undefined, cause);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new BackendError(`dev chain returned non-JSON (${res.status})`, res.status, text);
    }
    // 422 is a rejected transaction, which is a legitimate result the caller
    // must be able to read — not a transport failure.
    if (!res.ok && res.status !== 422) {
      throw new BackendError(`dev chain error ${res.status}`, res.status, body);
    }
    return body as T;
  }

  chain(): Promise<ChainInfo> { return this.#req("/chain"); }

  account(name: string): Promise<AccountView> {
    return this.#req(`/account/${encodeURIComponent(name)}`);
  }

  /** The simulator executes synchronously: anything broadcast is settled. */
  async txStatus(_txId: string): Promise<TxStatus> {
    return { status: "CONFIRMED" };
  }

  state(keys: string[]): Promise<Record<string, string>> {
    return this.#req(`/state?keys=${encodeURIComponent(keys.join(","))}`);
  }

  posts(limit = 50): Promise<PostView[]> {
    return this.#req(`/posts?limit=${limit}`);
  }

  /**
   * Content-only post metadata.
   *
   * The dev chain precomputes every field, so this is a PROJECTION of what
   * `/posts` already returned — the money columns are dropped rather than
   * recalculated. Same shape the MAGI backend produces without an engine, so
   * the two remain interchangeable behind server rendering.
   */
  async postsMeta(limit = 50): Promise<PostMeta[]> {
    const posts = await this.posts(limit);
    return posts.map((p) => ({
      author: p.author,
      permlink: p.permlink,
      window: p.window,
      created_height: p.created_height,
      created_time: p.created_time,
      title: p.title,
      summary: p.summary,
      body_excerpt: p.body_excerpt,
      tags: p.tags,
      // The simulator only knows posts it holds a record for, so everything it
      // returns is registered. Tagged-but-unregistered Hive posts are a MAGI
      // concern — there is no Hive behind the dev chain to read them from.
      registered: p.registered,
    }));
  }

  /** The simulator scans its own keyspace — a real node cannot. */
  postVotes(author: string, permlink: string): Promise<PostVote[]> {
    return this.#req(
      `/post/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/votes`);
  }

  /**
   * A post's registered replies. The simulator scans its own keyspace for
   * records whose parent matches; a real node cannot, which is why this is a
   * backend method and not a filter over `posts()`.
   */
  comments(author: string, permlink: string): Promise<PostView[]> {
    return this.#req(
      `/post/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/comments`);
  }

  /**
   * The whole `gov_board` with shares and standing preferences.
   *
   * The dev chain reads the same `gov_board` / `shr_` / `gov_<param>_<account>`
   * keys the frozen public ABI exposes, and returns them RAW. Nothing here
   * decides what is in force — that is `engine.effectiveValue`'s job.
   */
  governance(paramKeys: string[]): Promise<GovernanceMember[]> {
    return this.#req(`/governance?params=${encodeURIComponent(paramKeys.join(","))}`);
  }

  async content(author: string, permlink: string): Promise<Content | null> {
    try {
      return await this.#req<Content>(
        `/content/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}`);
    } catch {
      return null; // an unpublished registration is a normal state, not a fault
    }
  }

  /** Requires a signer; the dev chain takes the account name unsigned. */
  publish(input: {
    title: string; body: string; summary: string; tags: string[];
    window: number; payoutMode: number; sender?: string; signer?: Signer; permlink?: string;
  }): Promise<PublishResult> {
    const { signer: _signer, ...rest } = input;
    return this.#req<PublishResult>("/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rest, sender: input.sender ?? "" }),
    });
  }

  /**
   * Publish a reply, then register it. Same endpoint as `publish` with a
   * parent attached — a comment IS a post with a parent, on the chain and
   * here.
   */
  publishComment(input: {
    permlink: string; body: string;
    parentAuthor: string; parentPermlink: string; payoutMode: number;
    sender?: string; signer?: Signer;
  }): Promise<PublishResult> {
    return this.#req<PublishResult>("/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: input.sender ?? "",
        permlink: input.permlink,
        body: input.body,
        parent_author: input.parentAuthor,
        parent_permlink: input.parentPermlink,
        payout_mode: input.payoutMode,
      }),
    });
  }

  quoteSwap(direction: SwapDirection, amountUnits: string): Promise<SwapQuote> {
    return this.#req(`/quote/swap?direction=${direction}&amount=${amountUnits}`);
  }

  quoteMint(amountUnits: string, days: number): Promise<MintQuote> {
    return this.#req(`/quote/mint?amount=${amountUnits}&days=${days}`);
  }

  quoteLiquidity(amountUnits: string): Promise<LiquidityQuote> {
    return this.#req(`/quote/liquidity?amount=${amountUnits}`);
  }

  /**
   * The dev chain has no RC model — transactions are free here.
   *
   * Returns null (UNKNOWN) rather than a fake full meter, so the guard is
   * exercised honestly rather than being trivially satisfied in development
   * and then failing in production.
   */
  async resourceCredits(): Promise<null> {
    return null;
  }

  async advanceDays(days: number): Promise<number> {
    const r = await this.#req<{ height: number }>("/dev/advance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    });
    return r.height;
  }

  /** Submit a transaction as `account`. The dev chain does not verify signatures. */
  submit(account: string, entrypoint: string, args: string): Promise<TxResult> {
    return this.#req<TxResult>("/tx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: account, entrypoint, args }),
    });
  }
}

/** A signer for the dev chain: no keys, just an account name. */
export class DevSigner implements Signer {
  constructor(
    readonly account: string,
    private readonly backend: DevBackend,
  ) {}

  submit(entrypoint: string, args: string): Promise<TxResult> {
    return this.backend.submit(this.account, entrypoint, args);
  }
}

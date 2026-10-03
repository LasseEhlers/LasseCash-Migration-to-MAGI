/**
 * The transaction index — the pure half.
 *
 * WHY IT EXISTS. The contract cannot enumerate its own posts, mints or
 * accounts (unbounded iteration does not fit in gas), so every list on the
 * site is discovered from transaction history. Until now each visitor walked
 * that history from the node, newest first, page by page. That is fine at a
 * few hundred transactions and dies at a few thousand. The index walks it
 * ONCE, keeps it, and serves it.
 *
 * WHAT IT STORES: the transaction log, verbatim — id, anchor height and time,
 * status, signers, and each op's action and payload. Nothing derived. Every
 * figure the site shows still comes from contract state or the engine; the
 * index only says where to look, exactly like the live walk did. So it can
 * never disagree with the chain about money, only be late about a list.
 *
 * HOW IT SYNCS. Newest first from offset 0, upserting every row, until a page
 * holds nothing new. The FIRST page is always re-read and re-written even when
 * fully known: a transaction's status moves from pending to CONFIRMED/FAILED
 * after it is first seen, and pending ones are always among the newest. The
 * first sync is the backfill; it is bounded by `maxPages` and resumes from a
 * stored offset if the history is longer than one call can walk.
 *
 * The storage is an interface so this file has no idea it is Cloudflare D1.
 */

/** One transaction as the node reports it, plus the two fields the index keys on. */
export interface IndexedTx {
  id: string;
  anchr_height: number;
  anchr_ts: string;
  status: string;
  required_auths: string[];
  required_posting_auths: string[];
  ops: { type: string; data: { action?: string; payload?: string } | null }[];
}

export interface IndexStore {
  /** Which of these ids are already stored. */
  known(ids: string[]): Promise<Set<string>>;
  /** Insert or replace, by id. */
  upsert(txs: IndexedTx[]): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

export interface SyncResult {
  pages: number;
  seen: number;
  added: number;
  /** True once the walk has reached the start of history at least once. */
  complete: boolean;
}

/** The node's page cap; it refuses a larger limit. */
export const INDEX_PAGE = 100;

/**
 * Bring the store up to date with the chain.
 *
 * `fetchPage(offset)` returns up to INDEX_PAGE transactions, newest first.
 */
export async function syncIndex(
  fetchPage: (offset: number) => Promise<IndexedTx[]>,
  store: IndexStore,
  maxPages = 20,
): Promise<SyncResult> {
  const out: SyncResult = { pages: 0, seen: 0, added: 0, complete: false };
  const backfilled = (await store.getMeta("backfill_done")) === "1";

  // 1. The head: walk until a page reaches something already stored.
  let offset = 0;
  let reachedEnd = false;
  for (; out.pages < maxPages; offset += INDEX_PAGE) {
    const rows = await fetchPage(offset);
    out.pages += 1;
    out.seen += rows.length;
    const ids = rows.map((r) => r.id);
    const known = await store.known(ids);
    const fresh = rows.filter((r) => !known.has(r.id));
    // Always rewrite the first page: statuses settle after first sight.
    await store.upsert(offset === 0 ? rows : fresh);
    out.added += fresh.length;
    if (rows.length < INDEX_PAGE) { reachedEnd = true; break; }
    // A known row means everything older is known too: the head block is
    // contiguous, and the backfill below owns whatever lies past it.
    if (fresh.length < rows.length) break;
  }

  // 2. The backfill: if history has never been walked to its start, continue
  // from where the last call stopped. Offsets shift as new transactions
  // arrive, so resuming re-reads a little; upserts make that harmless.
  if (!backfilled && !reachedEnd) {
    let resume = Number((await store.getMeta("backfill_offset")) ?? 0);
    if (resume < offset) resume = offset;
    for (; out.pages < maxPages; resume += INDEX_PAGE) {
      const rows = await fetchPage(resume);
      out.pages += 1;
      out.seen += rows.length;
      const known = await store.known(rows.map((r) => r.id));
      const fresh = rows.filter((r) => !known.has(r.id));
      await store.upsert(fresh);
      out.added += fresh.length;
      if (rows.length < INDEX_PAGE) { reachedEnd = true; break; }
    }
    await store.setMeta("backfill_offset", String(resume));
  }

  if (reachedEnd && !backfilled) await store.setMeta("backfill_done", "1");
  out.complete = reachedEnd || backfilled;
  return out;
}

/** An in-memory store: for tests, and a reference for what the D1 one must do. */
export class MemoryIndexStore implements IndexStore {
  readonly txs = new Map<string, IndexedTx>();
  readonly meta = new Map<string, string>();
  async known(ids: string[]) { return new Set(ids.filter((i) => this.txs.has(i))); }
  async upsert(txs: IndexedTx[]) { for (const t of txs) this.txs.set(t.id, t); }
  async getMeta(k: string) { return this.meta.get(k) ?? null; }
  async setMeta(k: string, v: string) { this.meta.set(k, v); }
  /** Newest first, the order the node itself answers in. */
  all(): IndexedTx[] {
    return [...this.txs.values()].sort((a, b) =>
      b.anchr_height - a.anchr_height || (a.id < b.id ? 1 : -1));
  }
}

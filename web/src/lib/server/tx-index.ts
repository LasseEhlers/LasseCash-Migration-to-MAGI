/**
 * The transaction index on Cloudflare D1 — the storage half.
 *
 * The walk itself is `syncIndex` in api/src/indexer.ts, pure and tested; this
 * file only turns its four store calls into SQL and decides WHEN to sync.
 *
 * NO CRON, NO SECOND SERVICE. A request to the index first catches up with
 * the chain — at most once every SYNC_EVERY_MS, and one page when nothing
 * happened — then answers from the table. A quiet site costs nothing; a busy
 * one keeps itself current. If the binding is missing the endpoint says so
 * with a 503 and every client falls back to walking the node, which is
 * exactly what the site did before the index existed.
 *
 * The table holds the log VERBATIM (`body` is the node's own JSON for the
 * transaction). Nothing derived, so it can be dropped and rebuilt from the
 * chain at any time: `DROP TABLE tx; DROP TABLE meta;` and the next request
 * backfills.
 */
import {
  MagiBackend, syncIndex, type IndexedTx, type IndexStore, type SyncResult,
} from "$api/index.js";
import { CONTRACT_ID } from "./content.js";

/** The part of Cloudflare's D1 binding this file uses. */
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<unknown>;
}
interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export const SYNC_EVERY_MS = 30_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tx (
     id TEXT PRIMARY KEY,
     height INTEGER NOT NULL,
     ts TEXT NOT NULL,
     status TEXT NOT NULL,
     actions TEXT NOT NULL,
     body TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tx_height ON tx (height DESC)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

/** ",post,vote," — so a filter is one LIKE and needs no JSON parsing. */
const actionList = (t: IndexedTx) =>
  "," + (t.ops ?? []).map((o) => o.data?.action ?? "").filter(Boolean).join(",") + ",";

export class D1IndexStore implements IndexStore {
  constructor(private readonly db: D1Like) {}

  async ensureSchema() {
    await this.db.batch(SCHEMA.map((s) => this.db.prepare(s)));
  }

  async known(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const q = `SELECT id FROM tx WHERE id IN (${ids.map(() => "?").join(",")})`;
    const { results } = await this.db.prepare(q).bind(...ids).all<{ id: string }>();
    return new Set(results.map((r) => r.id));
  }

  async upsert(txs: IndexedTx[]): Promise<void> {
    if (!txs.length) return;
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO tx (id, height, ts, status, actions, body) VALUES (?, ?, ?, ?, ?, ?)");
    await this.db.batch(txs.map((t) => stmt.bind(
      t.id, t.anchr_height ?? 0, t.anchr_ts ?? "", t.status ?? "", actionList(t), JSON.stringify(t))));
  }

  async getMeta(k: string): Promise<string | null> {
    const r = await this.db.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first<{ v: string }>();
    return r?.v ?? null;
  }

  async setMeta(k: string, v: string): Promise<void> {
    await this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind(k, v).run();
  }

  /** Newest first, optionally only transactions carrying one of `actions`. */
  async list(actions: string[] = []): Promise<IndexedTx[]> {
    const where = actions.length ? `WHERE ${actions.map(() => "actions LIKE ?").join(" OR ")}` : "";
    const { results } = await this.db
      .prepare(`SELECT body FROM tx ${where} ORDER BY height DESC, id DESC`)
      .bind(...actions.map((a) => `%,${a},%`))
      .all<{ body: string }>();
    return results.map((r) => JSON.parse(r.body) as IndexedTx);
  }
}

/**
 * Catch up with the chain if the last sync is older than SYNC_EVERY_MS.
 * Returns whether the index covers the whole history.
 */
export async function syncIfStale(db: D1Like): Promise<{ complete: boolean; synced?: SyncResult }> {
  const store = new D1IndexStore(db);
  await store.ensureSchema();
  const last = Number((await store.getMeta("synced_at")) ?? 0);
  if (Date.now() - last < SYNC_EVERY_MS) {
    return { complete: (await store.getMeta("backfill_done")) === "1" };
  }
  // Claim the slot first, so a burst of requests does not all walk the node.
  await store.setMeta("synced_at", String(Date.now()));
  const node = new MagiBackend({ contractId: CONTRACT_ID });
  const synced = await syncIndex((o) => node.fetchTxPage(o), store);
  return { complete: synced.complete, synced };
}

/**
 * The D1 binding for THIS request, made visible to the server backend.
 *
 * Cloudflare hands bindings to each request (`platform.env.DB`), but the
 * server backend is one shared object built without a request. hooks.server.ts
 * records the binding here on every request; the backend's fetch shim in
 * content.ts reads it. No imports, so nothing can cycle through this file.
 */
import type { D1Like } from "./tx-index.js";

let current: D1Like | undefined;
export function setIndexDb(db: D1Like | undefined) { if (db) current = db; }
export function indexDb(): D1Like | undefined { return current; }

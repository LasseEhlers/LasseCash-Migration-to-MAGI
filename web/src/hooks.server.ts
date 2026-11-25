import type { Handle } from "@sveltejs/kit";
import { setIndexDb } from "$lib/server/index-db.js";

/** Records the transaction index's D1 binding so server-side reads can use it. */
export const handle: Handle = async ({ event, resolve }) => {
  setIndexDb(event.platform?.env?.DB);
  return resolve(event);
};

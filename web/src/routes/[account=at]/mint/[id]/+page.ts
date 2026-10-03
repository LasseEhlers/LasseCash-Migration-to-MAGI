// One position's card. Client-only: it needs the engine for every HBD figure
// and the live reading of an open position, and the engine runs in the browser.
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const ssr = false;
export const prerender = false;

export const load: PageLoad = ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) throw error(404, "No such position");
  const raw = params.account.slice(1);
  return { account: raw.includes(":") ? raw : `hive:${raw}`, handle: raw, id };
};

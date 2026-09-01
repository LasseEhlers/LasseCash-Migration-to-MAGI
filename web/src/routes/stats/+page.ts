// The live half of the migration: who claimed, what they earned, whether
// anyone is actually using the chain. Reached from the nav as "Stats"; the
// frozen snapshot it grew out of is one click inside it, at /check.
//
// Client-only: it reads roughly 1,700 state keys and the whole transaction
// log, which is far too much work for a Cloudflare worker to redo on every
// request. The figures move every three seconds anyway, so a cached server
// render would be wrong before it reached anyone.
export const ssr = false;
export const prerender = false;

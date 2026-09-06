/**
 * Reward pools — live, so it must not be prerendered or server-rendered.
 *
 * UNLISTED, deliberately: no nav link, reachable only at /rewards by someone
 * who knows the address. Not secret — every figure on it is public chain
 * state anyone can read straight from the node, and a login gate on a
 * client-rendered page would be a curtain rather than a lock. Unlisted simply
 * means nobody stumbles onto an operator's view. Adding it to `navLinks` in
 * +layout.svelte publishes it, and that is a one-line decision to make later.
 * Every figure here moves every 30 seconds, and a cached HTML snapshot of a
 * moving number is worse than no number at all.
 */
export const ssr = false;
export const prerender = false;

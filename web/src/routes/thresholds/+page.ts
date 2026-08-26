/**
 * Client-only, deliberately.
 *
 * Every figure here is engine-derived: the top ten is `engine.consensusGroup`
 * over live L-Share balances, and the value in force is `engine.effectiveValue`
 * over the board's standing preferences. The engine is WASM in the BROWSER,
 * and server-rendering this page would produce a shell of empty values that the
 * browser immediately replaced.
 *
 * Content pages (posts, profiles, the feed) do the opposite. See
 * svelte.config.js.
 */
export const ssr = false;

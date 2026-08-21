/**
 * Client-only, deliberately.
 *
 * Everything on this page is per-user and engine-driven: the figures come out
 * of the engine WASM in the BROWSER, against the signed-in account. There is
 * nothing here a crawler should index and nothing a server could usefully
 * render — server-rendering it would produce a shell of empty values, then
 * immediately replace them.
 *
 * Content pages (posts, profiles, the feed) do the opposite. See
 * svelte.config.js.
 */
export const ssr = false;

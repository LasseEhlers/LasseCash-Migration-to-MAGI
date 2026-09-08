/**
 * Client-only, like every page whose figures are money.
 *
 * The whole page is a replay of the pool's history through the engine WASM,
 * which lives in the browser. Server-rendering it would emit a shell and then
 * replace it — and would put economics on the server, which the golden rule
 * does not allow.
 */
export const ssr = false;

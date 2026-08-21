/**
 * End-to-end sanity: MagiBackend reading the REAL throwaway contract on MAGI
 * mainnet. Not part of `npm test` (network + live state); run by hand:
 *
 *     npm run build && cp -r src/wasm dist/ && node dist/real-read.e2e.js
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
createRequire(import.meta.url)("./wasm/wasm_exec.cjs");
import { loadEngine } from "./engine.js";
import { MagiBackend } from "./magi-backend.js";

await loadEngine(undefined, await readFile(new URL("./wasm/engine.wasm", import.meta.url)));

const b = new MagiBackend({ contractId: "vsc1BeDGyQ9VK7C8yzFfLr8BWm4CtNFWSUFm7J" });
console.log("CHAIN:", JSON.stringify(await b.chain(), null, 1));
console.log("ACCOUNT:", JSON.stringify(await b.account("lassecashmagi"), null, 1));

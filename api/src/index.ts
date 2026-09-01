/**
 * @lassecash/api — the read/indexer layer.
 *
 * Aggregates chain state and computes nothing. Every displayed number was
 * produced by the Go engine, on-chain or in the dev chain that runs the same
 * code. See CLAUDE.md, golden rule.
 *
 *   import { LasseCashClient, DevBackend, DevSigner } from "@lassecash/api";
 *
 *   const backend = new DevBackend({ url: "http://localhost:8080" });
 *   const client  = new LasseCashClient({ backend });
 *   client.setSigner(new DevSigner("hive:lasseehlers", backend));
 *
 *   const quote = await client.quoteMint("100000", 1095);   // engine-computed
 *   await client.mint("100000", 1095);
 */
export * from "./amount.js";
export * from "./types.js";
export * from "./backend.js";
export * from "./dev-backend.js";
export * from "./magi-backend.js";
export * from "./engine.js";
export * from "./hive-metadata.js";
export * from "./aioha-signer.js";
export * from "./client.js";
export * from "./snapshot-check.js";
export * from "./legacy-price.js";
export * from "./magi-pools.js";

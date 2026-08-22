import { test } from "node:test";
import assert from "node:assert/strict";
import { permlinkFor } from "./magi-backend.js";

/**
 * The simulator derives a post's key with `sim.Permlink` (node/sim/content.go).
 * MagiBackend must derive the SAME key from the same title, or a post written
 * against the dev chain and against MAGI would land under different slugs.
 * Vectors computed by the Go function.
 */
test("permlinkFor mirrors sim.Permlink", () => {
  const cases: [string, string][] = [
    ["AnCap Freedom", "ancap-freedom"],
    ["  Hello,  World! ", "hello-world"],
    ["snake_case_and-dash", "snake-case-and-dash"],
    ["Ünïcode → dropped", "ncode-dropped"],
    ["---", ""],
    ["a".repeat(100), "a".repeat(80)],
    ["x".repeat(79) + "-y", "x".repeat(79)],
  ];
  for (const [title, want] of cases) assert.equal(permlinkFor(title), want, title);
});

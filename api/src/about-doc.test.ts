/**
 * docs/ABOUT.md must agree with the code it describes.
 *
 * WHY THIS EXISTS. That document is the canonical text: rendered at /about,
 * served raw at /about.md for AI readers, published to Hive at the announcement
 * as "the rules people migrated under". It is also the file that has been
 * wrong most often. In one afternoon Lasse found, by reading it, that it stated
 * the SUPERSEDED qualifying rule, described the 51,000,000 as a different
 * arithmetic than the design's, claimed weight 0 was refused when weight 0 is
 * the unvote, and compared this project's own drafts against itself under a
 * heading promising the 2019 design.
 *
 * Every one of those was found by a human reading carefully. That is not a
 * control — it is luck plus stamina, and it does not survive a tired evening.
 * These are the assertions that should have been catching them.
 *
 * WHAT IS CHECKED: every figure in the document that the engine also knows.
 * The truth is READ FROM THE ENGINE and asserted to appear in the prose, so a
 * constant that moves in Go fails this test until the document follows it.
 * That is the direction that matters — code moves first, and the document has
 * silently lagged it twice.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { blockSplit, constants, loadEngine, loyaltyMultiplier, supplyLimits } from "./engine.js";
import { toBaseUnitArg } from "./amount.js";

createRequire(import.meta.url)("./wasm/wasm_exec.cjs");
const { readFile } = await import("node:fs/promises");
await loadEngine(undefined, await readFile(new URL("./wasm/engine.wasm", import.meta.url)));

/** The document, read from the repo rather than from a copy. */
const DOC = await (async () => {
  for (const p of ["../docs/ABOUT.md", "../../docs/ABOUT.md", "docs/ABOUT.md"]) {
    try { return await readFile(new URL(p, import.meta.url), "utf8"); } catch { /* next */ }
  }
  throw new Error("cannot locate docs/ABOUT.md from the test");
})();

/** Assert the document says `needle`, and say WHY it should when it does not. */
function says(needle: string, why: string) {
  assert.ok(
    DOC.includes(needle),
    `docs/ABOUT.md no longer contains ${JSON.stringify(needle)}.\n` +
    `  ${why}\n` +
    `  The engine moved and the document did not follow it. Fix the document.`,
  );
}

/** Assert the document does NOT say `needle` — for values that were superseded. */
function neverSays(needle: string, why: string) {
  assert.ok(!DOC.includes(needle), `docs/ABOUT.md still contains ${JSON.stringify(needle)}. ${why}`);
}

test("the frozen constants table matches the engine", () => {
  const C = constants();
  says(`${C.decimals} decimals`, "precision");
  says(`**${C.graceDays} days**, in which nothing happens`, "grace after maturity");
  says(`**${C.bleedDays} days**`, "the bleed");
  says(`**${C.goodAcctGrace.toLocaleString("en-US")} days**`, "Good Accounting grace");
  says(`day ${(C.goodAcctGrace + C.bleedDays).toLocaleString("en-US")}`, "Good Accounting liquidation day");
  says(`day ${C.graceDays + C.bleedDays}`, "ordinary liquidation day");
  says(`${C.minMintDays} day minimum`, "shortest mint");
  says(`${C.maxMintDays.toLocaleString("en-US")} days`, "longest mint");
  says(`${C.loyaltyMaxDays} days`, "LP loyalty cap");
  says(`**${C.fullVoteCostPct}%** of your power`, "vote cost");
  says(`**${C.promoteCutoffPct}%** of a post's payout window`, "promotion cutoff");
  says(`${C.viralPayoutDays}-day`, "viral window");
  says(`${C.deepPayoutDays}-day`, "deep window");
});

test("the LP loyalty ceiling in the prose is the one the engine computes", () => {
  const C = constants();
  const max = loyaltyMultiplier(C.loyaltyMaxDays);        // "1.90000000"
  const shown = `${Number(max).toFixed(2)}x`;              // "1.90x"
  says(shown, `loyaltyMultiplier(${C.loyaltyMaxDays}) = ${max}`);
});

test("the caps in the prose are the caps the engine enforces", () => {
  const L = supplyLimits(toBaseUnitArg("0"));
  const hardcap = Number(L.hardcap).toLocaleString("en-US");      // 51,000,000
  const emission = Number(L.emissionCap).toLocaleString("en-US"); // 20,000,000
  says(hardcap, "historic hard cap");
  says(emission, "emission cap");
  // The three-part arithmetic Lasse corrected on 2026-08-23: 11M + 20M + 20M.
  says("11,000,000", "the founder allocation, without which 51M looks arbitrary");
});

test("the block split in the prose is the split the engine returns", () => {
  const s = blockSplit(toBaseUnitArg("100"));
  says(`${Number(s.proofOfBrain).toFixed(0)}%`, "Proof-of-Brain share");
  says(`${Number(s.lshare).toFixed(0)}%`, "L-Share share");
  // viral and deep are quoted as shares OF the PoB slice, not of the block
  const viralOfPob = (Number(s.viral) / Number(s.proofOfBrain)) * 100;
  const deepOfPob = (Number(s.deep) / Number(s.proofOfBrain)) * 100;
  says(`${viralOfPob.toFixed(0)}%`, "viral share of the PoB slice");
  says(`${deepOfPob.toFixed(0)}%`, "deep share of the PoB slice");
});

test("the migration timeline in the prose is derived from the engine", () => {
  const C = constants();
  says(`${C.migrationMintDays}-day mint`, "migration mint length");
  // Claim window = MigrationMintDays + GraceDays + BleedDays. This is the
  // figure that was published as "five months" until the grace widened.
  const claimDays = C.migrationMintDays + C.graceDays + C.bleedDays;
  assert.equal(claimDays, 210, "claim window arithmetic changed");
  says(`${claimDays} days`, "claim window");
});

test("the figure markers the About page splits on are all present", () => {
  // These lines must STAY in the markdown: /about.md and the GitHub README are
  // text-only readings where a sentence describing the diagram is what a reader
  // wants, and web/src/routes/about/+page.svelte splits the document on exactly
  // these markers to interleave the drawings. Delete one and its figure
  // silently vanishes from the page with nothing to show it ever existed.
  const markers = DOC.split("\n").filter((l) => l.startsWith("[figure:"));
  assert.equal(markers.length, 3, `expected 3 figure markers, found ${markers.length}`);
  for (const key of ["emission curve", "the claim window", "the life of a mint"])
    assert.ok(markers.some((m) => m.includes(key)),
      `no figure marker mentions ${JSON.stringify(key)} — AboutFigure matches on that phrase`);
});

test("rules that were SUPERSEDED must not reappear", () => {
  neverSays("ACTIVE-key operation",
    "C6 replaced the Hive active-key test with a signed LASSECASH operation on 2026-08-22.");
  neverSays("zero and negative are refused",
    "Weight 0 is the unvote, not a refusal — see state.Vote.");
  // Product plans Lasse keeps private are listed in a LOCAL, gitignored file
  // (docs/private-names.txt, one name per line) — the names themselves must
  // never sit in this public repository, not even inside a guard.
  const privateNames = (() => {
    try { return readFileSync(new URL("../../docs/private-names.txt", import.meta.url), "utf8"); }
    catch { return ""; }
  })().split("\n").map((l) => l.trim()).filter(Boolean);
  for (const name of privateNames) neverSays(name, "Private product plan.");
});

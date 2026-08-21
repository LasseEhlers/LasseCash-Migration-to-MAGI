import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNIT, add, compare, format, formatMultiplier, formatPercent,
  fromUnits, isPositive, isZero, normalize, subtract, toBaseUnitArg, toUnits,
} from "./amount.js";

// THE test. If this ever fails, balances silently stop matching the chain.
test("amounts survive values that would break a JS number", () => {
  // The 51M hardcap in base units is 5.1e15 — beyond Number.MAX_SAFE_INTEGER
  // once you multiply anything by it.
  const hardcap = "51000000.00000000";
  assert.equal(toUnits(hardcap), 5_100_000_000_000_000n);
  assert.equal(fromUnits(toUnits(hardcap)), hardcap);

  // A value that a float round-trip would mangle.
  const awkward = "9007199.25474099";
  assert.equal(fromUnits(toUnits(awkward)), awkward);

  // The founder's real migrated balance.
  const founder = "7222688.55737746";
  assert.equal(fromUnits(toUnits(founder)), founder);

  // Balances DO fit in a JS number today — MAX_SAFE_INTEGER is ~90,071,992 LC
  // against a 51M cap. The reason not to rely on that:
  //
  // 1. Products leave the safe range immediately. Every rate, bonus and share
  //    is a 1e8-scaled multiplier, so amount x multiplier is ~1e23.
  const product = Number(toUnits(hardcap)) * 225_000_000; // a 2.25x multiplier
  assert.ok(!Number.isSafeInteger(product), "products are already unsafe as doubles");
  // BigInt keeps it exact.
  assert.equal(toUnits(hardcap) * 225_000_000n, 1_147_500_000_000_000_000_000_000n);

  // 2. Decimal fractions are not exactly representable in binary at all.
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(add("0.10000000", "0.20000000"), "0.30000000");
});

test("round-trips are exact across the full range", () => {
  for (const a of [
    "0.00000000", "0.00000001", "1.00000000", "0.99999999",
    "-5.12345678", "31000000.00000000", "19068736.06104624",
  ]) {
    assert.equal(fromUnits(toUnits(a)), a, `round trip failed for ${a}`);
    assert.equal(normalize(a), a);
  }
});

test("short and long decimal input is normalised, truncating like the chain", () => {
  assert.equal(normalize("1"), "1.00000000");
  assert.equal(normalize("1.5"), "1.50000000");
  assert.equal(normalize("0.1"), "0.10000000");
  // More precision than the chain has must FLOOR, never round up — rounding up
  // would show a balance the chain will not pay.
  assert.equal(normalize("1.123456789"), "1.12345678");
  assert.equal(normalize("0.999999999"), "0.99999999");
});

test("malformed input is rejected rather than guessed", () => {
  for (const bad of ["", "abc", "1.2.3", "1,000", "0x10", " ", "1e5", "--1", "1."]) {
    assert.throws(() => toUnits(bad), `should have rejected ${JSON.stringify(bad)}`);
  }
});

test("comparison uses BigInt, so large values order correctly", () => {
  assert.equal(compare("1.00000000", "2.00000000"), -1);
  assert.equal(compare("2.00000000", "1.00000000"), 1);
  assert.equal(compare("1.00000000", "1.00000000"), 0);
  // Two values a float would consider equal.
  assert.equal(compare("90071992.54740992", "90071992.54740993"), -1);
  assert.ok(isZero("0.00000000"));
  assert.ok(isPositive("0.00000001"));
  assert.ok(!isPositive("0.00000000"));
});

test("exact addition and subtraction", () => {
  assert.equal(add("0.10000000", "0.20000000"), "0.30000000"); // 0.1+0.2 in floats: 0.30000000000000004
  assert.equal(add("31000000.00000000", "20000000.00000000"), "51000000.00000000");
  assert.equal(subtract("1.00000000", "0.00000001"), "0.99999999");
});

test("display formatting never feeds back into a transaction", () => {
  assert.equal(format("1234567.89123456"), "1,234,567.891");
  // TRUNCATES, never rounds up — displaying 1,234,568 when the account holds
  // 1,234,567.89 would show money that is not there.
  assert.equal(format("1234567.89123456", { decimals: 0 }), "1,234,567");
  assert.equal(format("1234567.89123456", { group: false, decimals: 8 }), "1234567.89123456");
  assert.equal(format("-42.50000000", { decimals: 2 }), "-42.50");
  assert.equal(formatMultiplier("2.25000000"), "2.25x");
  // Truncates rather than rounding, consistently with format().
  assert.equal(formatPercent("0.34854368"), "0.34%");
});

test("user input becomes the base-unit argument an entrypoint expects", () => {
  assert.equal(toBaseUnitArg("1"), "100000000");
  assert.equal(toBaseUnitArg("0.00000001"), "1");
  assert.equal(toBaseUnitArg("100000"), "10000000000000");
  assert.equal(toBaseUnitArg("51000000"), "5100000000000000");
  // Negative amounts are refused — every entrypoint would reject them anyway,
  // and a negative transfer is theft in reverse.
  assert.throws(() => toBaseUnitArg("-1"));
});

test("UNIT matches the chain's 8 decimals", () => {
  assert.equal(UNIT, 100_000_000n);
});

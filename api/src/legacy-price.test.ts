import { test } from "node:test";
import assert from "node:assert/strict";
import { scaled, usdValue } from "./legacy-price.js";

test("scaled parses decimals exactly and truncates", () => {
  assert.equal(scaled("0.00067187", 6), 671n);        // truncates the 8th place
  assert.equal(scaled("0.00067187", 8), 67187n);
  assert.equal(scaled("65.05583878", 8), 6505583878n);
  assert.equal(scaled("7", 2), 700n);
  assert.throws(() => scaled("1e-5", 6));
  assert.throws(() => scaled("-1", 6));
});

test("usdValue never passes base units through a float", () => {
  // @tibfox: 527,201.16326256 LC at $0.00067187 -> $354.21 (measured live 2026-08-23)
  assert.equal(usdValue(52_720_116_326_256n, "0.00067187"), "354.21");
  // @lasseehlers: 7,073,668.93311018 LC
  assert.equal(usdValue(707_366_893_311_018n, "0.00067187"), "4752.58");
  // a 9.00292595 gift is under a cent, and it must say so rather than round up
  assert.equal(usdValue(900_292_595n, "0.00067187"), "0.00");
  assert.equal(usdValue(0n, "0.00067187"), "0.00");
});

test("usdValue truncates to the cent, never rounds up", () => {
  // 1 LC at $0.00999999 is 0.999999 cents -> "0.00", not "0.01"
  assert.equal(usdValue(100_000_000n, "0.00999999"), "0.00");
  assert.equal(usdValue(100_000_000n, "0.01"), "0.01");
});

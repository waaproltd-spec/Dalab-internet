import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUssdAmount, normalizePhoneForUssd } from "../ussdFormatting.js";

// Every example from the spec, verbatim.
const AMOUNT_CASES: Array<[string, string]> = [
  ["0.10", "0*1"],
  ["0.20", "0*2"],
  ["0.25", "0*25"],
  ["0.35", "0*35"],
  ["0.40", "0*4"],
  ["0.45", "0*45"],
  ["0.50", "0*5"],
  ["0.70", "0*7"],
  ["0.80", "0*8"],
  ["0.89", "0*89"],
  ["1.00", "1"],
  ["1.50", "1*5"],
  ["2.00", "2"],
  ["2.50", "2*5"],
  ["4.25", "4*25"],
  ["5.00", "5"],
  ["5.50", "5*5"],
  ["17.50", "17*5"],
  ["22.50", "22*5"],
  ["25.00", "25"],
];

for (const [input, expected] of AMOUNT_CASES) {
  test(`formatUssdAmount("${input}") === "${expected}"`, () => {
    assert.equal(formatUssdAmount(input), expected);
  });
  test(`formatUssdAmount(${input}) (as a number, not a string) === "${expected}"`, () => {
    assert.equal(formatUssdAmount(Number(input)), expected);
  });
}

test("never produces a trailing '*0' for a whole-dollar amount", () => {
  for (const whole of ["1.00", "5.00", "25.00", "100.00"]) {
    assert.ok(!formatUssdAmount(whole).includes("*0"), `${whole} -> ${formatUssdAmount(whole)}`);
  }
});

test("normalizePhoneForUssd strips the 252 country code down to the bare 9-digit local number", () => {
  assert.equal(normalizePhoneForUssd("252685115555"), "685115555");
});

test("normalizePhoneForUssd strips a leading 0 the same way", () => {
  assert.equal(normalizePhoneForUssd("0685115555"), "685115555");
});

test("normalizePhoneForUssd leaves an already-bare 9-digit number unchanged", () => {
  assert.equal(normalizePhoneForUssd("685115555"), "685115555");
});

test("normalizePhoneForUssd strips non-digit formatting characters too", () => {
  assert.equal(normalizePhoneForUssd("+252 68-511-5555"), "685115555");
});

test("normalizePhoneForUssd handles null/undefined/empty without throwing", () => {
  assert.equal(normalizePhoneForUssd(null), "");
  assert.equal(normalizePhoneForUssd(undefined), "");
  assert.equal(normalizePhoneForUssd(""), "");
});

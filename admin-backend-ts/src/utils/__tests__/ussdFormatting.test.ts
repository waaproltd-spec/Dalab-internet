import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUssdAmount, normalizePhoneForUssd } from "../ussdFormatting.js";

// "0.10" -> "01" and "0.50" -> "05" are real confirmed production values
// (ussd_logs.generated_string for completed Hormuud Anfac orders, Aug 2026 —
// see ussdFormatting.ts's header comment for the incident this was fixed
// from). Every other case follows the same single-token rule.
const AMOUNT_CASES: Array<[string, string]> = [
  ["0.10", "01"],
  ["0.20", "02"],
  ["0.25", "025"],
  ["0.35", "035"],
  ["0.40", "04"],
  ["0.45", "045"],
  ["0.50", "05"],
  ["0.70", "07"],
  ["0.80", "08"],
  ["0.89", "089"],
  ["1.00", "1"],
  ["1.50", "15"],
  ["2.00", "2"],
  ["2.50", "25"],
  ["4.25", "425"],
  ["5.00", "5"],
  ["5.50", "55"],
  ["17.50", "175"],
  ["22.50", "225"],
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

test("never inserts a '*' into the amount token — Internet Store templates have only one {amount} field", () => {
  for (const amount of ["0.10", "0.50", "1.00", "4.25", "17.50", "25.00", "100.00"]) {
    assert.ok(!formatUssdAmount(amount).includes("*"), `${amount} -> ${formatUssdAmount(amount)}`);
  }
});

test("a whole-dollar amount is just the dollar figure, no appended cents zero", () => {
  assert.equal(formatUssdAmount("1.00"), "1");
  assert.equal(formatUssdAmount("5.00"), "5");
  assert.equal(formatUssdAmount("25.00"), "25");
  assert.equal(formatUssdAmount("100.00"), "100");
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

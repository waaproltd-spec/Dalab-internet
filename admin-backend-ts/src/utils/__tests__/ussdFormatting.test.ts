import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUssdAmount, formatEvcDahabUssdAmount, normalizePhoneForUssd, splitUssdAmount, formatUssdAmountSplit } from "../ussdFormatting.js";

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

// formatEvcDahabUssdAmount -- EVC Plus/eDahab's own *712*/*110* Dial-to-Pay
// menu, a genuinely different carrier convention from formatUssdAmount()
// above (which is for Internet Store's single-token top-up templates
// only). Real bug reported live (screenshot: a $42.00 VIP Number order
// dialed as "*712*610338686*42*00#") -- a whole-dollar amount must never
// get a spurious "*00" cents segment, the same "never pad a round amount
// with an empty-looking field" rule formatUssdAmount/formatUssdAmountSplit
// above already apply. A sub-$1 amount (no dollars) must likewise never
// carry a leading "0*" -- just the cents figure alone.
const EVC_DAHAB_AMOUNT_CASES: Array<[string, string]> = [
  ["22.20", "22*20"],
  ["25.00", "25"],
  ["100.00", "100"],
  ["1.98", "1*98"],
  ["10.30", "10*30"],
  ["0.10", "10"],
  ["0.05", "05"],
  ["0.50", "50"],
  ["1.00", "1"],
  ["1.05", "1*05"],
  ["42.00", "42"],
  ["90.00", "90"], // e.g. a $100 package discounted 10% to $90
];

for (const [input, expected] of EVC_DAHAB_AMOUNT_CASES) {
  test(`formatEvcDahabUssdAmount("${input}") === "${expected}"`, () => {
    assert.equal(formatEvcDahabUssdAmount(input), expected);
  });
}

test("formatEvcDahabUssdAmount never collapses $22.20 into the buggy single-token \"222\"", () => {
  assert.notEqual(formatEvcDahabUssdAmount("22.20"), "222");
  assert.equal(formatEvcDahabUssdAmount("22.20"), "22*20");
});

test("formatEvcDahabUssdAmount never pads a whole-dollar amount with a trailing '*00' — the real reported bug", () => {
  assert.equal(formatEvcDahabUssdAmount("42.00"), "42");
  assert.notEqual(formatEvcDahabUssdAmount("42.00"), "42*00");
});

test("formatEvcDahabUssdAmount substituted into a shop_payment_methods-style template produces the real carrier dial string", () => {
  const evcTemplate = "*712*610338686*{amount}#";
  const edahabTemplate = "*110*620338686*{amount}#";
  assert.equal(evcTemplate.replace("{amount}", formatEvcDahabUssdAmount("22.20")), "*712*610338686*22*20#");
  assert.equal(edahabTemplate.replace("{amount}", formatEvcDahabUssdAmount("22.20")), "*110*620338686*22*20#");
  assert.equal(evcTemplate.replace("{amount}", formatEvcDahabUssdAmount("25.00")), "*712*610338686*25#");
  assert.equal(evcTemplate.replace("{amount}", formatEvcDahabUssdAmount("100.00")), "*712*610338686*100#");
  assert.equal(evcTemplate.replace("{amount}", formatEvcDahabUssdAmount("42.00")), "*712*610338686*42#");
  assert.equal(evcTemplate.replace("{amount}", formatEvcDahabUssdAmount("0.05")), "*712*610338686*05#");
});

// splitUssdAmount -- Somnet's own top-up USSD menu (real production incident:
// order DLB981226132, $22.50, dialed with formatUssdAmount's single-token
// "225" and rejected outright by the carrier, which quoted back the expected
// 4-field shape "*827*number*lacag*cents#" in its own error response). Unlike
// formatUssdAmount (one collapsed token) or formatEvcDahabUssdAmount (one
// "*"-joined token), this exposes whole/cents as two independent values for
// generateUssdForOrder's {amountWhole}/{amountCents} placeholders -- the
// template itself supplies the "*" separator between them.
const SPLIT_AMOUNT_CASES: Array<[string, string, string]> = [
  ["22.50", "22", "50"],
  ["25.00", "25", "00"],
  ["0.10", "0", "10"],
  ["1.98", "1", "98"],
  ["100.00", "100", "00"],
];

for (const [input, whole, cents] of SPLIT_AMOUNT_CASES) {
  test(`splitUssdAmount("${input}") === { whole: "${whole}", cents: "${cents}" }`, () => {
    assert.deepEqual(splitUssdAmount(input), { whole, cents });
  });
}

test("splitUssdAmount substituted into Somnet's real template shape produces the exact carrier-confirmed dial string", () => {
  const somnetTemplate = "*827*{number}*{amountWhole}*{amountCents}#";
  const dialed = somnetTemplate.replace("{amountWhole}", splitUssdAmount("22.50").whole).replace("{amountCents}", splitUssdAmount("22.50").cents);
  assert.equal(dialed.replace("{number}", "620338686"), "*827*620338686*22*50#");
});

// formatUssdAmountSplit -- Somtel's own top-up USSD menu (real production
// incident: order DLB637490120, provider amount $17.50, dialed with
// formatUssdAmount's single-token "175" -- and, separately, a raw "17.5" --
// and left permanently stuck "ambiguous" after 3 dial attempts on an online
// device). Unlike splitUssdAmount (always both fields, 2-digit cents) or
// formatUssdAmount (always one concatenated token), this omits the cents
// field entirely for a whole-dollar amount and "*"-joins (never
// concatenates) whole and cents when present, collapsing a round-tens cents
// value to one digit the same way formatUssdAmount's own token does.
const SPLIT_COLLAPSED_AMOUNT_CASES: Array<[string, string]> = [
  ["17.00", "17"],
  ["17.50", "17*5"],
  ["17.25", "17*25"],
  ["12.34", "12*34"],
  ["1.50", "1*5"],
  ["0.10", "0*1"],
  ["0.25", "0*25"],
  ["1.00", "1"],
  ["25.00", "25"],
  ["100.00", "100"],
];

for (const [input, expected] of SPLIT_COLLAPSED_AMOUNT_CASES) {
  test(`formatUssdAmountSplit("${input}") === "${expected}"`, () => {
    assert.equal(formatUssdAmountSplit(input), expected);
  });
  test(`formatUssdAmountSplit(${input}) (as a number, not a string) === "${expected}"`, () => {
    assert.equal(formatUssdAmountSplit(Number(input)), expected);
  });
}

test("formatUssdAmountSplit never concatenates dollars and cents into one token, and never omits the '*' when cents are present", () => {
  assert.notEqual(formatUssdAmountSplit("17.50"), "175");
  assert.notEqual(formatUssdAmountSplit("17.50"), "17.5");
  assert.equal(formatUssdAmountSplit("17.50"), "17*5");
});

test("formatUssdAmountSplit never pads a whole-dollar amount with a trailing cents segment", () => {
  assert.equal(formatUssdAmountSplit("17.00"), "17");
  assert.ok(!formatUssdAmountSplit("17.00").includes("*"), formatUssdAmountSplit("17.00"));
});

test("formatUssdAmountSplit substituted into Somtel's real template shape produces the exact dial string that unblocks DLB637490120", () => {
  const somtelTemplate = "*831*{number}*{amountSplit}*8233{pin}#";
  const dialWholeDollar = somtelTemplate
    .replace("{number}", "620338686")
    .replace("{amountSplit}", formatUssdAmountSplit("17.00"))
    .replace("{pin}", "1234");
  const dialWithCents = somtelTemplate
    .replace("{number}", "620338686")
    .replace("{amountSplit}", formatUssdAmountSplit("17.50"))
    .replace("{pin}", "1234");
  assert.equal(dialWholeDollar, "*831*620338686*17*82331234#");
  assert.equal(dialWithCents, "*831*620338686*17*5*82331234#");
});

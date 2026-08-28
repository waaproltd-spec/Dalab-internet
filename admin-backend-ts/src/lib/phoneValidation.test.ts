import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMobileNumber, isValidMobileNumber, normalizeMobileDigits, companyForPrefix, companyKeyFromLabel } from "./phoneValidation.js";

test("exactly 9 digits with a known prefix is valid with no company selected", () => {
  assert.equal(isValidMobileNumber("617080008"), true);
});

test("8 digits is rejected", () => {
  const result = validateMobileNumber("61708000");
  assert.equal(result.valid, false);
  assert.equal(result.error, "Invalid phone number. Enter exactly 9 digits.");
});

test("10 digits (leading 0 + 9 digits) is rejected", () => {
  const result = validateMobileNumber("0617080008");
  assert.equal(result.valid, false);
  assert.equal(result.error, "Invalid phone number. Enter exactly 9 digits.");
});

test("a number starting with 0 but otherwise 9 digits long is still rejected", () => {
  // "0" + 8 more digits = 9 digits total, but must still fail on the
  // leading-zero rule, not silently pass the length check.
  const result = validateMobileNumber("012345678");
  assert.equal(result.valid, false);
});

test("letters are rejected", () => {
  assert.equal(isValidMobileNumber("61708000a"), false);
  assert.equal(isValidMobileNumber("abcdefghi"), false);
});

test("a +252 country code prefix is tolerated and normalized away", () => {
  assert.equal(isValidMobileNumber("+252617080008"), true);
  assert.equal(isValidMobileNumber("252617080008"), true);
});

test("empty/null/undefined is rejected, not thrown", () => {
  assert.equal(isValidMobileNumber(""), false);
  assert.equal(isValidMobileNumber(null), false);
  assert.equal(isValidMobileNumber(undefined), false);
});

test("companyForPrefix identifies the right carrier", () => {
  assert.equal(companyForPrefix("617080008")?.key, "evc_plus");
  assert.equal(companyForPrefix("770080008")?.key, "evc_plus");
  assert.equal(companyForPrefix("687080008")?.key, "jeeb");
  assert.equal(companyForPrefix("627080008")?.key, "edahab");
  assert.equal(companyForPrefix("717080008")?.key, "amtel_pay");
  assert.equal(companyForPrefix("997080008"), null);
});

test("EVC Plus (evc_plus) accepts both 61 and 77 prefixes, rejects others", () => {
  assert.equal(validateMobileNumber("617080008", "evc_plus").valid, true);
  assert.equal(validateMobileNumber("770080008", "evc_plus").valid, true);
  const rejected = validateMobileNumber("687080008", "evc_plus");
  assert.equal(rejected.valid, false);
  assert.equal(rejected.error, "Invalid number. EVC Plus numbers must start with 61 or 77.");
});

test("Somnet (jeeb) only accepts the 68 prefix", () => {
  assert.equal(validateMobileNumber("687080008", "jeeb").valid, true);
  const rejected = validateMobileNumber("617080008", "jeeb");
  assert.equal(rejected.valid, false);
  assert.equal(rejected.error, "Invalid number. Jeeb numbers must start with 68.");
});

test("Somtel (edahab) only accepts the 62 prefix", () => {
  assert.equal(validateMobileNumber("627080008", "edahab").valid, true);
  assert.equal(validateMobileNumber("617080008", "edahab").valid, false);
});

test("Amtel (amtel_pay) only accepts the 71 prefix", () => {
  assert.equal(validateMobileNumber("717080008", "amtel_pay").valid, true);
  assert.equal(validateMobileNumber("627080008", "amtel_pay").valid, false);
});

test("a number with a prefix belonging to no known carrier at all is rejected even with no company selected", () => {
  const result = validateMobileNumber("997080008");
  assert.equal(result.valid, false);
  assert.equal(result.error, "Invalid phone number. This prefix is not recognized for any supported carrier.");
});

test("normalizeMobileDigits strips punctuation/spaces", () => {
  assert.equal(normalizeMobileDigits("61-708-0008"), "617080008");
  assert.equal(normalizeMobileDigits("61 708 0008"), "617080008");
});

test("normalizeMobileDigits does not strip a leading 0 -- that's a real error, not noise", () => {
  assert.equal(normalizeMobileDigits("0617080008"), "0617080008");
});

test("companyKeyFromLabel recognizes company names and admin-chosen slugs by keyword", () => {
  assert.equal(companyKeyFromLabel("Hormuud"), "evc_plus");
  assert.equal(companyKeyFromLabel("hormuud"), "evc_plus");
  assert.equal(companyKeyFromLabel("EVC Plus"), "evc_plus");
  assert.equal(companyKeyFromLabel("evc"), "evc_plus");
  assert.equal(companyKeyFromLabel("Somtel"), "edahab");
  assert.equal(companyKeyFromLabel("eDahab"), "edahab");
  assert.equal(companyKeyFromLabel("Somnet"), "jeeb");
  assert.equal(companyKeyFromLabel("JEEB"), "jeeb");
  assert.equal(companyKeyFromLabel("Amtel"), "amtel_pay");
  assert.equal(companyKeyFromLabel("Golis"), null);
  assert.equal(companyKeyFromLabel(null), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { signRefreshToken, verifyToken, refreshTtlMsForRole, isValidCustomerPassword, isStrongPassword } from "./crypto.js";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

// verifyToken (crypto.ts's own public API) rather than jwt.decode directly --
// this repo's typings/jsonwebtoken.d.ts shim deliberately only exposes
// sign/verify, not decode.
function ttlSeconds(token: string): number {
  const payload = verifyToken(token) as unknown as { iat: number; exp: number };
  return payload.exp - payload.iat;
}

test("a reseller refresh token is valid for well over a year", () => {
  const token = signRefreshToken("reseller-1", "reseller", "jti-1");
  assert.ok(ttlSeconds(token) > ONE_YEAR_SECONDS, `expected reseller TTL > 1 year, got ${ttlSeconds(token)}s`);
});

test("a customer refresh token keeps the original ~30 day TTL, unaffected by the reseller change", () => {
  const token = signRefreshToken("customer-1", "customer", "jti-2");
  assert.equal(ttlSeconds(token), THIRTY_DAYS_SECONDS);
});

test("an agent refresh token also keeps the original ~30 day TTL", () => {
  const token = signRefreshToken("agent-1", "agent", "jti-3");
  assert.equal(ttlSeconds(token), THIRTY_DAYS_SECONDS);
});

test("refreshTtlMsForRole matches what signRefreshToken actually signs, per role", () => {
  assert.ok(refreshTtlMsForRole("reseller") > ONE_YEAR_SECONDS * 1000);
  assert.equal(refreshTtlMsForRole("customer"), THIRTY_DAYS_SECONDS * 1000);
  assert.equal(refreshTtlMsForRole("agent"), THIRTY_DAYS_SECONDS * 1000);
  assert.equal(refreshTtlMsForRole("admin"), THIRTY_DAYS_SECONDS * 1000);
});

// isValidCustomerPassword: customer registration/forgot-password only
// requires 6+ characters -- no required mix of letter/number/symbol,
// though a symbol is still welcome. Matches the exact examples from the
// product request.
test("isValidCustomerPassword accepts letters+numbers with no symbol, 6+ chars", () => {
  assert.equal(isValidCustomerPassword("Nuur12"), true);
  assert.equal(isValidCustomerPassword("Nuur123"), true);
  assert.equal(isValidCustomerPassword("Nuur1234"), true);
});

test("isValidCustomerPassword accepts a password with a symbol too", () => {
  assert.equal(isValidCustomerPassword("Nuur1234@"), true);
});

test("isValidCustomerPassword rejects fewer than 6 characters", () => {
  assert.equal(isValidCustomerPassword("Nuur1"), false);
});

test("isValidCustomerPassword is unrelated to isStrongPassword (admin/staff rule stays strict)", () => {
  // "Nuur1234" satisfies the new customer rule but not the old strict one
  // (no symbol) -- confirms the two rules are genuinely independent.
  assert.equal(isValidCustomerPassword("Nuur1234"), true);
  assert.equal(isStrongPassword("Nuur1234"), false);
});

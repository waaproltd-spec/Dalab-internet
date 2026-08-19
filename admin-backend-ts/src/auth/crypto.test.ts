import { test } from "node:test";
import assert from "node:assert/strict";
import { signRefreshToken, verifyToken, refreshTtlMsForRole } from "./crypto.js";

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

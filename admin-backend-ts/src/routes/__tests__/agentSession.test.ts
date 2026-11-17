// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported).
//
// Agents stay signed in until they press Logout: long-lived agent tokens,
// and a renewal whose reply never reached the phone is forgiven (once,
// within 5 minutes) instead of logging the agent out. Logout is final.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { createHash } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { authRouter, issueTokens } from "../auth.routes.js";

const AGENT = randomUUID();
const CUSTOMER = randomUUID();
let server: http.Server;
let base: string;

const app = express();
app.use(express.json());
app.use(authRouter);

/** The payload of a JWT (no verification needed here). */
const claims = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
async function refresh(token: string) {
  const res = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: token }) });
  return { status: res.status, body: (await res.json()) as any };
}
const rotatedAgo = (token: string, seconds: number) =>
  query(`UPDATE refresh_tokens SET rotated_at = now() - ($2 || ' seconds')::interval WHERE token_hash=$1`, [hash(token), String(seconds)]);

before(async () => {
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Session Agent','x')`, [AGENT, "25269" + Math.floor(1000000 + Math.random() * 8999999)]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1,$2)`, [CUSTOMER, "25261" + Math.floor(1000000 + Math.random() * 8999999)]);
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await query(`DELETE FROM refresh_tokens WHERE subject_id = ANY($1)`, [[AGENT, CUSTOMER]]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER]);
  server.close();
  await pool.end();
});

test("an agent's sign-in lasts at least 24 hours and its renewal key a year", async () => {
  const { accessToken, refreshToken } = await issueTokens(AGENT, "agent");
  const a = claims(accessToken);
  assert.ok(a.exp - a.iat >= 24 * 3600, `agent access token lasts ${a.exp - a.iat}s`);
  const row = await queryOne<{ expires_at: Date }>(`SELECT expires_at FROM refresh_tokens WHERE token_hash=$1`, [hash(refreshToken)]);
  assert.ok(row!.expires_at.getTime() - Date.now() > 300 * 24 * 3600 * 1000, "renewal key valid for about a year");
  const r = claims(refreshToken);
  assert.ok(r.exp - r.iat >= 300 * 24 * 3600);
});

test("a renewal whose reply was lost is forgiven once, then the old key is dead", async () => {
  const { refreshToken: r1 } = await issueTokens(AGENT, "agent");
  const first = await refresh(r1);
  assert.equal(first.status, 200);
  // The phone never got `first` and tries r1 again: still signed in.
  const again = await refresh(r1);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(again.body.refreshToken);
  // A third use of r1 is refused (claimed once only).
  assert.equal((await refresh(r1)).status, 401);
  // The new key keeps working.
  assert.equal((await refresh(again.body.refreshToken)).status, 200);
});

test("agent phones get 5 minutes (Android may pause the app), other accounts 60 seconds", async () => {
  const { refreshToken: a1 } = await issueTokens(AGENT, "agent");
  assert.equal((await refresh(a1)).status, 200);
  await rotatedAgo(a1, 4 * 60);
  assert.equal((await refresh(a1)).status, 200, "agent: 4 minutes later still forgiven");

  const { refreshToken: a2 } = await issueTokens(AGENT, "agent");
  assert.equal((await refresh(a2)).status, 200);
  await rotatedAgo(a2, 6 * 60);
  assert.equal((await refresh(a2)).status, 401, "agent: over 5 minutes is refused");

  const { refreshToken: c1 } = await issueTokens(CUSTOMER, "customer");
  assert.equal((await refresh(c1)).status, 200);
  await rotatedAgo(c1, 2 * 60);
  assert.equal((await refresh(c1)).status, 401, "customer: 60 seconds as before");
});

test("Logout is final: a logged-out key never works again, even right after a renewal", async () => {
  const { refreshToken: k } = await issueTokens(AGENT, "agent");
  const res = await fetch(`${base}/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: k }) });
  assert.equal(res.status, 200);
  assert.equal((await refresh(k)).status, 401);

  const { refreshToken: x } = await issueTokens(AGENT, "agent");
  assert.equal((await refresh(x)).status, 200); // x was just used up by a renewal...
  await fetch(`${base}/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: x }) });
  assert.equal((await refresh(x)).status, 401, "...and Logout on it removes the lost-reply window");
});

test("a suspended agent is still signed out on the next renewal", async () => {
  const { refreshToken } = await issueTokens(AGENT, "agent");
  await query(`UPDATE agents SET status='suspended' WHERE id=$1`, [AGENT]);
  try {
    assert.equal((await refresh(refreshToken)).status, 401);
  } finally {
    await query(`UPDATE agents SET status='active' WHERE id=$1`, [AGENT]);
  }
});

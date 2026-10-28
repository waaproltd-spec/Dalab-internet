// Run against a freshly migrated local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false JWT_SECRET=... \
//     npx tsx --test --test-force-exit src/routes/__tests__/refreshTokens.test.ts
//
// Refresh-token rotation (POST /auth/refresh): a session keeps working
// across refreshes, a token rotated moments ago is accepted once more (lost
// response, a retry, a second web tab), and nothing else is: logout,
// device removal, password reset, deletion and stale tokens stay rejected.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { hashPassword } from "../../auth/crypto.js";
import { authRouter } from "../auth.routes.js";
import { devicesRouter } from "../devices.routes.js";

const app = express();
app.use(express.json());
app.use(authRouter);
app.use(devicesRouter);
let server: http.Server;
let base: string;
const CUSTOMER = randomUUID();
const PHONE = "252619990001";
const PASSWORD = "Refresh-test-123";

before(async () => {
  await query(`INSERT INTO customers (id, phone, name, password_hash) VALUES ($1,$2,'Refresh Tester',$3)`, [CUSTOMER, PHONE, await hashPassword(PASSWORD)]);
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

async function call(method: string, p: string, body?: unknown, token?: string) {
  const res = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function login(deviceId: string) {
  const r = await call("POST", "/auth/login", { identifier: PHONE, password: PASSWORD, device: { deviceId, platform: "web" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { accessToken: string; refreshToken: string };
}
const refresh = (refreshToken: string) => call("POST", "/auth/refresh", { refreshToken });

test("a session keeps refreshing: each refresh returns a new working pair", async () => {
  const s = await login("dev-chain");
  let rt = s.refreshToken;
  for (let i = 0; i < 3; i++) {
    const r = await refresh(rt);
    assert.equal(r.status, 200);
    assert.ok(r.body.accessToken && r.body.refreshToken);
    assert.notEqual(r.body.refreshToken, rt);
    rt = r.body.refreshToken;
  }
});

test("a just-rotated token is accepted once more (lost response / retry / second tab), not twice", async () => {
  const s = await login("dev-retry");
  const first = await refresh(s.refreshToken);
  assert.equal(first.status, 200);
  // The app never got `first` (response lost) and retries with the old token.
  const retry = await refresh(s.refreshToken);
  assert.equal(retry.status, 200, "the retry keeps the session instead of logging out");
  assert.equal((await refresh(retry.body.refreshToken)).status, 200, "the pair from the retry works");
  assert.equal((await refresh(first.body.refreshToken)).status, 200, "and so does the pair the other tab got");
  assert.equal((await refresh(s.refreshToken)).status, 401, "but the old token can't be used a third time");
});

test("the reuse window closes after 60 seconds", async () => {
  const s = await login("dev-window");
  assert.equal((await refresh(s.refreshToken)).status, 200);
  await query(`UPDATE refresh_tokens SET rotated_at = now() - interval '61 seconds' WHERE rotated_at IS NOT NULL AND subject_id=$1`, [CUSTOMER]);
  assert.equal((await refresh(s.refreshToken)).status, 401);
});

test("logout ends the session for good, with no reuse window", async () => {
  const s = await login("dev-logout");
  const r = await refresh(s.refreshToken);
  assert.equal((await call("POST", "/auth/logout", { refreshToken: r.body.refreshToken })).status, 200);
  assert.equal((await refresh(r.body.refreshToken)).status, 401, "the logged-out token is dead");
  const row = await queryOne<any>(`SELECT revoked, rotated_at FROM refresh_tokens WHERE subject_id=$1 AND device_id='dev-logout' ORDER BY created_at DESC LIMIT 1`, [CUSTOMER]);
  assert.equal(row.revoked, true);
  assert.equal(row.rotated_at, null);
});

test("removing a device ends its session, even a token rotated seconds ago", async () => {
  const s = await login("dev-remove");
  const r = await refresh(s.refreshToken); // s.refreshToken is now inside its reuse window
  const dev = await queryOne<any>(`SELECT id FROM customer_devices WHERE customer_id=$1 AND device_id='dev-remove'`, [CUSTOMER]);
  assert.equal((await call("DELETE", `/customer/devices/${dev.id}`, undefined, r.body.accessToken)).status, 200);
  assert.equal((await refresh(r.body.refreshToken)).status, 401, "current token rejected");
  assert.equal((await refresh(s.refreshToken)).status, 401, "the just-rotated one gets no grace either");
});

test("invalid, wrong-type and expired tokens are rejected", async () => {
  assert.equal((await refresh("not-a-token")).status, 401);
  const s = await login("dev-invalid");
  assert.equal((await refresh(s.accessToken)).status, 401, "an access token can't be used to refresh");
  await query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE subject_id=$1 AND device_id='dev-invalid'`, [CUSTOMER]);
  assert.equal((await refresh(s.refreshToken)).status, 401, "an expired session needs a new login");
});

test("password reset and other revocations clear the reuse window", async () => {
  const s = await login("dev-reset");
  assert.equal((await refresh(s.refreshToken)).status, 200);
  // Same statement the password-reset/account-deletion paths run.
  await query(`UPDATE refresh_tokens SET revoked=true, rotated_at=NULL WHERE subject_id=$1`, [CUSTOMER]);
  assert.equal((await refresh(s.refreshToken)).status, 401);
});

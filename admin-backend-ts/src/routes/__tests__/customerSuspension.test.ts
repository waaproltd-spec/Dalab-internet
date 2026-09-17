// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time) -- see matchTemplateByName.test.ts's own
// header for the exact command.
//
// Covers the Customer App's suspended-account feature end to end at the
// HTTP layer: /auth/login and /auth/register must keep succeeding for a
// suspended (customers.status='blocked') account rather than refusing a
// session outright, every other protected customer route must reject them
// (customerSuspensionMiddleware, registered ahead of every router in
// server.ts), Agent Support (/support/...) and GET /customer/status must
// stay reachable regardless, and access must be restored the moment an
// Admin/Agent flips status back to 'active' -- with no server restart or
// new login required.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { authRouter } from "../auth.routes.js";
import { customersRouter } from "../customers.routes.js";
import { customerSuspensionMiddleware, requireAuth } from "../../auth/middleware.js";
import { sendJson } from "../../utils/camelCase.js";

const app = express();
app.use(express.json());
app.use(customerSuspensionMiddleware);
app.use(authRouter);
app.use(customersRouter);
// A minimal stand-in for support.routes.ts's own requireAuth("customer")
// routes -- proves the middleware's /support exemption works without
// pulling in Agent Support's full feature set (push, SMS media, ...),
// which already has its own tests.
app.get("/support/ping", requireAuth("customer"), (req, res) => sendJson(res, 200, { ok: true }));

let server: http.Server;
let baseUrl: string;

const PHONE = "252611000111";
const PASSWORD = "correct horse battery staple";

async function cleanup() {
  await query(`DELETE FROM customers WHERE phone=$1`, [PHONE]);
}

before(async () => {
  await cleanup();
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(cleanup);

async function register(): Promise<{ accessToken: string; status: string; id: string }> {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD, name: "Test Customer" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as any;
  return { accessToken: body.accessToken, status: body.customer.status, id: body.customer.id };
}

test("a brand-new account registers as active", async () => {
  const { status } = await register();
  assert.equal(status, "active");
});

test("login and register both succeed for a suspended account, and report status:'blocked' -- never a flat 403 refusal to sign in", async () => {
  const { id } = await register();
  await query(`UPDATE customers SET status='blocked' WHERE id=$1`, [id]);

  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: PHONE, password: PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  const loginBody = (await loginRes.json()) as any;
  assert.equal(loginBody.customer.status, "blocked");
  assert.ok(loginBody.accessToken);
});

test("a suspended customer's other protected calls are rejected with 403 ACCOUNT_SUSPENDED", async () => {
  const { accessToken, id } = await register();
  await query(`UPDATE customers SET status='blocked' WHERE id=$1`, [id]);

  const res = await fetch(`${baseUrl}/customer/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as any;
  assert.equal(body.code, "ACCOUNT_SUSPENDED");
});

test("Agent Support stays reachable for a suspended customer", async () => {
  const { accessToken, id } = await register();
  await query(`UPDATE customers SET status='blocked' WHERE id=$1`, [id]);

  const res = await fetch(`${baseUrl}/support/ping`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.status, 200);
});

test("GET /customer/status stays reachable while suspended and reports the live value", async () => {
  const { accessToken, id } = await register();

  const beforeRes = await fetch(`${baseUrl}/customer/status`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(beforeRes.status, 200);
  assert.equal((await beforeRes.json() as any).status, "active");

  await query(`UPDATE customers SET status='blocked' WHERE id=$1`, [id]);
  const afterRes = await fetch(`${baseUrl}/customer/status`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(afterRes.status, 200);
  assert.equal((await afterRes.json() as any).status, "blocked");
});

test("reactivation (blocked -> active) restores access immediately, same token, no new login", async () => {
  const { accessToken, id } = await register();
  await query(`UPDATE customers SET status='blocked' WHERE id=$1`, [id]);

  const blockedRes = await fetch(`${baseUrl}/customer/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(blockedRes.status, 403);

  await query(`UPDATE customers SET status='active' WHERE id=$1`, [id]);
  const restoredRes = await fetch(`${baseUrl}/customer/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(restoredRes.status, 200);
});

test("an active customer's normal calls are completely unaffected", async () => {
  const { accessToken } = await register();
  const res = await fetch(`${baseUrl}/customer/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(res.status, 200);
});

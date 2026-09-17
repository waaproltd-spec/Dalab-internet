// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers the Agent App's Customer Management
// feature: an Agent gets the same customer visibility and management power
// as Admin -- view every customer (not scoped to "this agent's own"),
// search, view details/order history, Suspend/Reactivate, and full PIN
// reset (generate/set/clear), matching (widening, for PIN, per explicit
// product decision) what Admin/Super Admin already have in customers.routes.ts.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { verifyPassword } from "../../auth/crypto.js";
import { customersRouter } from "../customers.routes.js";

const app = express();
app.use(express.json());
app.use(customersRouter);

let server: http.Server;
let baseUrl: string;
let agentToken: string;

const AGENT_ID = randomUUID();
const AGENT_PHONE = "617500701";
const CUSTOMER_A_ID = randomUUID();
const CUSTOMER_A_PHONE = "617500801";
const CUSTOMER_B_ID = randomUUID();
const CUSTOMER_B_PHONE = "617500802";
const COMPANY_ID = "test-agent-customer-mgmt-co";
let packageId: string;

before(async () => {
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Agent Customer Mgmt Test Agent','x')`, [AGENT_ID, AGENT_PHONE]);
  agentToken = signAccessToken(AGENT_ID, "agent");

  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Agent Mgmt Customer A')`, [CUSTOMER_A_ID, CUSTOMER_A_PHONE]);
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Agent Mgmt Customer B')`, [CUSTOMER_B_ID, CUSTOMER_B_PHONE]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Agent Mgmt Test Co',1,'#123456') ON CONFLICT (id) DO NOTHING`, [COMPANY_ID]);
  const pkg = await queryOne<{ id: string }>(
    `INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,'test','Agent Mgmt Test Package',5.00) RETURNING id`,
    [randomUUID(), COMPANY_ID]
  );
  packageId = pkg!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await query(`DELETE FROM orders WHERE customer_id IN ($1,$2)`, [CUSTOMER_A_ID, CUSTOMER_B_ID]);
  await query(`DELETE FROM packages WHERE id=$1`, [packageId]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id IN ($1,$2)`, [CUSTOMER_A_ID, CUSTOMER_B_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(async () => {
  await query(`DELETE FROM orders WHERE customer_id IN ($1,$2)`, [CUSTOMER_A_ID, CUSTOMER_B_ID]);
  await query(`UPDATE customers SET status='active', pin_hash=NULL WHERE id IN ($1,$2)`, [CUSTOMER_A_ID, CUSTOMER_B_ID]);
});

function authed(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" } });
}

async function asJson(res: Response): Promise<any> {
  return res.json();
}

async function insertOrder(customerId: string, amount: number, status: string) {
  const id = `TEST-${randomUUID()}`;
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,${status === "completed" ? "now()" : "NULL"})`,
    [id, customerId, COMPANY_ID, packageId, amount, status]
  );
  return id;
}

// ---------------- Visibility ----------------

test("GET /agent/customers requires agent auth", async () => {
  const res = await fetch(`${baseUrl}/agent/customers`);
  assert.equal(res.status, 401);
});

test("GET /agent/customers returns every customer, not scoped to any one agent", async () => {
  const res = await authed("/agent/customers");
  const body = await asJson(res);
  const ids = body.map((c: any) => c.id);
  assert.ok(ids.includes(CUSTOMER_A_ID));
  assert.ok(ids.includes(CUSTOMER_B_ID));
});

test("GET /agent/customers?search matches by name or phone across all customers", async () => {
  const byName = await asJson(await authed(`/agent/customers?search=${encodeURIComponent("Agent Mgmt Customer A")}`));
  assert.deepEqual(byName.map((c: any) => c.id), [CUSTOMER_A_ID]);

  const byPhone = await asJson(await authed(`/agent/customers?search=${CUSTOMER_B_PHONE}`));
  assert.deepEqual(byPhone.map((c: any) => c.id), [CUSTOMER_B_ID]);
});

// ---------------- Detail + order history ----------------

test("GET /agent/customers/:id returns 404 for an unknown customer", async () => {
  const res = await authed(`/agent/customers/${randomUUID()}`);
  assert.equal(res.status, 404);
});

test("GET /agent/customers/:id includes real completed-order totals and pinSet, never the PIN itself", async () => {
  await insertOrder(CUSTOMER_A_ID, 10, "completed");
  await insertOrder(CUSTOMER_A_ID, 5, "completed");
  await insertOrder(CUSTOMER_A_ID, 99, "pending"); // must not count

  const res = await authed(`/agent/customers/${CUSTOMER_A_ID}`);
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(body.id, CUSTOMER_A_ID);
  assert.equal(body.name, "Agent Mgmt Customer A");
  assert.equal(body.totalOrders, 2);
  assert.equal(body.totalSpent, 15);
  assert.equal(body.pinSet, false);
  assert.equal("pin" in body, false);
  assert.equal("pinHash" in body, false);
});

test("GET /agent/customers/:id/orders returns this customer's real orders, newest first, and 404s for an unknown customer", async () => {
  const first = await insertOrder(CUSTOMER_A_ID, 8, "completed");
  await new Promise((r) => setTimeout(r, 5));
  const second = await insertOrder(CUSTOMER_A_ID, 3, "pending");
  await insertOrder(CUSTOMER_B_ID, 20, "completed"); // must not leak into A's history

  const res = await authed(`/agent/customers/${CUSTOMER_A_ID}/orders`);
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.deepEqual(body.map((o: any) => o.id), [second, first]);
  assert.equal(body[0].packageName, "Agent Mgmt Test Package");
  assert.equal(body[0].companyName, "Agent Mgmt Test Co");

  const notFound = await authed(`/agent/customers/${randomUUID()}/orders`);
  assert.equal(notFound.status, 404);
});

// ---------------- Edit name/phone ----------------

test("PUT /agent/customers/:id edits name and phone, matching the Admin route", async () => {
  const newPhone = "617500899";
  const res = await authed(`/agent/customers/${CUSTOMER_A_ID}`, {
    method: "PUT",
    body: JSON.stringify({ name: "Renamed By Agent", phone: newPhone }),
  });
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(body.name, "Renamed By Agent");
  assert.equal(body.phone, newPhone);

  // Restore so later tests keep using the original fixture phone.
  await query(`UPDATE customers SET name='Agent Mgmt Customer A', phone=$1 WHERE id=$2`, [CUSTOMER_A_PHONE, CUSTOMER_A_ID]);
});

test("PUT /agent/customers/:id 404s for an unknown customer and rejects a duplicate phone", async () => {
  assert.equal((await authed(`/agent/customers/${randomUUID()}`, { method: "PUT", body: JSON.stringify({ name: "x" }) })).status, 404);

  const dup = await authed(`/agent/customers/${CUSTOMER_A_ID}`, { method: "PUT", body: JSON.stringify({ phone: CUSTOMER_B_PHONE }) });
  assert.equal(dup.status, 409);
});

// ---------------- Wallet numbers + exchange limits (customer-management parity) ----------------

test("PUT /agent/customers/:id/wallet-numbers sets and clears an EVC Plus/eDahab pair, matching the Admin route", async () => {
  const setRes = await authed(`/agent/customers/${CUSTOMER_A_ID}/wallet-numbers`, {
    method: "PUT",
    body: JSON.stringify({ evcPlusName: "Agent Mgmt Customer A", evcPlusNumber: "617500801" }),
  });
  assert.equal(setRes.status, 200);
  const setBody = await asJson(setRes);
  assert.equal(setBody.evcPlusNumber, "617500801");
  assert.equal(setBody.evcPlusName, "Agent Mgmt Customer A");

  const clearRes = await authed(`/agent/customers/${CUSTOMER_A_ID}/wallet-numbers`, {
    method: "PUT",
    body: JSON.stringify({ evcPlusName: null, evcPlusNumber: null }),
  });
  assert.equal(clearRes.status, 200);
  const clearBody = await asJson(clearRes);
  assert.equal(clearBody.evcPlusNumber, null);
});

test("PUT /agent/customers/:id/wallet-numbers rejects a lopsided name/number pair and 404s for an unknown customer", async () => {
  const lopsided = await authed(`/agent/customers/${CUSTOMER_A_ID}/wallet-numbers`, {
    method: "PUT",
    body: JSON.stringify({ evcPlusName: "Only A Name" }),
  });
  assert.equal(lopsided.status, 400);

  const notFound = await authed(`/agent/customers/${randomUUID()}/wallet-numbers`, {
    method: "PUT",
    body: JSON.stringify({ evcPlusName: "x", evcPlusNumber: "617500801" }),
  });
  assert.equal(notFound.status, 404);
});

test("PUT /agent/customers/:id/exchange-limits sets custom limits, matching the Admin route", async () => {
  const res = await authed(`/agent/customers/${CUSTOMER_A_ID}/exchange-limits`, {
    method: "PUT",
    body: JSON.stringify({ dailyLimit: 250, monthlyLimit: 1000, yearlyLimit: 5000 }),
  });
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(body.exchangeDailyLimit, "250.00");
  assert.equal(body.hasHigherExchangeLimit, true);

  const reset = await authed(`/agent/customers/${CUSTOMER_A_ID}/exchange-limits`, {
    method: "PUT",
    body: JSON.stringify({ dailyLimit: null, monthlyLimit: null, yearlyLimit: null }),
  });
  assert.equal((await asJson(reset)).hasHigherExchangeLimit, false);
});

test("PUT /agent/customers/:id/exchange-limits rejects a non-positive limit and 404s for an unknown customer", async () => {
  const invalid = await authed(`/agent/customers/${CUSTOMER_A_ID}/exchange-limits`, {
    method: "PUT",
    body: JSON.stringify({ dailyLimit: -5 }),
  });
  assert.equal(invalid.status, 400);

  const notFound = await authed(`/agent/customers/${randomUUID()}/exchange-limits`, {
    method: "PUT",
    body: JSON.stringify({ dailyLimit: 10 }),
  });
  assert.equal(notFound.status, 404);
});

test("GET /agent/customers/:id exposes macaashPoints, walletNumbers, and exchange limits, same columns Admin sees", async () => {
  const res = await authed(`/agent/customers/${CUSTOMER_A_ID}`);
  const body = await asJson(res);
  assert.ok("macaashPoints" in body);
  assert.ok("evcPlusNumber" in body);
  assert.ok("edahabNumber" in body);
  assert.ok("exchangeDailyLimitEffective" in body);
});

// ---------------- Suspend / Reactivate ----------------

test("PUT /agent/customers/:id/block toggles active <-> blocked", async () => {
  const suspend = await asJson(await authed(`/agent/customers/${CUSTOMER_A_ID}/block`, { method: "PUT" }));
  assert.equal(suspend.status, "blocked");

  const reactivate = await asJson(await authed(`/agent/customers/${CUSTOMER_A_ID}/block`, { method: "PUT" }));
  assert.equal(reactivate.status, "active");
});

test("PUT /agent/customers/:id/block 404s for an unknown customer", async () => {
  const res = await authed(`/agent/customers/${randomUUID()}/block`, { method: "PUT" });
  assert.equal(res.status, 404);
});

// ---------------- PIN management ----------------

test("agent PIN lifecycle: unset -> set a specific PIN -> generate replaces it -> clear", async () => {
  const initialStatus = await asJson(await authed(`/agent/customers/${CUSTOMER_A_ID}/pin-status`));
  assert.equal(initialStatus.isSet, false);

  const setRes = await authed(`/agent/customers/${CUSTOMER_A_ID}/pin`, { method: "PUT", body: JSON.stringify({ pin: "4321" }) });
  assert.equal(setRes.status, 200);
  const afterSet = await asJson(await authed(`/agent/customers/${CUSTOMER_A_ID}/pin-status`));
  assert.equal(afterSet.isSet, true);
  const rowAfterSet = await queryOne<{ pin_hash: string }>(`SELECT pin_hash FROM customers WHERE id=$1`, [CUSTOMER_A_ID]);
  assert.ok(await verifyPassword("4321", rowAfterSet!.pin_hash));

  const genRes = await authed(`/agent/customers/${CUSTOMER_A_ID}/pin/generate`, { method: "POST" });
  assert.equal(genRes.status, 200);
  const genBody = await asJson(genRes);
  assert.match(genBody.pin, /^\d{4}$/);
  assert.equal(genBody.isSet, true);
  const rowAfterGen = await queryOne<{ pin_hash: string }>(`SELECT pin_hash FROM customers WHERE id=$1`, [CUSTOMER_A_ID]);
  assert.ok(await verifyPassword(genBody.pin, rowAfterGen!.pin_hash));
  assert.ok(!(await verifyPassword("4321", rowAfterGen!.pin_hash)), "the old PIN must stop working once a new one is generated");

  const clearRes = await authed(`/agent/customers/${CUSTOMER_A_ID}/pin`, { method: "DELETE" });
  assert.equal(clearRes.status, 200);
  const afterClear = await asJson(await authed(`/agent/customers/${CUSTOMER_A_ID}/pin-status`));
  assert.equal(afterClear.isSet, false);
});

test("PUT /agent/customers/:id/pin rejects a non-4-8-digit PIN", async () => {
  const res = await authed(`/agent/customers/${CUSTOMER_A_ID}/pin`, { method: "PUT", body: JSON.stringify({ pin: "12" }) });
  assert.equal(res.status, 400);
});

test("PIN routes 404 for an unknown customer", async () => {
  const id = randomUUID();
  assert.equal((await authed(`/agent/customers/${id}/pin-status`)).status, 404);
  assert.equal((await authed(`/agent/customers/${id}/pin`, { method: "PUT", body: JSON.stringify({ pin: "1234" }) })).status, 404);
  assert.equal((await authed(`/agent/customers/${id}/pin/generate`, { method: "POST" })).status, 404);
  assert.equal((await authed(`/agent/customers/${id}/pin`, { method: "DELETE" })).status, 404);
});

test("a customer token cannot reach any agent customer-management route", async () => {
  const customerToken = signAccessToken(CUSTOMER_A_ID, "customer");
  const res = await fetch(`${baseUrl}/agent/customers/${CUSTOMER_A_ID}/pin/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  assert.equal(res.status, 403);
});

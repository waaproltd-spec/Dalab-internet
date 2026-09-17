// Run against a real local Postgres test database (see verifyPaymentLedgerGap.test.ts
// header for the exact command). Covers Customer-management parity: an Agent
// gets the same "view payment details and payment status" power Admin has
// (GET /admin/payment-transactions, GET /admin/payment-transactions/:id/timeline)
// scoped to one customer's own orders, via the new
// GET /agent/customers/:id/payment-transactions and
// GET /agent/payment-transactions/:id/timeline routes.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { smsLogsRouter } from "../smsLogs.routes.js";

const COMPANY_ID = "test-agent-pt-co";
const CATEGORY_ID = randomUUID();
const CUSTOMER_A_ID = randomUUID();
const CUSTOMER_B_ID = randomUUID();
const AGENT_ID = randomUUID();

let packageId: string;
let agentToken: string;
const app = express();
app.use(express.json());
app.use(smsLogsRouter);
let server: http.Server;
let baseUrl: string;

function makeOrderId(): string {
  return "TEST" + Math.floor(100000000 + Math.random() * 900000000);
}

let nextTestAmount = 10;

async function insertOrder(customerId: string): Promise<string> {
  const id = makeOrderId();
  // Distinct amount per call -- a unique index blocks two 'pending' orders
  // with otherwise-identical content (same customer/company/package/amount/
  // sender/receiver) as accidental double-submits.
  const amount = nextTestAmount++;
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','customer_app')`,
    [id, customerId, COMPANY_ID, packageId, amount, "252619999129", "252619991229"]
  );
  return id;
}

async function insertPaymentTransaction(orderId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO payment_transactions (id, order_id, customer_phone, amount, status) VALUES (gen_random_uuid(),$1,'252619999129',10,'pending') RETURNING id`,
    [orderId]
  );
  return row!.id;
}

function authed(path: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${agentToken}` } });
}

before(async () => {
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TEST%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id IN ($1,$2)`, [CUSTOMER_A_ID, CUSTOMER_B_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Agent PT Co',1,'#000000')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Test Package',10) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252619999129')`, [CUSTOMER_A_ID]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252619999130')`, [CUSTOMER_B_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699003399','Test PT Agent','x')`, [AGENT_ID]);
  agentToken = signAccessToken(AGENT_ID, "agent");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TEST%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TEST%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id IN ($1,$2)`, [CUSTOMER_A_ID, CUSTOMER_B_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await pool.end();
});

test("GET /agent/customers/:id/payment-transactions requires agent auth", async () => {
  const res = await fetch(`${baseUrl}/agent/customers/${CUSTOMER_A_ID}/payment-transactions`);
  assert.equal(res.status, 401);
});

test("GET /agent/customers/:id/payment-transactions returns only this customer's transactions, newest first, and 404s for an unknown customer", async () => {
  const orderA1 = await insertOrder(CUSTOMER_A_ID);
  await new Promise((r) => setTimeout(r, 5));
  const orderA2 = await insertOrder(CUSTOMER_A_ID);
  const orderB = await insertOrder(CUSTOMER_B_ID);
  const txA1 = await insertPaymentTransaction(orderA1);
  const txA2 = await insertPaymentTransaction(orderA2);
  await insertPaymentTransaction(orderB);

  const res = await authed(`/agent/customers/${CUSTOMER_A_ID}/payment-transactions`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any[];
  assert.deepEqual(
    body.map((r) => r.id),
    [txA2, txA1]
  );

  const notFound = await authed(`/agent/customers/${randomUUID()}/payment-transactions`);
  assert.equal(notFound.status, 404);
});

test("GET /agent/payment-transactions/:id/timeline returns the transaction, its order, dial attempts, and activity, and 404s for an unknown id", async () => {
  const orderId = await insertOrder(CUSTOMER_A_ID);
  const txId = await insertPaymentTransaction(orderId);

  const res = await authed(`/agent/payment-transactions/${txId}/timeline`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.transaction.id, txId);
  assert.equal(body.order.id, orderId);
  assert.ok(Array.isArray(body.dialAttempts));
  assert.ok(Array.isArray(body.activity));

  const notFound = await authed(`/agent/payment-transactions/${randomUUID()}/timeline`);
  assert.equal(notFound.status, 404);
});

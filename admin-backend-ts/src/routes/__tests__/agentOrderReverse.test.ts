// Run against a real local Postgres test database (see verifyPaymentLedgerGap.test.ts
// header for the exact command). Covers Customer-management parity: an Agent
// gets the same order-reversal power Admin has (POST /admin/orders/:id/reverse)
// via the new POST /agent/orders/:id/reverse, including the same Macaash
// points claw-back.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ordersRouter } from "../orders.routes.js";

const COMPANY_ID = "test-agent-reverse-co";
const CATEGORY_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const AGENT_ID = randomUUID();

let packageId: string;
let agentToken: string;
const app = express();
app.use(express.json());
app.use(ordersRouter);
let server: http.Server;
let baseUrl: string;

function makeOrderId(): string {
  return "TEST" + Math.floor(100000000 + Math.random() * 900000000);
}

async function insertCompletedOrderWithPoints(points: number): Promise<string> {
  const id = makeOrderId();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'completed','customer_app',now())`,
    [id, CUSTOMER_ID, COMPANY_ID, packageId, 10, "252619999129", "252619991229"]
  );
  await query(`INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason, kind) VALUES ($1,$2,$3,$4,'test earn','earn')`, [
    randomUUID(),
    CUSTOMER_ID,
    id,
    points,
  ]);
  await query(`UPDATE customers SET macaash_points = macaash_points + $1 WHERE id=$2`, [points, CUSTOMER_ID]);
  return id;
}

function reverseAsAgent(orderId: string) {
  return fetch(`${baseUrl}/agent/orders/${orderId}/reverse`, {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}` },
  });
}

before(async () => {
  await query(`DELETE FROM macaash_transactions WHERE customer_id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Agent Reverse Co',1,'#000000')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Test Package',10) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;
  await query(`INSERT INTO customers (id, phone, macaash_points) VALUES ($1,'252619999129',0)`, [CUSTOMER_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699002299','Test Reverse Agent','x')`, [AGENT_ID]);
  agentToken = signAccessToken(AGENT_ID, "agent");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await query(`DELETE FROM macaash_transactions WHERE customer_id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`UPDATE customers SET macaash_points=0 WHERE id=$1`, [CUSTOMER_ID]);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await query(`DELETE FROM macaash_transactions WHERE customer_id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await pool.end();
});

test("POST /agent/orders/:id/reverse requires agent auth", async () => {
  const res = await fetch(`${baseUrl}/agent/orders/${makeOrderId()}/reverse`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("POST /agent/orders/:id/reverse cancels the order and claws back credited Macaash points, matching the Admin route", async () => {
  const orderId = await insertCompletedOrderWithPoints(5);
  const res = await reverseAsAgent(orderId);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.status, "cancelled");

  const order = await queryOne<{ reversed_at: string | null }>(`SELECT reversed_at FROM orders WHERE id=$1`, [orderId]);
  assert.ok(order!.reversed_at, "reversed_at must be set");

  const customer = await queryOne<{ macaash_points: number }>(`SELECT macaash_points FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  assert.equal(customer!.macaash_points, 0);
});

test("POST /agent/orders/:id/reverse 404s for an unknown order and 409s if already reversed", async () => {
  const notFound = await reverseAsAgent(makeOrderId());
  assert.equal(notFound.status, 404);

  const orderId = await insertCompletedOrderWithPoints(2);
  const first = await reverseAsAgent(orderId);
  assert.equal(first.status, 200);
  const second = await reverseAsAgent(orderId);
  assert.equal(second.status, 409);
});

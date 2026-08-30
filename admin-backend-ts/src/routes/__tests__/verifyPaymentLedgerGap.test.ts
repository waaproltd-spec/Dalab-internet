// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/verifyPaymentLedgerGap.test.ts
//
// Regression coverage for a real production bug: the Agent App's manual
// "Execute SIM" dial button (UssdOrchestrator.executeManually) calls
// POST /agent/orders/:id/verify-payment directly, with no prior SMS match
// (VerifyPaymentRequest(null) — see UssdOrchestrator.kt:152). If the network
// drops between that request succeeding server-side (order flips to
// in_progress, USSD is generated) and its response reaching the app, the
// dial step that would normally follow never runs — and because this path
// never created a payment_transactions ledger row, the order became
// permanently invisible to BOTH the Agent App's self-heal sweep
// (GET /agent/orders/self-heal-candidates requires an existing
// payment_transactions row, see ussd.routes.ts) and the admin dashboard's
// manual "Send to Agent" recovery (POST /admin/orders/:id/recover, same
// requirement). Confirmed in production: a real order sat in_progress with
// USSD generated, zero dial attempts, zero payment_transactions rows, and
// "Send to Agent" returned "No verified payment found for this order —
// nothing to recover."
//
// The fix makes /agent/orders/:id/verify-payment ensure a
// payment_transactions row exists for the order BEFORE ever flipping it to
// in_progress, guarded so it never creates a duplicate for an order that
// already has one (the normal automatic SMS-matched path already gets its
// row at SMS-ingest time).
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

const COMPANY_ID = "test-verify-ledger-co";
const CATEGORY_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const AGENT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const DEVICE_ID = "test-verify-ledger-device";

let packageId: string;
let agentToken: string;
let adminToken: string;
const app = express();
app.use(express.json());
app.use(ordersRouter);
let server: http.Server;
let baseUrl: string;

function makeOrderId(): string {
  return "TEST" + Math.floor(100000000 + Math.random() * 900000000);
}

async function insertPendingOrder(): Promise<string> {
  const id = makeOrderId();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','customer_app')`,
    [id, CUSTOMER_ID, COMPANY_ID, packageId, 22.85, "252619999129", "252619991229"]
  );
  return id;
}

function verifyPayment(orderId: string, smsLogId: string | null = null) {
  return fetch(`${baseUrl}/agent/orders/${orderId}/verify-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ smsLogId }),
  });
}

function recover(orderId: string) {
  return fetch(`${baseUrl}/admin/orders/${orderId}/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
  });
}

async function paymentTxRowsFor(orderId: string) {
  return query<{ id: string; status: string; sms_log_id: string | null }>(
    `SELECT id, status, sms_log_id FROM payment_transactions WHERE order_id=$1`,
    [orderId]
  );
}

before(async () => {
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TEST%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone=$2`, [CUSTOMER_ID, "252619999129"]);
  await query(`DELETE FROM agents WHERE id=$1 OR device_id=$2`, [AGENT_ID, DEVICE_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1 OR email=$2`, [ADMIN_ID, "verify-ledger-test-admin@example.com"]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Verify Ledger Co',1,'#000000')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Test Package',22.85) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252619999129')`, [CUSTOMER_ID]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Test Verify Ledger Device')`, [DEVICE_ID]);
  await query(`DELETE FROM agents WHERE phone=$1`, ["252699001199"]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699001199','Test Agent','x',$2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'verify-ledger-test-admin@example.com','x','super_admin')`, [
    ADMIN_ID,
  ]);

  agentToken = signAccessToken(AGENT_ID, "agent");
  adminToken = signAccessToken(ADMIN_ID, "super_admin");

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
  await query(`DELETE FROM sms_logs WHERE sender='192' AND body='Test SMS body'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone=$2`, [CUSTOMER_ID, "252619999129"]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [ADMIN_ID]);
  await pool.end();
});

test("manual dial verify-payment (no SMS match) creates a pending ledger row before flipping the order to in_progress", async () => {
  const orderId = await insertPendingOrder();
  assert.deepEqual(await paymentTxRowsFor(orderId), []);

  const res = await verifyPayment(orderId);
  assert.equal(res.status, 200);

  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "in_progress");

  const rows = await paymentTxRowsFor(orderId);
  assert.equal(rows.length, 1, "expected exactly one payment_transactions row to be created");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].sms_log_id, null);
});

test("a network drop after verify-payment succeeds no longer leaves the order permanently unrecoverable", async () => {
  const orderId = await insertPendingOrder();

  // Simulates the exact production failure: the server-side verify-payment
  // call succeeds (this is all a dropped response after this point would
  // have skipped) — the app never gets to call dialWithRetry().
  const verifyRes = await verifyPayment(orderId);
  assert.equal(verifyRes.status, 200);

  // Before the fix, this returned 400 "No verified payment found for this
  // order — nothing to recover" because no payment_transactions row
  // existed. It must now succeed (or at minimum never return that specific
  // "nothing to recover" error), since a ledger row now exists.
  const recoverRes = await recover(orderId);
  const body: any = await recoverRes.json();
  assert.notEqual(recoverRes.status, 400, `recover unexpectedly failed: ${JSON.stringify(body)}`);
  assert.ok(
    !("error" in body) || !String(body.error).includes("nothing to recover"),
    `recover still reports no recoverable payment: ${JSON.stringify(body)}`
  );
});

test("verify-payment never creates a duplicate ledger row when one already exists (automatic SMS-matched path)", async () => {
  const orderId = await insertPendingOrder();
  const smsLogId = (
    await queryOne<{ id: string }>(
      `INSERT INTO sms_logs (sender, body, matched_order_id) VALUES ('192','Test SMS body',$1) RETURNING id`,
      [orderId]
    )
  )!.id;
  // Simulates the row the live SMS-ingest path (createPaymentTransaction in
  // smsLogs.routes.ts) already creates before verify-payment is ever called
  // for an automatically-matched order.
  await query(
    `INSERT INTO payment_transactions (id, sms_log_id, order_id, customer_phone, amount, payment_timestamp, status)
     VALUES (gen_random_uuid(),$1,$2,'252619999129',22.85,now(),'pending')`,
    [smsLogId, orderId]
  );

  const res = await verifyPayment(orderId, smsLogId);
  assert.equal(res.status, 200);

  const rows = await paymentTxRowsFor(orderId);
  assert.equal(rows.length, 1, "verify-payment must not create a second ledger row for an order that already has one");
  assert.equal(rows[0].sms_log_id, smsLogId);
});

test("concurrent verify-payment calls for the same order never create more than one ledger row", async () => {
  const orderId = await insertPendingOrder();

  const [a, b] = await Promise.all([verifyPayment(orderId), verifyPayment(orderId)]);
  // One of the two may lose the order's own pending->in_progress CAS race
  // (pre-existing, unrelated behavior) — what this test guards is strictly
  // the ledger row itself, which must never end up duplicated regardless.
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 409), `unexpected status pair: ${a.status}, ${b.status}`);

  const rows = await paymentTxRowsFor(orderId);
  assert.equal(rows.length, 1, `expected exactly one ledger row after a concurrent race, got ${rows.length}`);
});

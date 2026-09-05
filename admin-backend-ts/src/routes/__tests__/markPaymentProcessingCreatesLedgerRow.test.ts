// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/markPaymentProcessingCreatesLedgerRow.test.ts
//
// verifyPaymentLedgerGap.test.ts already covers the two known call sites
// (verify-payment, admin "Start Processing") that defensively pre-create a
// payment_transactions row before an order can ever reach
// in_progress+ussd_generated. This file covers the deeper fix: markPaymentProcessing
// itself (called from POST /agent/orders/:id/dial-attempts, the one place
// every dial attempt for every provider goes through) must create that row
// if it's ever missing when a dial attempt starts — rather than relying on
// every caller, present and future, to remember the guard. Simulates that
// gap directly: an order reaches in_progress+ussd_generated with NO
// payment_transactions row at all (bypassing verify-payment/Start Processing
// entirely), then a dial attempt starts for it.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ussdRouter } from "../ussd.routes.js";

const COMPANY_ID = "test-mpp-ledger-co";
const CATEGORY_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const AGENT_ID = randomUUID();
const DEVICE_ID = "test-mpp-ledger-device";

let packageId: string;
let agentToken: string;
const app = express();
app.use(express.json());
app.use(ussdRouter);
let server: http.Server;
let baseUrl: string;

function makeOrderId(): string {
  return "TESTMPP" + Math.floor(100000000 + Math.random() * 900000000);
}

// Deliberately does NOT go through verify-payment or "Start Processing" —
// this is what an order that reached in_progress+ussd_generated through some
// other, unguarded path would look like. No payment_transactions row exists
// for it at all going into the test.
async function insertInProgressOrderWithNoLedgerRow(): Promise<string> {
  const id = makeOrderId();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel, ussd_generated, ussd_generated_masked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'in_progress','customer_app','*727*619991229*2285*8233#','*727*619991229*2285*••••#')`,
    [id, CUSTOMER_ID, COMPANY_ID, packageId, 22.85, "252619999129", "252619991229"]
  );
  return id;
}

function startDialAttempt(orderId: string) {
  return fetch(`${baseUrl}/agent/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ simSlot: 1, ussdString: "*727*619991229*2285*8233#", attemptNumber: 1 }),
  });
}

async function paymentTxRowsFor(orderId: string) {
  return query<{ id: string; status: string; agent_device_id: string | null; sim_slot: number | null; ussd_dial_attempt_id: string | null }>(
    `SELECT id, status, agent_device_id, sim_slot, ussd_dial_attempt_id FROM payment_transactions WHERE order_id=$1`,
    [orderId]
  );
}

before(async () => {
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTMPP%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTMPP%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone=$2`, [CUSTOMER_ID, "252619999129"]);
  await query(`DELETE FROM agents WHERE id=$1 OR device_id=$2`, [AGENT_ID, DEVICE_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test MPP Ledger Co',1,'#000000')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Test Package',22.85) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252619999129')`, [CUSTOMER_ID]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Test MPP Ledger Device')`, [DEVICE_ID]);
  await query(`DELETE FROM agents WHERE phone=$1`, ["252699001299"]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699001299','Test Agent','x',$2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);

  agentToken = signAccessToken(AGENT_ID, "agent");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTMPP%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTMPP%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTMPP%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTMPP%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone=$2`, [CUSTOMER_ID, "252619999129"]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await pool.end();
});

test("starting a dial attempt for an order with NO existing ledger row creates one, in 'processing', instead of silently no-opping", async () => {
  const orderId = await insertInProgressOrderWithNoLedgerRow();
  assert.deepEqual(await paymentTxRowsFor(orderId), []);

  const res = await startDialAttempt(orderId);
  assert.equal(res.status, 201);

  const rows = await paymentTxRowsFor(orderId);
  assert.equal(rows.length, 1, "markPaymentProcessing must create exactly one ledger row when none existed");
  assert.equal(rows[0].status, "processing");
  assert.equal(rows[0].agent_device_id, DEVICE_ID);
  assert.equal(rows[0].sim_slot, 1);
  assert.ok(rows[0].ussd_dial_attempt_id, "the created row must record which dial attempt is handling it");
});

test("a second dial attempt for the same order never creates a duplicate ledger row", async () => {
  const orderId = await insertInProgressOrderWithNoLedgerRow();

  const first = await startDialAttempt(orderId);
  assert.equal(first.status, 201);
  const second = await fetch(`${baseUrl}/agent/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ simSlot: 1, ussdString: "*727*619991229*2285*8233#", attemptNumber: 2 }),
  });
  assert.equal(second.status, 201);

  const rows = await paymentTxRowsFor(orderId);
  assert.equal(rows.length, 1, "a retried/second dial attempt must reuse the same ledger row, never create a second one");
  assert.equal(rows[0].status, "processing");
});

test("markPaymentProcessing never overwrites an already-completed ledger row", async () => {
  const orderId = await insertInProgressOrderWithNoLedgerRow();
  await query(
    `INSERT INTO payment_transactions (id, order_id, customer_phone, amount, payment_timestamp, status)
     VALUES (gen_random_uuid(),$1,'252619999129',22.85,now(),'completed')`,
    [orderId]
  );

  const res = await startDialAttempt(orderId);
  assert.equal(res.status, 201);

  const rows = await paymentTxRowsFor(orderId);
  assert.equal(rows.length, 1, "must not create a second row alongside an already-completed one");
  assert.equal(rows[0].status, "completed", "an already-completed row must never be reopened to 'processing'");
});

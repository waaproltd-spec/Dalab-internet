// Run against a real local Postgres test database (see verifyPaymentLedgerGap.test.ts
// header for the exact command).
//
// Regression coverage for a real production gap: a carrier's own USSD
// dial response can report a SIM's real remaining balance in the same
// breath as confirming the top-up itself (e.g. Somtel's own
// "...Haraagaagu waa: $28.75."). Until now that text was only ever
// captured for display (ussd_dial_attempts.response_message) -- nothing
// fed it into the balance pipeline, which only ever listened to a
// SEPARATE incoming SMS via extractBalanceFromSms/ingestPaymentSms
// (smsLogs.routes.ts). Somnet's own confirmation apparently also arrives
// as a distinct balance-report SMS, so its dashboard balance stayed
// fresh; Somtel's evidently doesn't, so its balance went stale
// indefinitely despite a fresh reading arriving on every successful dial.
//
// The fix: PUT /agent/dial-attempts/:attemptId now runs the exact same
// extractBalanceFromSms parser against a successful attempt's own
// responseMessage, and -- since the order being dialed already says with
// certainty which company/device/SIM this balance belongs to, no
// sender-ID heuristic needed -- applies it via applyBalanceUpdate with a
// new 'ussd_dial' source, distinct from a real SMS.
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

const COMPANY_ID = "test-ussd-balance-somtel";
const CATEGORY_ID = randomUUID();
const DEVICE_ID = "test-ussd-balance-device";
const AGENT_ID = randomUUID();
const CUSTOMER_ID = randomUUID();

let packageId: string;
let agentToken: string;

const app = express();
app.use(express.json());
app.use(ussdRouter);
let server: http.Server;
let baseUrl: string;

function makeOrderId(): string {
  return "TESTUSSDBAL" + Math.floor(100000 + Math.random() * 900000);
}

async function insertInProgressOrder(): Promise<string> {
  const id = makeOrderId();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel, ussd_generated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'in_progress','customer_app','*123*1*770001234*5#')`,
    [id, CUSTOMER_ID, COMPANY_ID, packageId, 5, "252619991299", "252770001234"]
  );
  return id;
}

async function startDialAttempt(orderId: string): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO ussd_dial_attempts (id, order_id, agent_id, sim_slot, ussd_string, attempt_number, status)
     VALUES ($1,$2,$3,2,'*123*1*770001234*5#',1,'pending')`,
    [id, orderId, AGENT_ID]
  );
  return id;
}

function reportDialResult(attemptId: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/agent/dial-attempts/${attemptId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify(body),
  });
}

async function simBalanceRow() {
  return queryOne<{ balance: string; company_id: string; provider_key: string; last_source: string }>(
    `SELECT balance, company_id, provider_key, last_source FROM sim_balances WHERE device_id=$1 AND sim_slot=2`,
    [DEVICE_ID]
  );
}

before(async () => {
  await query(`DELETE FROM sim_balance_history WHERE sim_balance_id IN (SELECT id FROM sim_balances WHERE device_id=$1)`, [DEVICE_ID]);
  await query(`DELETE FROM sim_balances WHERE device_id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTUSSDBAL%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  await query(`INSERT INTO agent_devices (id, name, enabled) VALUES ($1,'Test USSD Balance Device', true)`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699005599','Test USSD Balance Agent','x',$2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  agentToken = signAccessToken(AGENT_ID, "agent");
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252619991299')`, [CUSTOMER_ID]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Somtel',1,'#F2C94C')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Test Package',5) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await query(`DELETE FROM sim_balance_history WHERE sim_balance_id IN (SELECT id FROM sim_balances WHERE device_id=$1)`, [DEVICE_ID]);
  await query(`DELETE FROM sim_balances WHERE device_id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTUSSDBAL%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await query(`DELETE FROM sim_balance_history WHERE sim_balance_id IN (SELECT id FROM sim_balances WHERE device_id=$1)`, [DEVICE_ID]);
  await query(`DELETE FROM sim_balances WHERE device_id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTUSSDBAL%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await pool.end();
});

test("a successful dial response carrying a real balance figure (Somtel's own wording) updates sim_balances with source ussd_dial", async () => {
  const orderId = await insertInProgressOrder();
  const attemptId = await startDialAttempt(orderId);

  const res = await reportDialResult(attemptId, {
    status: "success",
    responseMessage: "Yaasiin, waxaad ku guulaysatay inaad lambarkan 620346060 u wareejiso $0.25 oo Abaal ah. Haraagaagu waa: $28.75. Mahadsanid!",
    isFinalAttempt: true,
  });
  assert.equal(res.status, 200);

  const row = await simBalanceRow();
  assert.ok(row, "a sim_balances row must be created from the dial response");
  assert.equal(Number(row!.balance), 28.75);
  assert.equal(row!.company_id, COMPANY_ID);
  assert.equal(row!.provider_key, "test somtel");
  assert.equal(row!.last_source, "ussd_dial");
});

test("a successful dial response with no balance-bearing text never creates a sim_balances row", async () => {
  const orderId = await insertInProgressOrder();
  const attemptId = await startDialAttempt(orderId);

  const res = await reportDialResult(attemptId, {
    status: "success",
    responseMessage: "Waad ku guuleysatay.",
    isFinalAttempt: true,
  });
  assert.equal(res.status, 200);

  const row = await simBalanceRow();
  assert.equal(row, null);
});

test("a failed or ambiguous dial result never triggers a balance update, even with balance-shaped text", async () => {
  const orderId1 = await insertInProgressOrder();
  const attempt1 = await startDialAttempt(orderId1);
  await reportDialResult(attempt1, { status: "failed", responseMessage: "Haraagaagu waa: $99.99.", isFinalAttempt: true });
  assert.equal(await simBalanceRow(), null);

  const orderId2 = await insertInProgressOrder();
  const attempt2 = await startDialAttempt(orderId2);
  await reportDialResult(attempt2, { status: "ambiguous", responseMessage: "Haraagaagu waa: $99.99.", isFinalAttempt: true });
  assert.equal(await simBalanceRow(), null);
});

test("a second dial attempt's fresh balance reading overwrites the first, never averaged or ignored", async () => {
  const orderId1 = await insertInProgressOrder();
  const attempt1 = await startDialAttempt(orderId1);
  await reportDialResult(attempt1, { status: "success", responseMessage: "Haraagaagu waa: $28.75.", isFinalAttempt: true });
  assert.equal(Number((await simBalanceRow())!.balance), 28.75);

  const orderId2 = await insertInProgressOrder();
  const attempt2 = await startDialAttempt(orderId2);
  await reportDialResult(attempt2, { status: "success", responseMessage: "Haraagaagu waa: $28.50.", isFinalAttempt: true });
  assert.equal(Number((await simBalanceRow())!.balance), 28.5);
});

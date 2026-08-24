// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/resellerDepositSmsMatching.test.ts
//
// Covers the automatic Reseller Deposit SMS matcher added to
// ingestPaymentSms() (smsLogs.routes.ts) via resellerSmsMatching.ts: a valid
// match credits the wallet with zero commission/bonus, wrong phone/amount
// never match, a redelivered SMS never double-credits, device/SIM auto-link
// on first match then enforcement on the next, and — critically — that a
// normal Internet Store payment SMS is completely unaffected (Reseller
// matching only ever runs after Store AND Exchange have both found nothing).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";

const AGENT_ID = randomUUID();
const DEVICE_ID = "test-reseller-device-1";
const OTHER_DEVICE_ID = "test-reseller-device-2";
const RESELLER_ID = randomUUID();
const COMPANY_ID = "test-reseller-company";

before(async () => {
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM reseller_deposits`);
  await query(`DELETE FROM reseller_wallet_transactions`);
  await query(`DELETE FROM reseller_wallets`);
  await query(`DELETE FROM resellers`);
  await query(`DELETE FROM reseller_deposit_methods`);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM company_payment_methods`);
  await query(`DELETE FROM payment_wallets WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM agents`);
  await query(`DELETE FROM agent_devices`);
  await query(`DELETE FROM admin_activity_log`);

  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Reseller Device 1'), ($2, 'Test Reseller Device 2')`, [
    DEVICE_ID,
    OTHER_DEVICE_ID,
  ]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000099', 'Test Agent', 'x', $2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1, 'Test Co', 1, '#000000', 'EVC Plus', '610000001')`,
    [COMPANY_ID]
  );
  await query(
    `INSERT INTO reseller_deposit_methods (method, label, payment_number, ussd_template) VALUES ('evc', 'EVC Plus', '610000001', '*712*610000001*{amount}#')`
  );
  await query(`INSERT INTO resellers (id, reseller_login_id, name, pin_hash) VALUES ($1, 'RSLTEST01', 'Test Reseller', 'x')`, [RESELLER_ID]);
  await query(`INSERT INTO reseller_wallets (reseller_id) VALUES ($1)`, [RESELLER_ID]);
});

after(async () => {
  await pool.end();
});

async function createPendingDeposit(fromNumber: string, amount: number): Promise<string> {
  const id = "DEP" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO reseller_deposits (id, reseller_id, method, to_number, from_number, amount) VALUES ($1,$2,'evc','610000001',$3,$4)`,
    [id, RESELLER_ID, fromNumber, amount]
  );
  return id;
}

async function walletBalance(): Promise<number> {
  const row = await queryOne<{ balance: string }>(`SELECT balance FROM reseller_wallets WHERE reseller_id=$1`, [RESELLER_ID]);
  return Number(row!.balance);
}

test("valid Reseller Deposit SMS matches, credits the wallet with zero commission, and links the SMS", async () => {
  const depositId = await createPendingDeposit("615551111", 50);
  const balanceBefore = await walletBalance();

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test",
    parsedProvider: "Hormuud",
    parsedAmount: 50,
    parsedPhone: "615551111",
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedResellerDepositId, depositId);
  assert.equal(result.body.matchedOrderId, null);

  const deposit = await queryOne<{ status: string; matched_sms_log_id: string }>(
    `SELECT status, matched_sms_log_id FROM reseller_deposits WHERE id=$1`,
    [depositId]
  );
  assert.equal(deposit!.status, "verified");
  assert.equal(deposit!.matched_sms_log_id, result.body.id);

  const balanceAfter = await walletBalance();
  assert.equal(balanceAfter - balanceBefore, 50, "wallet must be credited exactly the deposited amount — no commission or bonus");
});

test("wrong sender phone does not match — deposit stays pending", async () => {
  const depositId = await createPendingDeposit("615552222", 30);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-wrong-phone",
    parsedAmount: 30,
    parsedPhone: "615559999",
  });

  assert.equal(result.body.matchedResellerDepositId, null);
  const deposit = await queryOne<{ status: string }>(`SELECT status FROM reseller_deposits WHERE id=$1`, [depositId]);
  assert.equal(deposit!.status, "pending");
});

test("wrong amount does not match", async () => {
  await createPendingDeposit("615553333", 40);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-wrong-amount",
    parsedAmount: 41,
    parsedPhone: "615553333",
  });

  assert.equal(result.body.matchedResellerDepositId, null);
});

test("a redelivered SMS (same body/sender/minute) never double-credits the wallet", async () => {
  const depositId = await createPendingDeposit("615554444", 25);
  const balanceBefore = await walletBalance();
  const receivedAt = new Date().toISOString();

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "redelivery-test-body",
    parsedAmount: 25,
    parsedPhone: "615554444",
    receivedAt,
  });
  assert.equal(first.body.matchedResellerDepositId, depositId);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "redelivery-test-body",
    parsedAmount: 25,
    parsedPhone: "615554444",
    receivedAt,
  });
  assert.equal(second.body.duplicate, true);

  const balanceAfter = await walletBalance();
  assert.equal(balanceAfter - balanceBefore, 25, "the redelivered SMS must not credit the wallet a second time");
});

test("device/SIM auto-links on first match, then a second EVC Plus deposit on a DIFFERENT device does not match", async () => {
  // First match already happened in the very first test above, auto-linking
  // reseller_deposit_methods('evc') to DEVICE_ID. Confirm that link exists...
  const method = await queryOne<{ device_id: string }>(`SELECT device_id FROM reseller_deposit_methods WHERE method='evc'`);
  assert.equal(method!.device_id, DEVICE_ID);

  // ...then prove a same-amount/phone SMS arriving on a DIFFERENT agent/device is rejected.
  const otherAgentId = randomUUID();
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000098', 'Other Agent', 'x', $2)`, [
    otherAgentId,
    OTHER_DEVICE_ID,
  ]);
  const depositId = await createPendingDeposit("615555555", 60);

  const result = await ingestPaymentSms({
    agentId: otherAgentId,
    sender: "192",
    body: "wrong-device-test",
    parsedAmount: 60,
    parsedPhone: "615555555",
  });

  assert.equal(result.body.matchedResellerDepositId, null);
  const deposit = await queryOne<{ status: string }>(`SELECT status FROM reseller_deposits WHERE id=$1`, [depositId]);
  assert.equal(deposit!.status, "pending", "an SMS from the wrong device/SIM must never verify a deposit");
});

test("a normal Internet Store payment SMS is completely unaffected — Reseller matching only runs after Store finds nothing", async () => {
  const orderId = "ORD" + Math.floor(100000000 + Math.random() * 900000000);
  const customerId = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '615556666')`, [customerId]);
  const categoryId = randomUUID();
  const packageId = randomUUID();
  await query(
    `INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,'Test Pkg',70)`,
    [packageId, COMPANY_ID, categoryId]
  );
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, sender_phone, receiver_phone, amount, status)
     VALUES ($1,$2,$3,$4,'615556666','615556666',70,'pending')`,
    [orderId, customerId, COMPANY_ID, packageId]
  );
  // A Reseller Deposit that would otherwise match the exact same amount+phone.
  const depositId = await createPendingDeposit("615556666", 70);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "store-order-precedence-test",
    parsedAmount: 70,
    parsedPhone: "615556666",
  });

  assert.equal(result.body.matchedOrderId, orderId, "the Store order must win — it's matched first");
  assert.equal(result.body.matchedResellerDepositId, null, "Reseller matching must never run when Store already matched");

  const deposit = await queryOne<{ status: string }>(`SELECT status FROM reseller_deposits WHERE id=$1`, [depositId]);
  assert.equal(deposit!.status, "pending", "the reseller deposit must remain untouched");
});

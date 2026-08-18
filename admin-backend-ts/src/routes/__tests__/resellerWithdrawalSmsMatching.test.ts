// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/resellerWithdrawalSmsMatching.test.ts
//
// Covers the automatic Reseller Withdraw SMS matcher (resellerSmsMatching.ts's
// findMatchingResellerWithdrawal/confirmResellerWithdrawalViaSms), driven by
// the two REAL outgoing "payout sent" SMS this project has actually seen —
// exercising the parsed values the mobile hormuudOutgoingParser/
// amtelOutgoingParser (agent-app's smsParsers.ts) produce for them, not
// invented ones. Confirms: the wallet is untouched at withdrawal request
// time and only deducted once the SMS confirms; a Hormuud SMS can only ever
// complete a Hormuud withdrawal (never Amtel's, even at the same amount+
// phone); a redelivered SMS never double-deducts; and — critically — a
// normal Internet Store/eBadal/Reseller Deposit payment SMS is completely
// unaffected (Reseller Withdraw matching only ever runs dead last).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";

const AGENT_ID = randomUUID();
const DEVICE_ID = "test-withdrawal-device-1";
const RESELLER_ID = randomUUID();
const HORMUUD_ID = "test-wd-hormuud";
const AMTEL_ID = "test-wd-amtel";

// The exact two real SMS this project has seen, verbatim.
const HORMUUD_SMS_BODY = "[-E-Voucher-] $0.5 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa $2.37.";
const HORMUUD_SMS_SENDER = "740";
const AMTEL_SMS_BODY =
  "You have transferred $1-252711444497. Date-Time: 18/08/2026 09:04:48. Transaction ID: 04247700000025841807. Your balance $0.35.";
const AMTEL_SMS_SENDER = "913";

before(async () => {
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM reseller_withdrawals WHERE reseller_id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM reseller_wallet_transactions WHERE reseller_id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM reseller_wallets WHERE reseller_id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM resellers WHERE id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM reseller_withdrawal_commission_config WHERE company_id IN ($1,$2)`, [HORMUUD_ID, AMTEL_ID]);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM packages WHERE company_id IN ($1,$2)`, [HORMUUD_ID, AMTEL_ID]);
  await query(`DELETE FROM payment_wallets WHERE company_id IN ($1,$2)`, [HORMUUD_ID, AMTEL_ID]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2)`, [HORMUUD_ID, AMTEL_ID]);
  await query(`DELETE FROM agents`);
  await query(`DELETE FROM agent_devices`);
  await query(`DELETE FROM admin_activity_log`);

  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Withdrawal Device')`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000088', 'Test Agent', 'x', $2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  // Real company names — the matcher compares parsedProvider ("Hormuud"/
  // "Amtel", exactly what the mobile parser self-reports) case-insensitively
  // against companies.name.
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1, 'Hormuud', 1, '#16A34A'), ($2, 'Amtel', 2, '#C81E2C')`,
    [HORMUUD_ID, AMTEL_ID]
  );
  await query(`INSERT INTO reseller_withdrawal_commission_config (company_id, commission_percentage) VALUES ($1, 0), ($2, 0)`, [
    HORMUUD_ID,
    AMTEL_ID,
  ]);
  await query(`INSERT INTO resellers (id, reseller_login_id, name, pin_hash) VALUES ($1, 'RSLWDTEST', 'Test Reseller', 'x')`, [RESELLER_ID]);
});

after(async () => {
  await pool.end();
});

async function fundWallet(amount: number) {
  await query(`INSERT INTO reseller_wallets (reseller_id, balance) VALUES ($1, $2) ON CONFLICT (reseller_id) DO UPDATE SET balance=$2`, [
    RESELLER_ID,
    amount,
  ]);
}

async function walletBalance(): Promise<number> {
  const row = await queryOne<{ balance: string }>(`SELECT balance FROM reseller_wallets WHERE reseller_id=$1`, [RESELLER_ID]);
  return Number(row!.balance);
}

async function createWithdrawal(companyId: string, destinationNumber: string, amount: number): Promise<string> {
  const id = "WDR" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO reseller_withdrawals (id, reseller_id, company_id, destination_number, amount, status, commission_percentage, bonus_amount, customer_receives_amount)
     VALUES ($1,$2,$3,$4,$5,'reserved',0,0,$6)`,
    [id, RESELLER_ID, companyId, destinationNumber, amount, amount]
  );
  return id;
}

test("real Hormuud SMS sample: matches, completes the withdrawal, and deducts the wallet — but only once the SMS confirms, not at request time", async () => {
  await fundWallet(0.5);
  const withdrawalId = await createWithdrawal(HORMUUD_ID, "617080008", 0.5);
  assert.equal(await walletBalance(), 0.5, "wallet must be untouched right after the withdrawal request");

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: HORMUUD_SMS_SENDER,
    body: HORMUUD_SMS_BODY,
    parsedProvider: "Hormuud",
    parsedAmount: 0.5,
    parsedPhone: "617080008",
  });
  assert.equal(result.body.matchedResellerWithdrawalId, withdrawalId);

  const withdrawal = await queryOne<{ status: string; matched_sms_log_id: string }>(
    `SELECT status, matched_sms_log_id FROM reseller_withdrawals WHERE id=$1`,
    [withdrawalId]
  );
  assert.equal(withdrawal!.status, "completed");
  assert.equal(withdrawal!.matched_sms_log_id, result.body.id);
  assert.equal(await walletBalance(), 0, "wallet must now be deducted exactly the confirmed amount");
});

test("real Amtel SMS sample: matches, completes the withdrawal, and deducts the wallet", async () => {
  await fundWallet(1);
  const withdrawalId = await createWithdrawal(AMTEL_ID, "252711444497", 1);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: AMTEL_SMS_SENDER,
    body: AMTEL_SMS_BODY,
    parsedProvider: "Amtel",
    parsedAmount: 1,
    parsedPhone: "252711444497",
  });
  assert.equal(result.body.matchedResellerWithdrawalId, withdrawalId);

  const withdrawal = await queryOne<{ status: string }>(`SELECT status FROM reseller_withdrawals WHERE id=$1`, [withdrawalId]);
  assert.equal(withdrawal!.status, "completed");
  assert.equal(await walletBalance(), 0);
});

test("a Hormuud SMS never completes an Amtel withdrawal, even at the exact same amount and phone", async () => {
  await fundWallet(0.5);
  // An Amtel withdrawal that happens to want the exact same amount+phone a
  // Hormuud SMS would report — company must still gate the match.
  const amtelWithdrawalId = await createWithdrawal(AMTEL_ID, "617080008", 0.5);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: HORMUUD_SMS_SENDER,
    body: HORMUUD_SMS_BODY,
    parsedProvider: "Hormuud",
    parsedAmount: 0.5,
    parsedPhone: "617080008",
    // Distinct minute from every other test reusing this exact SMS body —
    // otherwise the system's own (correct) redelivery dedup would treat
    // this as the same SMS as an earlier test's, not a fresh one.
    receivedAt: "2026-08-18T10:10:00Z",
  });
  assert.equal(result.body.matchedResellerWithdrawalId, null, "a Hormuud SMS must never match an Amtel withdrawal");

  const withdrawal = await queryOne<{ status: string }>(`SELECT status FROM reseller_withdrawals WHERE id=$1`, [amtelWithdrawalId]);
  assert.equal(withdrawal!.status, "reserved", "the Amtel withdrawal must remain untouched");
  assert.equal(await walletBalance(), 0.5, "nothing should have been deducted");
});

test("a redelivered SMS (same body/sender/minute) never double-deducts the wallet", async () => {
  await fundWallet(0.5);
  const withdrawalId = await createWithdrawal(HORMUUD_ID, "617080008", 0.5);
  const receivedAt = "2026-08-18T10:20:00Z";

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: HORMUUD_SMS_SENDER,
    body: HORMUUD_SMS_BODY,
    parsedProvider: "Hormuud",
    parsedAmount: 0.5,
    parsedPhone: "617080008",
    receivedAt,
  });
  assert.equal(first.body.matchedResellerWithdrawalId, withdrawalId);
  assert.equal(await walletBalance(), 0);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: HORMUUD_SMS_SENDER,
    body: HORMUUD_SMS_BODY,
    parsedProvider: "Hormuud",
    parsedAmount: 0.5,
    parsedPhone: "617080008",
    receivedAt,
  });
  assert.equal(second.body.duplicate, true);
  assert.equal(await walletBalance(), 0, "the redelivered SMS must not deduct the wallet a second time");
});

test("a normal Internet Store payment SMS is completely unaffected — Reseller Withdraw matching only runs after everything else finds nothing", async () => {
  const orderId = "ORD" + Math.floor(100000000 + Math.random() * 900000000);
  const customerId = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '617080008') ON CONFLICT (phone) DO NOTHING`, [customerId]);
  const existingCustomer = await queryOne<{ id: string }>(`SELECT id FROM customers WHERE phone='617080008'`);
  const resolvedCustomerId = existingCustomer!.id;
  const packageId = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,'Test Pkg',0.5)`, [
    packageId,
    HORMUUD_ID,
    randomUUID(),
  ]);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, sender_phone, receiver_phone, amount, status)
     VALUES ($1,$2,$3,$4,'617080008','617080008',0.5,'pending')`,
    [orderId, resolvedCustomerId, HORMUUD_ID, packageId]
  );
  await fundWallet(0.5);
  const withdrawalId = await createWithdrawal(HORMUUD_ID, "617080008", 0.5);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: HORMUUD_SMS_SENDER,
    body: HORMUUD_SMS_BODY,
    parsedProvider: "Hormuud",
    parsedAmount: 0.5,
    parsedPhone: "617080008",
    receivedAt: "2026-08-18T10:30:00Z",
  });

  assert.equal(result.body.matchedOrderId, orderId, "the Store order must win — it's matched first");
  assert.equal(result.body.matchedResellerWithdrawalId, null, "Reseller Withdraw matching must never run when Store already matched");

  const withdrawal = await queryOne<{ status: string }>(`SELECT status FROM reseller_withdrawals WHERE id=$1`, [withdrawalId]);
  assert.equal(withdrawal!.status, "reserved", "the reseller withdrawal must remain untouched");
  assert.equal(await walletBalance(), 0.5);
});

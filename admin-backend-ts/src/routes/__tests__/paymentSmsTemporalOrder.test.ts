// Run against a real local Postgres test database (see verifyPaymentLedgerGap.test.ts
// header for the exact command).
//
// Regression coverage for a real production incident: a customer placed a
// new Somnet order, but an unrelated payment SMS received nearly 6 hours
// EARLIER (before that order even existed) was still sitting unmatched in
// the resweep queue. When resweepUnmatchedSmsLogs re-ran findMatchingOrder
// against it, the only thing checked was amount + sender phone + a 24-hour
// freshness window on the ORDER's own updated_at -- nothing tied the SMS's
// own received_at to when the candidate order was created. The stale SMS
// was linked to the brand-new order and completed it using money that was
// never sent for it; the customer's real payment SMS, arriving seconds
// later, then found no pending order left and fell through to Offline
// Auto-Order, paying for a second, unrelated order entirely.
//
// The fix: findMatchingOrder only considers an order a candidate if it
// already existed (created_at) at or before the SMS's own received_at
// (plus a small grace window for ordinary clock skew) -- a payment can
// never retroactively settle an order it predates.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { ingestPaymentSms, resweepUnmatchedSmsLogs } from "../smsLogs.routes.js";

const COMPANY_ID = "test-temporal-order-co";
const CATEGORY_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const AGENT_ID = randomUUID();
const CUSTOMER_PHONE = "617300401";

let packageId: string;

function makeOrderId(): string {
  return "TEST" + Math.floor(100000000 + Math.random() * 900000000);
}

async function insertPendingOrder(createdAt: Date): Promise<string> {
  // idx_orders_pending_content_dedup blocks two 'pending' orders with the
  // same (customer, company, package, amount) -- clear any leftover from a
  // previous case in the same test before inserting a fresh one.
  await query(`DELETE FROM orders WHERE customer_id=$1 AND company_id=$2 AND package_id=$3 AND amount=5 AND status='pending'`, [
    CUSTOMER_ID,
    COMPANY_ID,
    packageId,
  ]);
  const id = makeOrderId();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','customer_app')`,
    [id, CUSTOMER_ID, COMPANY_ID, packageId, 5, `252${CUSTOMER_PHONE}`, "252619991229"]
  );
  await query(`UPDATE orders SET created_at=$1 WHERE id=$2`, [createdAt.toISOString(), id]);
  return id;
}

before(async () => {
  await query(`DELETE FROM sms_logs WHERE parsed_phone=$1`, [CUSTOMER_PHONE]);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);

  // auto_process_enabled=false -- these tests only care whether a match
  // happens, not the downstream USSD-generation chain, so manual approval
  // keeps the fixture minimal (no ussd_templates row needed).
  await query(`INSERT INTO companies (id, name, group_number, color_hex, auto_process_enabled) VALUES ($1,'Test Temporal Order Co',1,'#000000',false)`, [
    COMPANY_ID,
  ]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Test Package',5) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;
  await query(`INSERT INTO customers (id, phone) VALUES ($1,$2)`, [CUSTOMER_ID, `252${CUSTOMER_PHONE}`]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699004499','Test Temporal Agent','x')`, [AGENT_ID]);
});

beforeEach(async () => {
  await query(`DELETE FROM sms_logs WHERE parsed_phone=$1`, [CUSTOMER_PHONE]);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TEST%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
});

after(async () => {
  await query(`DELETE FROM sms_logs WHERE parsed_phone=$1`, [CUSTOMER_PHONE]);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TEST%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await pool.end();
});

test("a stale orphaned SMS can never retroactively settle an order created after it arrived (the production incident)", async () => {
  const smsReceivedAt = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6 hours ago
  const ingestResult = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "Stale unrelated payment",
    parsedAmount: 5,
    parsedPhone: CUSTOMER_PHONE,
    receivedAt: smsReceivedAt.toISOString(),
  });
  assert.equal(ingestResult.body.matchedOrderId, null);

  // The order this stale SMS must NEVER be allowed to steal -- created
  // well after the SMS arrived.
  const orderId = await insertPendingOrder(new Date());

  const sweep = await resweepUnmatchedSmsLogs();
  assert.equal(sweep.relinked, 0, "the stale SMS must not be relinked to the newer order");

  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "pending", "the order must remain untouched by a payment that predates it");

  const smsLog = await queryOne<{ matched_order_id: string | null }>(
    `SELECT matched_order_id FROM sms_logs WHERE parsed_phone=$1 AND body='Stale unrelated payment'`,
    [CUSTOMER_PHONE]
  );
  assert.equal(smsLog?.matched_order_id, null);
});

test("a payment SMS still matches an order created shortly before it, exactly as before the fix", async () => {
  const orderId = await insertPendingOrder(new Date(Date.now() - 60 * 1000)); // created 1 minute ago
  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "Real payment for the real order",
    parsedAmount: 5,
    parsedPhone: CUSTOMER_PHONE,
  });
  assert.equal(result.body.matchedOrderId, orderId, "a genuinely later payment must still be able to settle an earlier order");

  const tx = await queryOne<{ id: string }>(`SELECT id FROM payment_transactions WHERE order_id=$1`, [orderId]);
  assert.ok(tx, "a real match must still create a payment_transactions row for the order");
});

test("the grace window tolerates a few seconds of clock skew, but not minutes", async () => {
  const smsReceivedAt = new Date();

  // Order created 90s AFTER the SMS -- inside the 2-minute grace window,
  // must still match (ordinary clock skew / near-simultaneous checkout).
  const withinGraceOrderId = await insertPendingOrder(new Date(smsReceivedAt.getTime() + 90 * 1000));
  const withinGraceResult = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "Within grace window",
    parsedAmount: 5,
    parsedPhone: CUSTOMER_PHONE,
    receivedAt: smsReceivedAt.toISOString(),
  });
  assert.equal(withinGraceResult.body.matchedOrderId, withinGraceOrderId);

  await query(`DELETE FROM payment_transactions WHERE order_id=$1`, [withinGraceOrderId]);
  await query(`DELETE FROM orders WHERE id=$1`, [withinGraceOrderId]);
  await query(`DELETE FROM sms_logs WHERE body='Within grace window'`);

  // Order created 5 minutes AFTER the SMS -- well outside the grace
  // window, must NOT match.
  const outsideGraceOrderId = await insertPendingOrder(new Date(smsReceivedAt.getTime() + 5 * 60 * 1000));
  const outsideGraceResult = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "Outside grace window",
    parsedAmount: 5,
    parsedPhone: CUSTOMER_PHONE,
    receivedAt: smsReceivedAt.toISOString(),
  });
  assert.equal(outsideGraceResult.body.matchedOrderId, null);
  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [outsideGraceOrderId]);
  assert.equal(order?.status, "pending");
});

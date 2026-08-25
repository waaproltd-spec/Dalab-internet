// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/offlineAutoOrder.test.ts
//
// Covers the Offline Auto-Order path added to ingestPaymentSms()
// (smsLogs.routes.ts) via offlineAutoOrder.ts: a customer with a saved
// Offline Profile (customers.offline_*, migration 065) gets a real order
// created automatically from nothing but a matching payment SMS — no app
// interaction, no pre-existing pending order. Also covers the two things
// the spec is most explicit about not regressing: a real pending Online
// order always wins first, and the same transaction can never create more
// than one order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ingestPaymentSms, resweepUnmatchedSmsLogs, smsLogsRouter } from "../smsLogs.routes.js";

const AGENT_ID = randomUUID();
const COMPANY_ID = "test-offline-company";
const OTHER_COMPANY_ID = "test-offline-other-company";

let packageId: string;
let otherCompanyPackageId: string;

// Minimal HTTP harness (same pattern as exchangeSmsMatching.test.ts's
// payoutApp) for the one test below that exercises the real
// GET /admin/payment-transactions/:id/timeline endpoint -- the same
// endpoint the admin dashboard's "Payment history" modal calls -- so that
// test verifies an Offline Auto-Order-created order shows up there exactly
// like an Online order does, not just that the right rows exist in the DB.
const adminApp = express();
adminApp.use(express.json());
adminApp.use(smsLogsRouter);
let adminServer: http.Server;
let adminBaseUrl: string;
let staffToken: string;

async function makeCustomer(phone: string): Promise<string> {
  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1, $2)`, [id, phone]);
  return id;
}

async function saveOfflineProfile(customerId: string, senderNumber: string, destinationNumber: string, companyId: string, pkgId: string) {
  await query(
    `UPDATE customers SET offline_sender_number=$1, offline_destination_number=$2, offline_company_id=$3, offline_package_id=$4, offline_profile_updated_at=now() WHERE id=$5`,
    [senderNumber, destinationNumber, companyId, pkgId, customerId]
  );
}

before(async () => {
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM payment_transactions`);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM company_payment_methods`);
  await query(`DELETE FROM packages WHERE company_id IN ($1, $2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM customers`);
  await query(`DELETE FROM companies WHERE id IN ($1, $2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM agents`);
  await query(`DELETE FROM admin_activity_log`);

  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1, '252699000077', 'Test Agent', 'x')`, [AGENT_ID]);
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1, 'Hormuud', 1, '#000000', 'EVC Plus', '61 0000001')`,
    [COMPANY_ID]
  );
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1, 'Somtel', 2, '#111111', 'eDahab', '62 0000002')`,
    [OTHER_COMPANY_ID]
  );
  packageId = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,'Anfac 2GB',0.89)`, [
    packageId,
    COMPANY_ID,
    randomUUID(),
  ]);
  otherCompanyPackageId = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,'Somtel 2GB',0.89)`, [
    otherCompanyPackageId,
    OTHER_COMPANY_ID,
    randomUUID(),
  ]);

  staffToken = signAccessToken(randomUUID(), "super_admin");
  adminServer = http.createServer(adminApp as unknown as http.RequestListener);
  adminServer.listen(0);
  await new Promise<void>((resolve) => adminServer.once("listening", resolve));
  const { port } = adminServer.address() as AddressInfo;
  adminBaseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => adminServer.close(() => resolve()));
  await pool.end();
});

test("a valid Offline Profile match creates a real order using the saved sender, destination, company, and package price", async () => {
  const customerId = await makeCustomer("252611110001");
  await saveOfflineProfile(customerId, "611111111", "612222222", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-valid-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611111111",
    transactionRef: "TX-OFFLINE-001",
  });

  assert.equal(result.status, 201);
  assert.ok(result.body.matchedOrderId, "must have created and matched a new order");

  const order = await queryOne<{
    customer_id: string;
    company_id: string;
    package_id: string;
    amount: string;
    sender_phone: string;
    receiver_phone: string;
    status: string;
    channel: string;
  }>(`SELECT customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel FROM orders WHERE id=$1`, [
    result.body.matchedOrderId,
  ]);
  assert.equal(order!.customer_id, customerId);
  assert.equal(order!.company_id, COMPANY_ID);
  assert.equal(order!.package_id, packageId);
  assert.equal(Number(order!.amount), 0.89, "amount must come from the package's authoritative price, not the client");
  assert.equal(order!.sender_phone, "611111111", "must use the customer's saved Offline sender number");
  assert.equal(order!.receiver_phone, "612222222", "must use the customer's saved Offline destination number");
  assert.equal(order!.status, "pending", "must flow into the same pending -> in_progress -> completed pipeline online orders use");
  assert.equal(order!.channel, "offline_auto");

  const tx = await queryOne<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1`, [result.body.matchedOrderId]);
  assert.equal(tx!.status, "pending", "must get the same ledger row an online match would, so the Agent App's existing auto-dial picks it up");
});

test("an unknown sender (no Offline Profile registered) is UNMATCHED — no order is created", async () => {
  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-unknown-sender-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "619999999",
    transactionRef: "TX-OFFLINE-002",
  });

  assert.equal(result.body.matchedOrderId, null);
  const orders = await query(`SELECT id FROM orders WHERE sender_phone='619999999'`);
  assert.equal(orders.length, 0);
});

test("a wrong amount does not auto-select the package or create an order", async () => {
  const customerId = await makeCustomer("252611110003");
  await saveOfflineProfile(customerId, "611113333", "612223333", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-wrong-amount-test",
    parsedProvider: "Hormuud",
    parsedAmount: 5.0,
    parsedPhone: "611113333",
    transactionRef: "TX-OFFLINE-003",
  });

  assert.equal(result.body.matchedOrderId, null);
  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 0, "an arbitrary amount must never select the profile's package anyway");
});

test("a missing transaction reference is refused — cannot be safely deduped for a fully automatic path", async () => {
  const customerId = await makeCustomer("252611110004");
  await saveOfflineProfile(customerId, "611114444", "612224444", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-no-tx-ref-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611114444",
    // transactionRef intentionally omitted
  });

  assert.equal(result.body.matchedOrderId, null);
  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 0);
});

test("the same transaction reference arriving twice creates exactly one order and one fulfillment attempt", async () => {
  const customerId = await makeCustomer("252611110005");
  await saveOfflineProfile(customerId, "611115555", "612225555", COMPANY_ID, packageId);

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-dup-test-1",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611115555",
    transactionRef: "TX-OFFLINE-DUP",
  });
  assert.ok(first.body.matchedOrderId);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-dup-test-2-different-body", // even a different body must still be caught by transactionRef
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611115555",
    transactionRef: "TX-OFFLINE-DUP",
  });
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.matchedOrderId, first.body.matchedOrderId, "must report the SAME order, never a second one");

  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 1, "TX123 -> One Payment -> One Order");

  // The redelivery DOES get its own payment_transactions row (status
  // 'duplicate_blocked') — that's an intentional audit-trail entry, see
  // buildAlreadyProcessedResult in smsLogs.routes.ts. What must never happen
  // is a SECOND row eligible for verification/dialing.
  const txs = await query<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1`, [first.body.matchedOrderId]);
  const active = txs.filter((t) => t.status !== "duplicate_blocked");
  assert.equal(active.length, 1, "the redelivery must not create a second ACTIVE ledger row that could be independently verified/fulfilled");
  assert.equal(txs.length, 2, "the redelivery still gets its own duplicate_blocked audit-trail row, per this codebase's existing convention");
});

test("a Hormuud Offline Profile is never matched by a Somtel-provider SMS, even with the same amount+phone", async () => {
  const customerId = await makeCustomer("252611110006");
  await saveOfflineProfile(customerId, "611116666", "612226666", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-wrong-provider-test",
    parsedProvider: "Somtel", // the profile's company is Hormuud
    parsedAmount: 0.89,
    parsedPhone: "611116666",
    transactionRef: "TX-OFFLINE-006",
  });

  assert.equal(result.body.matchedOrderId, null);
  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 0);
});

test("a real pending Online order always wins over an Offline Profile that would otherwise also match", async () => {
  const customerId = await makeCustomer("252611110007");
  await saveOfflineProfile(customerId, "611117777", "612227777", COMPANY_ID, packageId);

  // An Online order the SAME customer placed through the app, for the SAME
  // amount+phone the Offline Profile would also match.
  const onlineOrderId = "DLB" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, sender_phone, receiver_phone, amount, status, channel)
     VALUES ($1,$2,$3,$4,'611117777','611117777',0.89,'pending','android')`,
    [onlineOrderId, customerId, COMPANY_ID, packageId]
  );

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-vs-online-precedence-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611117777",
    transactionRef: "TX-OFFLINE-007",
  });

  assert.equal(result.body.matchedOrderId, onlineOrderId, "the existing Online order must win — Offline Auto-Order only runs when Store finds nothing");

  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 1, "no second (offline) order may be created once an Online order already matched");
});

test("Online ordering is unaffected: a customer can still use different sender/destination numbers per order than their Offline Profile", async () => {
  const customerId = await makeCustomer("252611110008");
  await saveOfflineProfile(customerId, "611118888", "612228888", COMPANY_ID, packageId);

  // A genuinely different Online order, with sender/destination numbers
  // that differ from the saved Offline Profile entirely.
  const onlineOrderId = "DLB" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, sender_phone, receiver_phone, amount, status, channel)
     VALUES ($1,$2,$3,$4,'613330001','614440002',0.89,'pending','android')`,
    [onlineOrderId, customerId, COMPANY_ID, packageId]
  );

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-profile-never-overrides-online-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "613330001", // the ONLINE order's sender, not the Offline Profile's
    transactionRef: "TX-OFFLINE-008",
  });

  assert.equal(result.body.matchedOrderId, onlineOrderId);
  const order = await queryOne<{ sender_phone: string; receiver_phone: string }>(`SELECT sender_phone, receiver_phone FROM orders WHERE id=$1`, [
    onlineOrderId,
  ]);
  assert.equal(order!.sender_phone, "613330001");
  assert.equal(order!.receiver_phone, "614440002");
});

// Reproduces a real production case: a customer sends the payment SMS
// before (or concurrently with) saving their Offline Profile, so the live
// ingestPaymentSms call finds zero candidates and gives up for now (logging
// "No Offline Profile registered for phone ...target" -- never silent).
// Before this resweep coverage existed, that SMS stayed permanently
// unmatched forever even after the profile became valid, unlike the
// Store/Exchange paths resweepUnmatchedSmsLogs already retried.
test("a payment SMS that arrives before the customer's Offline Profile is saved gets matched on the next resweep", async () => {
  const customerId = await makeCustomer("252611119999");

  const liveResult = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-resweep-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611119999",
    transactionRef: "TX-OFFLINE-RESWEEP",
  });
  assert.equal(liveResult.body.matchedOrderId, null, "no Offline Profile exists yet, so nothing can match live");

  // The customer saves their Offline Profile AFTER the payment SMS already arrived.
  await saveOfflineProfile(customerId, "611119999", "612229999", COMPANY_ID, packageId);

  const { relinked } = await resweepUnmatchedSmsLogs();
  assert.equal(relinked, 1, "the resweep must catch the now-valid Offline Profile match");

  const sms = await queryOne<{ matched_order_id: string | null }>(`SELECT matched_order_id FROM sms_logs WHERE transaction_ref=$1`, [
    "TX-OFFLINE-RESWEEP",
  ]);
  assert.ok(sms!.matched_order_id, "the SMS must now be linked to a real order");

  const order = await queryOne<{ customer_id: string; channel: string; status: string }>(`SELECT customer_id, channel, status FROM orders WHERE id=$1`, [
    sms!.matched_order_id,
  ]);
  assert.equal(order!.customer_id, customerId);
  assert.equal(order!.channel, "offline_auto");
  // Unlike the live ingestPaymentSms path (where the Agent App itself makes
  // a separate follow-up verify-payment call after seeing the response),
  // resweepUnmatchedSmsLogs has no client waiting to do that, so it calls
  // verifyOrderAndGenerateUssd synchronously in-process on a fresh match —
  // same as the pre-existing Store-match branch right above this one — so
  // the order is already past "pending" by the time this query runs.
  assert.equal(order!.status, "in_progress");

  const tx = await queryOne<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1`, [sms!.matched_order_id]);
  assert.equal(tx!.status, "pending", "resweep-created orders must get the same ledger row the live path creates, so Verify/dial still works");

  // A second resweep pass must not create a duplicate order for the same SMS.
  const { relinked: secondPassRelinked } = await resweepUnmatchedSmsLogs();
  assert.equal(secondPassRelinked, 0, "the SMS is already matched, so it must no longer be a resweep candidate");
  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 1, "must never create a second order for the same already-matched SMS");
});

// A payment SMS that beats the Store matcher (findMatchingOrder) but ALSO
// beats the Offline Profile save (like the resweep test above) must never
// be double-processed once the live path itself already matched something.
// resweepUnmatchedSmsLogs's own candidate query already excludes any SMS
// with matched_order_id IS NOT NULL, so this is really a regression guard
// on that WHERE clause rather than new matching logic.
test("an SMS the live path already matched (Store or Offline Auto-Order) is never reprocessed by a later resweep", async () => {
  const customerId = await makeCustomer("252611110009");
  await saveOfflineProfile(customerId, "611119990", "612229990", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-already-matched-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611119990",
    transactionRef: "TX-OFFLINE-ALREADY-MATCHED",
  });
  assert.ok(result.body.matchedOrderId, "the live path must match this one immediately -- profile already existed");

  const { relinked } = await resweepUnmatchedSmsLogs();
  assert.equal(relinked, 0, "an already-matched SMS is not a resweep candidate at all");

  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 1, "the resweep must not create a second order for an SMS the live path already matched");
});

// Requirement: "Payment History must show the linked Offline Auto-Order and
// Order ID exactly as it does for Online Orders." Exercises the real
// GET /admin/payment-transactions/:id/timeline endpoint over actual HTTP
// (the same one the admin dashboard's "Payment history" modal calls) rather
// than only asserting on the underlying DB rows.
test("the admin Payment History timeline shows the Offline Auto-Order's linked order, same as an Online order", async () => {
  const customerId = await makeCustomer("252611110010");
  await saveOfflineProfile(customerId, "611110010", "612220010", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-admin-timeline-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611110010",
    transactionRef: "TX-OFFLINE-TIMELINE",
  });
  assert.ok(result.body.matchedOrderId);

  const tx = await queryOne<{ id: string }>(`SELECT id FROM payment_transactions WHERE order_id=$1`, [result.body.matchedOrderId]);
  assert.ok(tx, "the live path must create a payment_transactions ledger row, same as an Online order match");

  const res = await fetch(`${adminBaseUrl}/admin/payment-transactions/${tx!.id}/timeline`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  });
  assert.equal(res.status, 200);
  // sendJson (utils/camelCase.ts) camelCases every response, same as every
  // other admin endpoint -- transaction_ref/matched_order_id/etc. above are
  // transactionRef/matchedOrderId/etc. here.
  const body = (await res.json()) as {
    transaction: { orderId: string };
    smsLog: { transactionRef: string; matchedOrderId: string } | null;
    order: { id: string; channel: string; senderPhone: string; receiverPhone: string; customerPhone: string } | null;
  };

  assert.equal(body.transaction.orderId, result.body.matchedOrderId);
  assert.ok(body.smsLog, "the timeline must include the matched SMS, same shape as an Online order's");
  assert.equal(body.smsLog!.transactionRef, "TX-OFFLINE-TIMELINE");
  assert.equal(body.smsLog!.matchedOrderId, result.body.matchedOrderId);
  assert.ok(body.order, "the timeline must include the Offline Auto-Order-created order itself, not just its id");
  assert.equal(body.order!.id, result.body.matchedOrderId);
  assert.equal(body.order!.channel, "offline_auto");
  assert.equal(body.order!.customerPhone, "252611110010");
});

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
import { customersRouter } from "../customers.routes.js";

const AGENT_ID = randomUUID();
const DEVICE_ID = "test-offline-device";
const COMPANY_ID = "test-offline-company";
const OTHER_COMPANY_ID = "test-offline-other-company";

let packageId: string;
let otherCompanyPackageId: string;
let hormuudMethodId: string;
let somtelMethodId: string;

// Minimal HTTP harness (same pattern as exchangeSmsMatching.test.ts's
// payoutApp), mounting BOTH the real GET /admin/payment-transactions/:id/timeline
// endpoint (the one the admin dashboard's "Payment history" modal calls) and
// the real PUT /customer/offline-profile endpoint -- so the "profile changes
// take effect immediately, no caching" tests below exercise the actual
// production write path (customers.routes.ts), not a hand-rolled SQL proxy
// for it.
const adminApp = express();
adminApp.use(express.json());
adminApp.use(smsLogsRouter);
adminApp.use(customersRouter);
let adminServer: http.Server;
let adminBaseUrl: string;
let staffToken: string;

async function makeCustomer(phone: string): Promise<string> {
  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1, $2)`, [id, phone]);
  return id;
}

async function saveOfflineProfile(
  customerId: string,
  senderNumber: string,
  destinationNumber: string,
  companyId: string,
  pkgId: string,
  paymentMethodId?: string
) {
  await query(
    `UPDATE customers SET offline_sender_number=$1, offline_destination_number=$2, offline_company_id=$3, offline_package_id=$4, offline_payment_method_id=$5, offline_profile_updated_at=now() WHERE id=$6`,
    [senderNumber, destinationNumber, companyId, pkgId, paymentMethodId ?? null, customerId]
  );
}

// Calls the REAL PUT /customer/offline-profile endpoint over actual HTTP,
// exactly as the Customer App does -- not the raw-SQL saveOfflineProfile
// helper above (which some earlier tests still use for setup convenience).
async function saveOfflineProfileViaApi(
  customerId: string,
  senderNumber: string,
  destinationNumber: string,
  companyId: string,
  pkgId: string,
  paymentMethodId?: string
) {
  const token = signAccessToken(customerId, "customer");
  const res = await fetch(`${adminBaseUrl}/customer/offline-profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ senderNumber, destinationNumber, companyId, packageId: pkgId, paymentMethodId }),
  });
  if (res.status !== 200) {
    throw new Error(`saveOfflineProfileViaApi failed: ${res.status} ${await res.text()}`);
  }
}

before(async () => {
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM payment_transactions`);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM company_payment_methods`);
  await query(`DELETE FROM packages WHERE company_id IN ($1, $2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM customers`);
  // A payment_wallets row can end up referencing one of these company ids
  // (some migrations backfill payment_wallets.company_id by matching a
  // company's name, and "Hormuud"/"Somtel" below are real carrier names) --
  // this table isn't otherwise touched by this suite's fixtures, so clear
  // it defensively before the companies DELETE below can hit its FK.
  await query(`DELETE FROM payment_wallets WHERE company_id IN ($1, $2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id IN ($1, $2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM agent_devices`);
  await query(`DELETE FROM agents`);
  await query(`DELETE FROM admin_activity_log`);

  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Offline Device')`, [DEVICE_ID]);
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000077', 'Test Agent', 'x', $2)`,
    [AGENT_ID, DEVICE_ID]
  );
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1, 'Hormuud', 1, '#000000', 'EVC Plus', '61 0000001')`,
    [COMPANY_ID]
  );
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1, 'Somtel', 2, '#111111', 'eDahab', '62 0000002')`,
    [OTHER_COMPANY_ID]
  );
  // Same physical test device, one SIM slot each — mirrors the real setup
  // (Mobile 1 / SIM 1 = Hormuud EVC Plus, Mobile 1 / SIM 2 = Somtel eDahab)
  // and gives the wrong-provider tests below a real device/SIM guardrail to
  // exercise, the same way findMatchingOrder's Online-order counterpart
  // works via company_payment_methods.device_id/sim_slot.
  hormuudMethodId = (await queryOne<{ id: string }>(
    `INSERT INTO company_payment_methods (id, company_id, method, label, payment_number, ussd_template, enabled, sort_order, device_id, sim_slot)
     VALUES ($1,$2,'evc_plus','EVC Plus','61 0000001','*712*61 0000001*{amount}#',true,1,$3,1) RETURNING id`,
    [randomUUID(), COMPANY_ID, DEVICE_ID]
  ))!.id;
  somtelMethodId = (await queryOne<{ id: string }>(
    `INSERT INTO company_payment_methods (id, company_id, method, label, payment_number, ussd_template, enabled, sort_order, device_id, sim_slot)
     VALUES ($1,$2,'edahab','eDahab','62 0000002','*828*62 0000002*{amount}#',true,1,$3,2) RETURNING id`,
    [randomUUID(), OTHER_COMPANY_ID, DEVICE_ID]
  ))!.id;
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

test("a Hormuud Offline Profile is never matched by a Somtel-provider SMS, even with the same amount+phone — exactly the same device/SIM guardrail Online orders use, not a provider-name string check", async () => {
  const customerId = await makeCustomer("252611110006");
  // Profile is pinned to Hormuud's specific EVC Plus payment method, which
  // is configured on SIM slot 1 of the test device (see before()).
  await saveOfflineProfile(customerId, "611116666", "612226666", COMPANY_ID, packageId, hormuudMethodId);

  // A real Somtel payment SMS always arrives on Somtel's own SIM slot (2 in
  // this fixture) — never Hormuud's slot 1 — so simulating "a Somtel SMS"
  // means the upload resolves slot 2, exactly like the real Agent App would
  // report for an SMS that landed on the eDahab SIM.
  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-wrong-provider-test",
    parsedProvider: "Somtel", // the profile's company is Hormuud
    parsedAmount: 0.89,
    parsedPhone: "611116666",
    transactionRef: "TX-OFFLINE-006",
    simSlot: 2,
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

// Reproduces a real support question: after a customer changes their Offline
// Profile's sender number, does the OLD number keep matching (a caching/
// staleness bug) or does the change take effect immediately? Investigated
// the full path first -- db/pool.ts is a single pg Pool with no read
// replica, and matchOrCreateOfflineAutoOrder/PUT /customer/offline-profile
// both do a single, uncached SQL statement -- so there's no caching layer to
// go stale in the first place. These tests exercise the REAL
// PUT /customer/offline-profile endpoint (not the raw-SQL saveOfflineProfile
// helper) to prove that end-to-end, in the same live process, with no
// restart of any kind between steps.
test("changing the Offline Profile's sender number takes effect immediately: the old number stops matching and the new one matches right away, no restart required", async () => {
  const customerId = await makeCustomer("252611130001");
  await saveOfflineProfileViaApi(customerId, "611120001", "612220001", COMPANY_ID, packageId);

  // 1. The original sender number matches while it's still the active value.
  const beforeUpdate = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "profile-live-before",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611120001",
    transactionRef: "TX-PROFILE-LIVE-BEFORE",
  });
  assert.ok(beforeUpdate.body.matchedOrderId, "the original sender number must match while it's the active profile value");

  // Advance the order out of 'pending' -- the same thing the Agent App's own
  // follow-up verify-payment call does in real usage. Without this, step 3
  // below would "match" via findMatchingOrder's generic amount+phone Store
  // lookup (which has no device/SIM check at all for a payment_method_id-less
  // order like this one) -- a completely different, correct reuse-of-a-
  // still-pending-order behavior that has nothing to do with the profile
  // change being tested here.
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [beforeUpdate.body.matchedOrderId]);

  // 2. Customer changes their sender number via the real API.
  await saveOfflineProfileViaApi(customerId, "611120002", "612220001", COMPANY_ID, packageId);

  // 3. The OLD number must no longer match -- it's not the current profile
  // value anymore. If this failed, that would be exactly the caching bug
  // being asked about.
  const oldNumberAfterUpdate = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "profile-live-old-after",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611120001",
    transactionRef: "TX-PROFILE-LIVE-OLD-AFTER",
  });
  assert.equal(oldNumberAfterUpdate.body.matchedOrderId, null, "the old sender number must stop matching immediately once the profile changes");

  // 4. The NEW number matches immediately -- same process, no restart, no
  // cache-invalidation step anywhere.
  const newNumber = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "profile-live-new",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611120002",
    transactionRef: "TX-PROFILE-LIVE-NEW",
  });
  assert.ok(newNumber.body.matchedOrderId, "the new sender number must match immediately after being saved, no restart required");
  assert.notEqual(newNumber.body.matchedOrderId, beforeUpdate.body.matchedOrderId, "must be a distinct new order, not a stale reused match");
});

test("the resweep uses the customer's CURRENT profile, matching an SMS that only failed live because the profile hadn't been updated to it yet", async () => {
  const customerId = await makeCustomer("252611130010");
  // Profile starts pointing at a different sender number than the SMS below.
  await saveOfflineProfileViaApi(customerId, "611199999", "612220010", COMPANY_ID, packageId);

  const liveAttempt = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "profile-resweep-live",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611120010",
    transactionRef: "TX-PROFILE-RESWEEP-LIVE",
  });
  assert.equal(liveAttempt.body.matchedOrderId, null, "the profile doesn't point at this sender number yet");

  // Customer now updates their profile (via the real API) to the number the
  // SMS already arrived from.
  await saveOfflineProfileViaApi(customerId, "611120010", "612220010", COMPANY_ID, packageId);

  const { relinked } = await resweepUnmatchedSmsLogs();
  assert.equal(relinked, 1, "the resweep must use the customer's CURRENT profile, not whatever was active when the SMS first arrived");

  const sms = await queryOne<{ matched_order_id: string | null }>(`SELECT matched_order_id FROM sms_logs WHERE transaction_ref=$1`, [
    "TX-PROFILE-RESWEEP-LIVE",
  ]);
  assert.ok(sms!.matched_order_id, "the resweep-created order must be linked");
});

test("provider validation still applies to the customer's CURRENT profile: changing the profile's company also takes effect immediately, without weakening the Somtel-vs-Hormuud guard", async () => {
  const customerId = await makeCustomer("252611130020");
  // COMPANY_ID = Hormuud, pinned to its EVC Plus method (SIM slot 1).
  await saveOfflineProfileViaApi(customerId, "611120020", "612220020", COMPANY_ID, packageId, hormuudMethodId);

  // A Somtel-provider SMS (arrives on Somtel's SIM slot 2) must not match
  // while the profile still points to Hormuud's slot-1 method.
  const wrongProvider = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "profile-provider-live-1",
    parsedProvider: "Somtel",
    parsedAmount: 0.89,
    parsedPhone: "611120020",
    transactionRef: "TX-PROFILE-PROVIDER-1",
    simSlot: 2,
  });
  assert.equal(wrongProvider.body.matchedOrderId, null, "a Somtel SMS must not match a Hormuud profile");

  // Customer switches their profile to the Somtel company + its own eDahab
  // method + a Somtel-valid destination number, via the real API.
  await saveOfflineProfileViaApi(customerId, "611120020", "622220020", OTHER_COMPANY_ID, otherCompanyPackageId, somtelMethodId); // OTHER_COMPANY_ID = Somtel

  // The same Somtel-provider SMS pattern (SIM slot 2) must now match
  // immediately, since the profile's company+method changed -- no restart,
  // no cache, and still the exact right device/SIM check (not a weakened
  // one): the same SMS on slot 1 would still be rejected.
  const nowMatches = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "profile-provider-live-2",
    parsedProvider: "Somtel",
    parsedAmount: 0.89,
    parsedPhone: "611120020",
    transactionRef: "TX-PROFILE-PROVIDER-2",
    simSlot: 2,
  });
  assert.ok(nowMatches.body.matchedOrderId, "must match immediately once the profile's company changed to Somtel");

  const order = await queryOne<{ company_id: string }>(`SELECT company_id FROM orders WHERE id=$1`, [nowMatches.body.matchedOrderId]);
  assert.equal(order!.company_id, OTHER_COMPANY_ID);

  // Advance this order out of 'pending' before the next check, same reason
  // as the sender-number test above -- otherwise the next SMS (same phone
  // +amount) would match it via findMatchingOrder's generic Store lookup
  // instead of actually exercising the provider guard being tested here.
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [nowMatches.body.matchedOrderId]);

  // And the reverse guard must still hold: an EVC Plus/Hormuud-provider SMS
  // must NOT match now that the profile points to Somtel.
  const wrongProviderReversed = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "profile-provider-live-3",
    parsedProvider: "Hormuud",
    parsedAmount: 0.89,
    parsedPhone: "611120020",
    transactionRef: "TX-PROFILE-PROVIDER-3",
  });
  assert.equal(wrongProviderReversed.body.matchedOrderId, null, "a Hormuud SMS must not match a Somtel profile");
});

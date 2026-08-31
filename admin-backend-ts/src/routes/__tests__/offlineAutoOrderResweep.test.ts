// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/offlineAutoOrderResweep.test.ts
//
// Covers a real reported bug: a customer's payment SMS can arrive before
// they finish saving their Offline Profile (they pay first, then rush to
// configure it) — the live upload path's one-shot
// matchOrCreateOfflineAutoOrder() correctly finds no profile yet and
// leaves the SMS unmatched, exactly like it should. The bug was that
// resweepUnmatchedSmsLogs() — which already retries every other matcher
// (Store, Exchange, Reseller Deposit, Reseller Withdraw) against
// still-unmatched SMS — never retried Offline Auto-Order at all, so once
// the profile was saved a moment later, that payment was orphaned forever
// with no self-heal path. This exercises the fix: resweep must now pick
// it up once the profile exists.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { ingestPaymentSms, resweepUnmatchedSmsLogs } from "../smsLogs.routes.js";

const AGENT_ID = randomUUID();
const COMPANY_ID = "test-offline-resweep-company";

let packageId: string;

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
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers`);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM agents`);
  await query(`DELETE FROM admin_activity_log`);

  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1, '252699000088', 'Test Agent', 'x')`, [AGENT_ID]);
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1, 'Hormuud', 1, '#000000', 'EVC Plus', '61 0000001')`,
    [COMPANY_ID]
  );
  packageId = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,'Anfac Kuhadal',0.09)`, [
    packageId,
    COMPANY_ID,
    randomUUID(),
  ]);
});

after(async () => {
  await pool.end();
});

test("a payment SMS that beats the Offline Profile save is orphaned by the live path, then relinked by resweep once the profile exists", async () => {
  const customerId = await makeCustomer("252619991299");

  // The payment SMS arrives first — no Offline Profile exists yet, so the
  // live path correctly finds nothing (same as the "unknown sender" case).
  const live = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "offline-resweep-race-test",
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "619991299",
    transactionRef: "TX-OFFLINE-RESWEEP-001",
  });
  assert.equal(live.body.matchedOrderId, null, "no Offline Profile exists yet, so nothing should match on the live path");

  const smsLog = await queryOne<{ id: string; match_failure_reason: string | null }>(
    `SELECT id, match_failure_reason FROM sms_logs WHERE transaction_ref=$1`,
    ["TX-OFFLINE-RESWEEP-001"]
  );
  assert.ok(smsLog, "the SMS must still be logged even though nothing matched");
  assert.ok(
    smsLog!.match_failure_reason?.includes("Offline Auto-Order: No Offline Profile registered"),
    "no Offline Profile existed yet -- matchOrCreateOfflineAutoOrder always logs this explicitly (never silent) so an admin reviewing Payment History can tell 'not set up yet' apart from every other failure reason"
  );

  // The customer now saves their Offline Profile — moments too late for the
  // live path, which already ran and moved on.
  await saveOfflineProfile(customerId, "619991299", "610808086", COMPANY_ID, packageId);

  const { relinked, stillUnmatched } = await resweepUnmatchedSmsLogs();
  assert.equal(relinked, 1, "the now-orphaned SMS must be picked up and relinked on this sweep");
  assert.equal(stillUnmatched, 0);

  const relinkedLog = await queryOne<{ matched_order_id: string | null; match_failure_reason: string | null }>(
    `SELECT matched_order_id, match_failure_reason FROM sms_logs WHERE id=$1`,
    [smsLog!.id]
  );
  assert.ok(relinkedLog!.matched_order_id, "sms_logs must now point at the newly-created order");
  assert.equal(relinkedLog!.match_failure_reason, null);

  const order = await queryOne<{
    customer_id: string;
    company_id: string;
    package_id: string;
    amount: string;
    sender_phone: string;
    receiver_phone: string;
    status: string;
    channel: string;
  }>(
    `SELECT customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel FROM orders WHERE id=$1`,
    [relinkedLog!.matched_order_id]
  );
  assert.equal(order!.customer_id, customerId);
  assert.equal(order!.company_id, COMPANY_ID);
  assert.equal(order!.package_id, packageId);
  assert.equal(Number(order!.amount), 0.09);
  assert.equal(order!.sender_phone, "619991299", "must use the customer's saved Offline sender number");
  assert.equal(order!.receiver_phone, "610808086", "must use the customer's saved Offline destination number");
  assert.equal(order!.channel, "offline_auto");

  const tx = await queryOne<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1`, [relinkedLog!.matched_order_id]);
  assert.equal(tx!.status, "pending", "must flow into the same ledger a live-path match would, so the Agent App's existing auto-dial still picks it up");

  // A second sweep pass must be a no-op — the row is no longer an orphan.
  const second = await resweepUnmatchedSmsLogs();
  assert.equal(second.relinked, 0);
  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 1, "resweep must never create a second order for the same already-relinked SMS");
});

test("resweep still reports 'Offline Auto-Order: ...' as part of the combined failure reason when a profile exists but rejects the payment", async () => {
  const customerId = await makeCustomer("252619992299");
  await saveOfflineProfile(customerId, "619992299", "610808087", COMPANY_ID, packageId);

  // Wrong amount for the profile's package (0.09) — Offline Auto-Order
  // will find the profile but reject it, same as the live-path test for
  // this case; this time the rejection reason must actually be reachable
  // via a sweep pass (previously resweep never called the matcher at all).
  await query(
    `INSERT INTO sms_logs (id, agent_id, sender, body, parsed_provider, parsed_amount, parsed_phone, received_at, transaction_ref, match_failure_reason)
     VALUES ($1,$2,'192','offline-resweep-wrong-amount-test','Hormuud',5.00,'619992299', now(), 'TX-OFFLINE-RESWEEP-002', 'No pending order for $5 in the last 24h')`,
    [randomUUID(), AGENT_ID]
  );

  const { relinked } = await resweepUnmatchedSmsLogs();
  assert.equal(relinked, 0, "a wrong amount must never auto-select the profile's package");

  const smsLog = await queryOne<{ match_failure_reason: string | null }>(
    `SELECT match_failure_reason FROM sms_logs WHERE transaction_ref=$1`,
    ["TX-OFFLINE-RESWEEP-002"]
  );
  assert.ok(
    smsLog!.match_failure_reason?.includes("Offline Auto-Order:"),
    `expected the combined reason to include an Offline Auto-Order segment, got: ${smsLog!.match_failure_reason}`
  );

  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 0);
});

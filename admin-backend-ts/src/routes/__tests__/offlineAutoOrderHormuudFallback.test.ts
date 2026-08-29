// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/offlineAutoOrderHormuudFallback.test.ts
//
// Covers a real structural gap: Hormuud EVC Plus's actual confirmation SMS
// ("[-EVCPLUS-] waxaad $0.09 ka heshay 0619991299, Tar: 29/08/26 22:12:34
// haraagagu waa $1.435.") has no distinct transaction-reference field at
// all -- unlike e.g. Somtel eDahab's "Aqanoosiga" code -- so
// matchOrCreateOfflineAutoOrder's hard transactionRef requirement made
// Offline Auto-Order structurally impossible for Hormuud, for every
// customer, regardless of resweepUnmatchedSmsLogs's own fix
// (offlineAutoOrderResweep.test.ts). buildHormuudEvcPlusFallbackRef
// (offlineAutoOrder.ts) closes that gap with a deterministic key built from
// stable SMS fields (sender + amount + the SMS's own "Tar:" date+time), and
// orders.offline_auto_dedup_key (069_offline_auto_order_dedup.sql) makes
// the resulting order-creation atomic at the database level.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";

const AGENT_ID = randomUUID();
const COMPANY_ID = "test-hormuud-fallback-company";

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

function hormuudBody(amount: string, date: string, time: string | null): string {
  const tar = time ? `${date} ${time}` : date;
  return `[-EVCPLUS-] waxaad $${amount} ka heshay 0619991299, Tar: ${tar} haraagagu waa $1.435.`;
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

  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1, '252699000099', 'Test Agent', 'x')`, [AGENT_ID]);
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

test("a Hormuud SMS with no transaction reference builds a deterministic fallback and creates a real order", async () => {
  const customerId = await makeCustomer("252611119001");
  await saveOfflineProfile(customerId, "611119001", "612229001", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: hormuudBody("0.09", "29/08/26", "22:12:34"),
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119001",
    // transactionRef intentionally omitted -- real Hormuud SMS never has one
  });

  assert.equal(result.status, 201);
  assert.ok(result.body.matchedOrderId, "the fallback must let this create a real order");

  const order = await queryOne<{ channel: string; offline_auto_dedup_key: string | null }>(
    `SELECT channel, offline_auto_dedup_key FROM orders WHERE id=$1`,
    [result.body.matchedOrderId]
  );
  assert.equal(order!.channel, "offline_auto");
  assert.ok(order!.offline_auto_dedup_key?.startsWith("SYN-HORMUUD-"), `expected a synthetic dedup key, got: ${order!.offline_auto_dedup_key}`);
  assert.ok(order!.offline_auto_dedup_key?.includes("611119001"), "the synthetic key must be built from the sender phone");
});

test("duplicate processing: the same Hormuud SMS ingested twice creates exactly one order", async () => {
  const customerId = await makeCustomer("252611119002");
  await saveOfflineProfile(customerId, "611119002", "612229002", COMPANY_ID, packageId);
  const body = hormuudBody("0.09", "29/08/26", "23:01:15");

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body,
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119002",
  });
  assert.ok(first.body.matchedOrderId);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body,
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119002",
  });
  assert.ok(second.body.matchedOrderId, "the redelivery must still resolve to a real order, not report unmatched");
  assert.equal(second.body.matchedOrderId, first.body.matchedOrderId, "must be the SAME order, never a second one");

  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 1);

  const txs = await query<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1`, [first.body.matchedOrderId]);
  const active = txs.filter((t) => t.status !== "duplicate_blocked");
  assert.equal(active.length, 1, "the redelivery must not create a second ACTIVE ledger row");
});

test("two legitimate same-amount payments from the same sender at different times both create separate orders", async () => {
  const customerId = await makeCustomer("252611119003");
  await saveOfflineProfile(customerId, "611119003", "612229003", COMPANY_ID, packageId);

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: hormuudBody("0.09", "29/08/26", "09:00:00"),
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119003",
  });
  assert.ok(first.body.matchedOrderId);

  // Simulate the first payment having already been fulfilled by the time
  // the second, genuinely separate payment arrives -- while the first order
  // is still 'pending', findMatchingOrder's own amount+phone matching (not
  // this fallback -- it has no channel/provenance filter at all, by design,
  // predating this change entirely) would correctly and safely absorb a
  // same-amount SMS as a duplicate of that still-open order, exactly as it
  // already does for every other provider. This test isolates what this
  // fallback itself is responsible for: two distinct dedup keys must never
  // collapse into one order once the system's own dedup semantics do treat
  // them as separate.
  await query(`UPDATE orders SET status='completed', updated_at=now() WHERE id=$1`, [first.body.matchedOrderId]);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: hormuudBody("0.09", "29/08/26", "18:30:45"), // same day, same amount, same sender -- genuinely different payment
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119003",
  });

  assert.ok(second.body.matchedOrderId);
  assert.notEqual(second.body.matchedOrderId, first.body.matchedOrderId, "two real payments must never collapse into one order");

  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 2, "a repeat top-up on the same day must not be treated as a duplicate");

  const dedupKeys = await query<{ offline_auto_dedup_key: string | null }>(`SELECT offline_auto_dedup_key FROM orders WHERE customer_id=$1`, [
    customerId,
  ]);
  assert.notEqual(dedupKeys[0].offline_auto_dedup_key, dedupKeys[1].offline_auto_dedup_key, "each real payment must get its own distinct dedup key");
});

test("retry/concurrency: two truly concurrent calls for the identical Hormuud SMS create only one order", async () => {
  const customerId = await makeCustomer("252611119004");
  await saveOfflineProfile(customerId, "611119004", "612229004", COMPANY_ID, packageId);
  const body = hormuudBody("0.09", "29/08/26", "12:12:12");

  const params = {
    agentId: AGENT_ID,
    sender: "192",
    body,
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119004",
  };

  // Genuinely concurrent at the database level, not sequential -- exercises
  // the orders.offline_auto_dedup_key unique index directly, not just the
  // app-level "check then insert" logic that alone can't close this race.
  const [a, b] = await Promise.all([ingestPaymentSms(params), ingestPaymentSms(params)]);

  assert.ok(a.body.matchedOrderId);
  assert.ok(b.body.matchedOrderId);
  assert.equal(a.body.matchedOrderId, b.body.matchedOrderId, "both concurrent calls must resolve to the SAME order");

  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 1, "a true concurrent race must never create two orders");

  const txs = await query<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1`, [orders[0].id]);
  const active = txs.filter((t) => t.status !== "duplicate_blocked");
  assert.equal(active.length, 1, "the race loser's attempt must not create a second ACTIVE ledger row either");
});

test("malformed timestamp: a Hormuud SMS with a date but no time is safely rejected, never creates an order", async () => {
  const customerId = await makeCustomer("252611119005");
  await saveOfflineProfile(customerId, "611119005", "612229005", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: hormuudBody("0.09", "29/08/26", null), // date only, no time -- insufficient precision to trust as a dedup key
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119005",
  });

  assert.equal(result.body.matchedOrderId, null, "must fail safe rather than guess with a date-only key");
  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 0);
});

test("malformed timestamp: a Hormuud SMS with no 'Tar:' field at all is safely rejected", async () => {
  const customerId = await makeCustomer("252611119006");
  await saveOfflineProfile(customerId, "611119006", "612229006", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "[-EVCPLUS-] waxaad $0.09 ka heshay 0619991299 haraagagu waa $1.435.", // no "Tar:" segment whatsoever
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119006",
  });

  assert.equal(result.body.matchedOrderId, null);
  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 0);
});

test("the fallback is scoped to Hormuud only -- a Somnet SMS (also EVC-Plus-branded, also no real reference) is still safely rejected", async () => {
  const customerId = await makeCustomer("252611119007");
  await saveOfflineProfile(customerId, "611119007", "612229007", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    // Same shape, including a full "Tar:" date+time -- but a different
    // provider than the one buildHormuudEvcPlusFallbackRef is scoped to.
    body: hormuudBody("0.09", "29/08/26", "14:00:00"),
    parsedProvider: "Somnet",
    parsedAmount: 0.09,
    parsedPhone: "611119007",
  });

  assert.equal(result.body.matchedOrderId, null, "the Hormuud-only fallback must never widen to other providers on its own");
  const orders = await query(`SELECT id FROM orders WHERE customer_id=$1`, [customerId]);
  assert.equal(orders.length, 0);
});

test("a real transaction reference still takes priority over the fallback and behaves exactly as before", async () => {
  const customerId = await makeCustomer("252611119008");
  await saveOfflineProfile(customerId, "611119008", "612229008", COMPANY_ID, packageId);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: hormuudBody("0.09", "29/08/26", "15:00:00"),
    parsedProvider: "Hormuud",
    parsedAmount: 0.09,
    parsedPhone: "611119008",
    transactionRef: "TX-REAL-REF-001", // a real reference, if one were ever present
  });

  assert.ok(result.body.matchedOrderId);
  const order = await queryOne<{ offline_auto_dedup_key: string | null }>(`SELECT offline_auto_dedup_key FROM orders WHERE id=$1`, [
    result.body.matchedOrderId,
  ]);
  assert.equal(order!.offline_auto_dedup_key, "TX-REAL-REF-001", "a real reference must be used as-is, never overridden by the synthetic fallback");
});

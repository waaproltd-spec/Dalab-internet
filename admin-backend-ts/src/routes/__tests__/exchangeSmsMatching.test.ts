// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/exchangeSmsMatching.test.ts
//
// Covers the automatic Money Exchange SMS matcher added to
// ingestPaymentSms() (smsLogs.routes.ts): valid matches in both corridor
// directions, wrong amount, wrong collection wallet/phone, a non-pending
// (expired) order, duplicate SMS handling, and confirmation that a normal
// Internet Store payment SMS is completely unaffected.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";

const AGENT_ID = randomUUID();
const DEVICE_ID = "test-device-1";
const CUSTOMER_ID = randomUUID();
const STORE_CUSTOMER_ID = randomUUID();
const COMPANY_ID = "test-company";
const CATEGORY_ID = randomUUID();
const PACKAGE_ID = randomUUID();

let corridorEdahabToEvc: string;
let corridorEvcToEdahab: string;

before(async () => {
  // Clean slate — this test DB is dedicated to this suite (see the shell
  // command above), so a blanket wipe of every table this suite touches is
  // safe and keeps each run independent of leftover state.
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM exchange_dial_attempts`);
  await query(`DELETE FROM exchange_orders`);
  await query(`DELETE FROM exchange_corridors`);
  await query(`DELETE FROM exchange_payout_wallets`);
  await query(`DELETE FROM payment_transactions`);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM packages`);
  await query(`DELETE FROM service_categories`);
  await query(`DELETE FROM company_payment_methods`);
  await query(`DELETE FROM companies`);
  await query(`DELETE FROM customers`);
  await query(`DELETE FROM agents`);
  await query(`DELETE FROM agent_devices`);
  await query(`DELETE FROM admin_activity_log`);

  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Device')`, [DEVICE_ID]);
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000001', 'Test Agent', 'x', $2)`,
    [AGENT_ID, DEVICE_ID]
  );
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252677000001')`, [CUSTOMER_ID]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252677000002')`, [STORE_CUSTOMER_ID]);

  // Two collection wallets on the same physical test device, one SIM each —
  // mirrors the real production setup (Mobile 1 / SIM 1 = EVC Plus, Mobile
  // 1 / SIM 2 = eDahab).
  const edahabWallet = await queryOne<{ id: string }>(
    `INSERT INTO exchange_payout_wallets (wallet_id, device_id, sim_slot, phone_number) VALUES ('edahab',$1,2,'252620338686') RETURNING id`,
    [DEVICE_ID]
  );
  const evcWallet = await queryOne<{ id: string }>(
    `INSERT INTO exchange_payout_wallets (wallet_id, device_id, sim_slot, phone_number) VALUES ('evc_plus',$1,1,'252610338686') RETURNING id`,
    [DEVICE_ID]
  );

  corridorEdahabToEvc = (
    await queryOne<{ id: string }>(
      `INSERT INTO exchange_corridors (from_wallet_id, to_wallet_id, rate, fee_type, fee_value, payout_wallet_id)
       VALUES ('edahab','evc_plus',1,'fixed',1,$1) RETURNING id`,
      [evcWallet!.id]
    )
  )!.id;
  corridorEvcToEdahab = (
    await queryOne<{ id: string }>(
      `INSERT INTO exchange_corridors (from_wallet_id, to_wallet_id, rate, fee_type, fee_value, payout_wallet_id)
       VALUES ('evc_plus','edahab',1,'fixed',1,$1) RETURNING id`,
      [edahabWallet!.id]
    )
  )!.id;

  // Internet Store fixtures for the "still matches a normal Store order"
  // case — a minimal company/category/package/order chain.
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Telco',1,'#000000')`,
    [COMPANY_ID]
  );
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  await query(
    `INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,$3,'1GB',5,1024)`,
    [PACKAGE_ID, COMPANY_ID, CATEGORY_ID]
  );
});

after(async () => {
  await pool.end();
  // orderEvents.ts and this file's own module (resweep interval) register
  // ref'd setIntervals at import time — nothing production code needs to
  // unref for a long-running server, but it means the test process won't
  // exit on its own once the pool is closed. Run with --test-force-exit
  // (see the command in the header comment) instead of calling
  // process.exit() here, which can cut off in-flight test reporting.
});

let exchangeOrderCounter = 0;
async function insertExchangeOrder(params: {
  corridorId: string;
  fromWalletId: string;
  toWalletId: string;
  amountSent: number;
  senderPhone: string;
  status?: string;
  ageHours?: number;
}): Promise<string> {
  const id = `DEXTEST${++exchangeOrderCounter}`;
  await query(
    `INSERT INTO exchange_orders
       (id, customer_id, corridor_id, from_wallet_id, to_wallet_id, amount_sent, rate_applied, fee_applied, amount_received, sender_phone, receiver_phone, status, channel)
     VALUES ($1,$2,$3,$4,$5,$6,1,1,$6,$7,'252688000000',$8,'customer_app')`,
    [id, CUSTOMER_ID, params.corridorId, params.fromWalletId, params.toWalletId, params.amountSent, params.senderPhone, params.status ?? "pending"]
  );
  if (params.ageHours) {
    await query(`UPDATE exchange_orders SET updated_at = now() - interval '${params.ageHours} hours' WHERE id=$1`, [id]);
  }
  return id;
}

let refCounter = 0;
function nextRef(): string {
  return `TESTREF-${++refCounter}-${randomUUID()}`;
}

async function activityFor(entityId: string, action: string) {
  return queryOne(`SELECT * FROM admin_activity_log WHERE entity_type='exchange_order' AND entity_id=$1 AND action=$2 ORDER BY created_at DESC LIMIT 1`, [
    entityId,
    action,
  ]);
}

test("valid eDahab -> EVC Plus exchange payment matches, links, and logs", async () => {
  const orderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 5,
    senderPhone: "252611111111",
  });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $5.00 ah ayaa lagugu shubay 252620338686",
    parsedAmount: 5,
    parsedPhone: "252611111111",
    simSlot: 2, // the eDahab collection wallet's SIM
    transactionRef: nextRef(),
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedExchangeOrderId, orderId);
  assert.equal(result.body.matchedOrderId, null);
  assert.equal(result.body.duplicate, false);

  const row = await queryOne<{ matched_exchange_order_id: string | null }>(`SELECT matched_exchange_order_id FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.equal(row?.matched_exchange_order_id, orderId);

  const activity = await activityFor(orderId, "match_exchange_order_sms");
  assert.ok(activity, "expected a match_exchange_order_sms activity log entry");
});

test("valid EVC Plus -> eDahab exchange payment matches, links, and logs", async () => {
  const orderId = await insertExchangeOrder({
    corridorId: corridorEvcToEdahab,
    fromWalletId: "evc_plus",
    toWalletId: "edahab",
    amountSent: 8,
    senderPhone: "252611111112",
  });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "EVC Plus",
    body: "You have received $8.00 from 252611111112",
    parsedAmount: 8,
    parsedPhone: "252611111112",
    simSlot: 1, // the EVC Plus collection wallet's SIM
    transactionRef: nextRef(),
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedExchangeOrderId, orderId);
  assert.equal(result.body.matchedOrderId, null);

  const activity = await activityFor(orderId, "match_exchange_order_sms");
  assert.ok(activity);
});

test("wrong amount does not match", async () => {
  await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 5,
    senderPhone: "252611111113",
  });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $7.00 ah",
    parsedAmount: 7,
    parsedPhone: "252611111113",
    simSlot: 2,
    transactionRef: nextRef(),
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedExchangeOrderId, null);
  assert.equal(result.body.matchedOrderId, null);
  const row = await queryOne<{ match_failure_reason: string | null }>(`SELECT match_failure_reason FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.match(row!.match_failure_reason!, /No pending exchange order for \$7/);
});

test("wrong sender phone does not match", async () => {
  await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 15,
    senderPhone: "252611111114",
  });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $15.00 ah",
    parsedAmount: 15,
    parsedPhone: "252699999999", // does not match the order's sender_phone
    simSlot: 2,
    transactionRef: nextRef(),
  });

  assert.equal(result.body.matchedExchangeOrderId, null);
  const row = await queryOne<{ match_failure_reason: string | null }>(`SELECT match_failure_reason FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.match(row!.match_failure_reason!, /none sent from phone/);
});

test("wrong collection wallet (SIM mismatch) does not match", async () => {
  await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 20,
    senderPhone: "252611111115",
  });

  // Right amount, right phone — but the SMS arrived on SIM 1 (EVC Plus's
  // collection SIM), not SIM 2 (eDahab's), so it can't be this payment.
  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $20.00 ah",
    parsedAmount: 20,
    parsedPhone: "252611111115",
    simSlot: 1,
    transactionRef: nextRef(),
  });

  assert.equal(result.body.matchedExchangeOrderId, null);
  const row = await queryOne<{ match_failure_reason: string | null }>(`SELECT match_failure_reason FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.match(row!.match_failure_reason!, /collection-wallet device\/SIM verification/);
});

test("non-pending (already completed) exchange order does not match", async () => {
  await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 25,
    senderPhone: "252611111116",
    status: "completed",
  });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $25.00 ah",
    parsedAmount: 25,
    parsedPhone: "252611111116",
    simSlot: 2,
    transactionRef: nextRef(),
  });

  assert.equal(result.body.matchedExchangeOrderId, null);
});

test("expired (outside the match window) pending exchange order does not match", async () => {
  await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 30,
    senderPhone: "252611111117",
    ageHours: 30, // older than MATCH_WINDOW_HOURS (24)
  });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $30.00 ah",
    parsedAmount: 30,
    parsedPhone: "252611111117",
    simSlot: 2,
    transactionRef: nextRef(),
  });

  assert.equal(result.body.matchedExchangeOrderId, null);
});

test("duplicate SMS (same transactionRef) is reported as already_processed, not re-matched", async () => {
  const orderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 35,
    senderPhone: "252611111118",
  });
  const ref = nextRef();

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $35.00 ah",
    parsedAmount: 35,
    parsedPhone: "252611111118",
    simSlot: 2,
    transactionRef: ref,
  });
  assert.equal(first.body.matchedExchangeOrderId, orderId);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $35.00 ah",
    parsedAmount: 35,
    parsedPhone: "252611111118",
    simSlot: 2,
    transactionRef: ref, // same carrier reference — a redelivered broadcast
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.status, "already_processed");
  assert.equal(second.body.id, first.body.id, "must return the original sms_logs row, not create a second one");
});

test("a second, differently-referenced SMS for an already-matched exchange order is blocked as a duplicate delivery", async () => {
  const orderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 40,
    senderPhone: "252611111119",
  });

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $40.00 ah (first)",
    parsedAmount: 40,
    parsedPhone: "252611111119",
    simSlot: 2,
    transactionRef: nextRef(),
  });
  assert.equal(first.body.matchedExchangeOrderId, orderId);

  // A different transaction_ref and body — e.g. the same customer somehow
  // triggers a second real-looking SMS for the same order while it's still
  // 'pending' (order isn't reused/deduped the way this can't naturally
  // recur, but the guard must hold regardless of how it happens).
  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $40.00 ah (second, different body)",
    parsedAmount: 40,
    parsedPhone: "252611111119",
    simSlot: 2,
    transactionRef: nextRef(),
  });

  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.status, "duplicate_blocked");
  assert.equal(second.body.matchedExchangeOrderId, null, "the blocked duplicate itself must not carry the link");

  // The order must still be linked to exactly the FIRST sms_log row.
  const linkedRows = await query<{ id: string }>(`SELECT id FROM sms_logs WHERE matched_exchange_order_id=$1`, [orderId]);
  assert.equal(linkedRows.length, 1);
  assert.equal(linkedRows[0].id, first.body.id);

  const dupActivity = await activityFor(orderId, "duplicate_delivery_prevented");
  assert.ok(dupActivity);
});

test("a payment SMS for a normal Internet Store order still matches exactly as before (Store path unaffected)", async () => {
  const storeOrderId = randomUUID();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone)
     VALUES ($1,$2,$3,$4,12,'pending',$5)`,
    [storeOrderId, STORE_CUSTOMER_ID, COMPANY_ID, PACKAGE_ID, "252677000002"]
  );

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "Test Telco",
    body: "You have received $12.00 from 252677000002",
    parsedAmount: 12,
    parsedPhone: "252677000002",
    simSlot: 1,
    transactionRef: nextRef(),
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedOrderId, storeOrderId);
  assert.equal(result.body.matchedExchangeOrderId, null, "a Store match must never also carry an exchange link");
  assert.equal(result.body.duplicate, false);

  const row = await queryOne<{ matched_order_id: string | null; matched_exchange_order_id: string | null }>(
    `SELECT matched_order_id, matched_exchange_order_id FROM sms_logs WHERE id=$1`,
    [result.body.id]
  );
  assert.equal(row?.matched_order_id, storeOrderId);
  assert.equal(row?.matched_exchange_order_id, null);
});

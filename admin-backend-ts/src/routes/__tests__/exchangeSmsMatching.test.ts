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
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { encrypt, signAccessToken } from "../../auth/crypto.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";
import { autoAdvanceExchangeOrderToInProgress, exchangeRouter } from "../exchange.routes.js";

const AGENT_ID = randomUUID();
const DEVICE_ID = "test-device-1";
const CUSTOMER_ID = randomUUID();
const STORE_CUSTOMER_ID = randomUUID();
const COMPANY_ID = "test-company";
const CATEGORY_ID = randomUUID();
const PACKAGE_ID = randomUUID();
// Fake, test-only PIN for the payout-lifecycle tests below -- never used
// against a real wallet/carrier.
const PAYOUT_TEST_PIN = "4471";

let corridorEdahabToEvc: string;
let corridorEvcToEdahab: string;

// Minimal HTTP harness for the payout-lifecycle tests at the end of this
// file — mounts the REAL, unmodified exchangeRouter so those tests exercise
// actual HTTP + JWT auth exactly like the Agent App would, rather than
// calling route logic directly. Kept in this same file (sharing this one
// before()/corridor setup) rather than a separate test file: exchange_
// corridors has a UNIQUE(from_wallet_id, to_wallet_id) constraint, so two
// independent test files each trying to own "the eDahab<->EVC Plus
// corridor pair" would stomp on each other when run together.
const payoutApp = express();
payoutApp.use(express.json());
payoutApp.use(exchangeRouter);
let payoutServer: http.Server;
let payoutBaseUrl: string;
let agentToken: string;
let superAdminToken: string;

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
  // 1 / SIM 2 = eDahab). PINs set via the same encrypt() the real
  // PUT /admin/exchange/payout-wallets/:id/pin endpoint uses, so the
  // payout-lifecycle tests below exercise the real encrypt/decrypt path —
  // both fake, test-only PINs, never used against a real wallet/carrier.
  const edahabWallet = await queryOne<{ id: string }>(
    `INSERT INTO exchange_payout_wallets (wallet_id, device_id, sim_slot, phone_number, pin_encrypted) VALUES ('edahab',$1,2,'252620338686',$2) RETURNING id`,
    [DEVICE_ID, encrypt("9999")]
  );
  const evcWallet = await queryOne<{ id: string }>(
    `INSERT INTO exchange_payout_wallets (wallet_id, device_id, sim_slot, phone_number, pin_encrypted) VALUES ('evc_plus',$1,1,'252610338686',$2) RETURNING id`,
    [DEVICE_ID, encrypt(PAYOUT_TEST_PIN)]
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

  agentToken = signAccessToken(AGENT_ID, "agent");
  superAdminToken = signAccessToken(randomUUID(), "super_admin");
  payoutServer = http.createServer(payoutApp as unknown as http.RequestListener);
  payoutServer.listen(0);
  await new Promise<void>((resolve) => payoutServer.once("listening", resolve));
  const { port } = payoutServer.address() as AddressInfo;
  payoutBaseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => payoutServer.close(() => resolve()));
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

  // Fully automatic pipeline: a matched payment SMS also auto-verifies the
  // order (pending -> in_progress) with no admin/agent action.
  const order = await queryOne<{ status: string }>(`SELECT status FROM exchange_orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "in_progress");
  const verifyActivity = await activityFor(orderId, "auto_verify_exchange_order_sms_match");
  assert.ok(verifyActivity, "expected an auto_verify_exchange_order_sms_match activity log entry");
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

  const order = await queryOne<{ status: string }>(`SELECT status FROM exchange_orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "in_progress");
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

test("a second, differently-referenced SMS for an already-matched (now in_progress) exchange order cannot re-match or re-verify it", async () => {
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
  const afterFirst = await queryOne<{ status: string }>(`SELECT status FROM exchange_orders WHERE id=$1`, [orderId]);
  assert.equal(afterFirst?.status, "in_progress", "the first match must have auto-verified the order");

  // A different transaction_ref and body — e.g. the same customer somehow
  // triggers a second real-looking SMS for the same order. Since the first
  // match already auto-advanced the order out of 'pending', the candidate
  // query in findMatchingExchangeOrder (WHERE status='pending') can no
  // longer find it at all — the second SMS simply fails to match anything
  // (surfaced as an ordinary Unmatched row on the SMS Monitor dashboard),
  // rather than hitting the explicit "already has a matched SMS" duplicate
  // guard, which now only ever fires for a genuine concurrent race (two
  // SMS landing before either's auto-verify transaction commits — covered
  // by findMatchingExchangeOrder's FOR UPDATE SKIP LOCKED candidate lock).
  // Either way the safety property holds: the order can never be matched,
  // verified, or paid out twice.
  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $40.00 ah (second, different body)",
    parsedAmount: 40,
    parsedPhone: "252611111119",
    simSlot: 2,
    transactionRef: nextRef(),
  });

  assert.equal(second.body.matchedExchangeOrderId, null, "the order is no longer 'pending', so it can't be matched again");
  assert.equal(second.body.duplicate, false);

  // The order must still be linked to exactly the FIRST sms_log row, and
  // must still be in_progress from that first, legitimate verify — never
  // touched a second time.
  const linkedRows = await query<{ id: string }>(`SELECT id FROM sms_logs WHERE matched_exchange_order_id=$1`, [orderId]);
  assert.equal(linkedRows.length, 1);
  assert.equal(linkedRows[0].id, first.body.id);
  const afterSecond = await queryOne<{ status: string }>(`SELECT status FROM exchange_orders WHERE id=$1`, [orderId]);
  assert.equal(afterSecond?.status, "in_progress");
  const verifyActivityCount = await query(
    `SELECT id FROM admin_activity_log WHERE entity_type='exchange_order' AND entity_id=$1 AND action='auto_verify_exchange_order_sms_match'`,
    [orderId]
  );
  assert.equal(verifyActivityCount.length, 1, "must never auto-verify the same order twice");
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

test("auto-verify is idempotent — cannot double-advance an already in_progress order", async () => {
  const orderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 45,
    senderPhone: "252611111120",
  });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $45.00 ah",
    parsedAmount: 45,
    parsedPhone: "252611111120",
    simSlot: 2,
    transactionRef: nextRef(),
  });
  assert.equal(result.body.matchedExchangeOrderId, orderId);
  const afterMatch = await queryOne<{ status: string }>(`SELECT status FROM exchange_orders WHERE id=$1`, [orderId]);
  assert.equal(afterMatch?.status, "in_progress");

  // A second, independent call for the same order (e.g. an admin tapping
  // Verify Payment on an order the matcher already advanced, or a resweep
  // racing the live path) must be rejected, not silently re-fire.
  const second = await autoAdvanceExchangeOrderToInProgress(orderId, { source: "sms_match" });
  assert.ok(second.error, "expected a second advance attempt to be rejected");
  assert.match(second.error!, /not pending|Cannot verify/);

  const verifyActivityCount = await query(
    `SELECT id FROM admin_activity_log WHERE entity_type='exchange_order' AND entity_id=$1 AND action='auto_verify_exchange_order_sms_match'`,
    [orderId]
  );
  assert.equal(verifyActivityCount.length, 1, "must log exactly one auto-verify, never two");
});

test("hasDialAttempt correctly distinguishes orders with and without a dial attempt (GET /agent/exchange/orders shape)", async () => {
  const dialedOrderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 50,
    senderPhone: "252611111121",
  });
  const undialedOrderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 51,
    senderPhone: "252611111122",
  });
  await query(`UPDATE exchange_orders SET status='in_progress' WHERE id IN ($1,$2)`, [dialedOrderId, undialedOrderId]);
  await query(
    `INSERT INTO exchange_dial_attempts (exchange_order_id, attempt_number, status) VALUES ($1, 1, 'failed')`,
    [dialedOrderId]
  );

  // Exact query the GET /agent/exchange/orders route runs (see
  // exchange.routes.ts) — reproduced here since exercising it through a
  // real authenticated HTTP request is out of scope for this unit-level
  // suite; this validates the EXISTS logic ExchangeSelfHealSweeper (Agent
  // App) relies on to never auto-dial an order a second time.
  const rows = await query<{ id: string; has_dial_attempt: boolean }>(
    `SELECT eo.id, EXISTS(SELECT 1 FROM exchange_dial_attempts eda WHERE eda.exchange_order_id = eo.id) AS has_dial_attempt
     FROM exchange_orders eo WHERE eo.status='in_progress' AND eo.id IN ($1,$2)`,
    [dialedOrderId, undialedOrderId]
  );
  const dialed = rows.find((r) => r.id === dialedOrderId);
  const undialed = rows.find((r) => r.id === undialedOrderId);
  assert.equal(dialed?.has_dial_attempt, true, "an order with a (even failed) dial attempt must be flagged, so it's never auto-dialed twice");
  assert.equal(undialed?.has_dial_attempt, false, "an order with no dial attempt yet must be eligible for automatic payout");
});

// ==================== Safe (no real money) payout-lifecycle tests ====================
// These exercise the REAL production route handlers (exchangeRouter,
// unmodified) over REAL HTTP with REAL JWTs, against this same local
// Postgres test database — nothing here talks to Android, a real
// USSD/telecom network, or the live VPS. They stand in for "the Agent App
// calling these endpoints" without an actual phone: everything the Agent
// App would send (dial-attempt start, step1 result, step2 result) is sent
// directly, exactly as ExchangeUssdOrchestrator does, but hand-driven
// instead of by a real carrier USSD session. No real money moves at any
// point. corridorEdahabToEvc pays out via the EVC Plus wallet (SIM 1,
// PAYOUT_TEST_PIN) seeded in this file's before().

async function asJson(res: Response): Promise<any> {
  return res.json();
}

test("safe payout lifecycle: SMS match -> in_progress -> dial-attempt -> step1 -> step2 success -> Completed", async () => {
  const orderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 60,
    senderPhone: "252611131001",
  });

  const smsResult = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $60.00 ah",
    parsedAmount: 60,
    parsedPhone: "252611131001",
    simSlot: 2,
    transactionRef: nextRef(),
  });
  assert.equal(smsResult.body.matchedExchangeOrderId, orderId);
  const afterMatch = await queryOne<{ status: string }>(`SELECT status FROM exchange_orders WHERE id=$1`, [orderId]);
  assert.equal(afterMatch?.status, "in_progress");

  // "Agent App" starts the payout dial (mock -- no real phone/carrier).
  const startRes = await fetch(`${payoutBaseUrl}/agent/exchange/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ attemptNumber: 1 }),
  });
  assert.equal(startRes.status, 201);
  const start = await asJson(startRes);

  // Correct payout wallet/device/SIM: eDahab -> EVC Plus pays out via the
  // EVC Plus payout wallet, seeded on SIM 1.
  assert.equal(start.simSlot, 1, "must dial on the EVC Plus payout wallet's SIM (1), matching the corridor's payoutWalletId");
  assert.equal(start.step1UssdString, "*712*688000000*60*00#", "EVC Plus payout must dial *712*NUMBER*DOLLARS*CENTS#, receiver normalized to the bare 9-digit local number");
  assert.ok(!start.step1UssdString?.includes(PAYOUT_TEST_PIN), "step1 (number+amount only) must never contain the PIN");
  // PIN handling: present exactly here, over HTTPS, to this one authorized call.
  assert.equal(start.pin, PAYOUT_TEST_PIN);

  const step1Res = await fetch(`${payoutBaseUrl}/agent/exchange/dial-attempts/${start.id}/step1`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ status: "step1_success", responseMessage: "Fadlan geli lambarka sirta ah (PIN)" }),
  });
  assert.equal(step1Res.status, 200);

  // Deliberately includes the PIN in the mock carrier response text, to
  // prove scrubPin() actually redacts it before storage.
  const step2Res = await fetch(`${payoutBaseUrl}/agent/exchange/dial-attempts/${start.id}/step2`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      status: "success",
      responseMessage: `Lacagta waa la diray si guul leh (PIN: ${PAYOUT_TEST_PIN} confirmed)`,
      isFinalAttempt: true,
    }),
  });
  assert.equal(step2Res.status, 200);
  const step2Body = await asJson(step2Res);
  assert.ok(!JSON.stringify(step2Body).includes(PAYOUT_TEST_PIN), "scrubPin must strip the PIN from the stored/returned carrier response text");
  assert.ok(JSON.stringify(step2Body).includes("••••"), "the scrubbed text should show the masking marker in its place");

  const order = await queryOne<{ status: string; completed_at: string | null }>(
    `SELECT status, completed_at FROM exchange_orders WHERE id=$1`,
    [orderId]
  );
  assert.equal(order?.status, "completed");
  assert.ok(order?.completed_at, "completedAt must be set");
  assert.ok(await activityFor(orderId, "exchange_completed"), "expected an exchange_completed activity log entry");

  // PIN must never appear anywhere a Super Admin can see: the order-detail
  // response (including embedded dialAttempts) and the raw activity_log rows.
  const detailRes = await fetch(`${payoutBaseUrl}/admin/exchange/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${superAdminToken}` },
  });
  const detailBody = await asJson(detailRes);
  assert.ok(!JSON.stringify(detailBody).includes(PAYOUT_TEST_PIN), "the PIN must never appear in the admin order-detail response");
  assert.ok(!("pin" in (detailBody.dialAttempts?.[0] ?? {})), "a dial attempt must never expose a pin field to the dashboard");
  const activityRows = await query<{ old_value: unknown; new_value: unknown }>(
    `SELECT old_value, new_value FROM admin_activity_log WHERE entity_type='exchange_order' AND entity_id=$1`,
    [orderId]
  );
  for (const row of activityRows) assert.ok(!JSON.stringify(row).includes(PAYOUT_TEST_PIN), "the PIN must never be written into the activity log");

  // Duplicate-payout prevention: the order is completed, so a repeat
  // dial-attempt-start call must be rejected outright.
  const repeatRes = await fetch(`${payoutBaseUrl}/agent/exchange/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ attemptNumber: 1 }),
  });
  assert.equal(repeatRes.status, 409);
  assert.match((await asJson(repeatRes)).error, /completed/);
});

test("safe payout lifecycle: failed step2 marks the order Pending Manual Payout (never a silent Failed) and blocks any repeat automatic attempt", async () => {
  const orderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 61,
    senderPhone: "252611131002",
  });
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $61.00 ah",
    parsedAmount: 61,
    parsedPhone: "252611131002",
    simSlot: 2,
    transactionRef: nextRef(),
  });

  const startRes = await fetch(`${payoutBaseUrl}/agent/exchange/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ attemptNumber: 1 }),
  });
  const start = await asJson(startRes);

  // Simulate the carrier rejecting the payout (e.g. insufficient float) --
  // a mock failure, no real telecom involved.
  const step2Res = await fetch(`${payoutBaseUrl}/agent/exchange/dial-attempts/${start.id}/step2`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ status: "failed", responseMessage: "Insufficient balance", isFinalAttempt: true }),
  });
  assert.equal(step2Res.status, 200);

  const order = await queryOne<{ status: string; payout_failure_reason: string | null }>(
    `SELECT status, payout_failure_reason FROM exchange_orders WHERE id=$1`,
    [orderId]
  );
  // A confirmed customer payment must never end up sitting at a silent
  // 'failed' with no one alerted — a final dial-attempt failure now promotes
  // straight to pending_manual_payout (immediately, not after the 20-minute
  // safety window) so it shows up in the admin dashboard's action-required
  // list with a "Pay Manually" button.
  assert.equal(order?.status, "pending_manual_payout", "a failed final attempt must promote the order to Pending Manual Payout, never silently retry or sit at Failed");
  assert.match(order?.payout_failure_reason ?? "", /Insufficient balance/, "the carrier's response text must be recorded as the failure reason for the admin to see");

  const hasDialAttemptRow = await queryOne<{ has_dial_attempt: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM exchange_dial_attempts WHERE exchange_order_id=$1) AS has_dial_attempt`,
    [orderId]
  );
  assert.equal(hasDialAttemptRow?.has_dial_attempt, true, "a failed attempt still counts as 'already tried' for ExchangeSelfHealSweeper's skip check");

  const retryRes = await fetch(`${payoutBaseUrl}/agent/exchange/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ attemptNumber: 2 }),
  });
  assert.equal(retryRes.status, 409, "the order-level guard must independently block any further automatic attempt too");
  assert.match((await asJson(retryRes)).error, /pending_manual_payout/);
});

test("safe payout lifecycle: a duplicate dial-attempt-start call never issues the PIN twice", async () => {
  const orderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 62,
    senderPhone: "252611131003",
  });
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $62.00 ah",
    parsedAmount: 62,
    parsedPhone: "252611131003",
    simSlot: 2,
    transactionRef: nextRef(),
  });

  const first = await fetch(`${payoutBaseUrl}/agent/exchange/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ attemptNumber: 1 }),
  });
  const firstBody = await asJson(first);
  assert.equal(firstBody.pin, PAYOUT_TEST_PIN);

  // Same attemptNumber again -- two sweep passes racing, or a naive client
  // retry -- must hit the UNIQUE constraint's duplicate path and get NO
  // pin back at all.
  const second = await fetch(`${payoutBaseUrl}/agent/exchange/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ attemptNumber: 1 }),
  });
  assert.equal(second.status, 200);
  const secondBody = await asJson(second);
  assert.equal(secondBody.pin, undefined, "a duplicate dial-attempt-start call must never issue the PIN a second time");
  assert.equal(secondBody.id, firstBody.id, "must be the exact same attempt row, not a new one");

  const attemptRows = await query(`SELECT id FROM exchange_dial_attempts WHERE exchange_order_id=$1`, [orderId]);
  assert.equal(attemptRows.length, 1, "only one dial_attempts row must ever exist for this order+attemptNumber pair");
});

test("payout USSD string uses the correct carrier code for each wallet: EVC Plus *712*, eDahab *110*", async () => {
  // eDahab -> EVC Plus corridor pays out via the EVC Plus wallet: *712*NUMBER*AMOUNT#
  const evcOrderId = await insertExchangeOrder({
    corridorId: corridorEdahabToEvc,
    fromWalletId: "edahab",
    toWalletId: "evc_plus",
    amountSent: 63,
    senderPhone: "252611131004",
  });
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "Lacag $63.00 ah",
    parsedAmount: 63,
    parsedPhone: "252611131004",
    simSlot: 2,
    transactionRef: nextRef(),
  });
  const evcStart = await asJson(
    await fetch(`${payoutBaseUrl}/agent/exchange/orders/${evcOrderId}/dial-attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ attemptNumber: 1 }),
    })
  );
  assert.equal(evcStart.simSlot, 1);
  assert.equal(evcStart.step1UssdString, "*712*688000000*63*00#", "EVC Plus payout must dial *712*NUMBER*DOLLARS*CENTS#");

  // EVC Plus -> eDahab corridor pays out via the eDahab wallet: *110*NUMBER*AMOUNT#
  const edahabOrderId = await insertExchangeOrder({
    corridorId: corridorEvcToEdahab,
    fromWalletId: "evc_plus",
    toWalletId: "edahab",
    amountSent: 64,
    senderPhone: "252611131005",
  });
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "EVC Plus",
    body: "You have received $64.00 from 252611131005",
    parsedAmount: 64,
    parsedPhone: "252611131005",
    simSlot: 1,
    transactionRef: nextRef(),
  });
  const edahabStart = await asJson(
    await fetch(`${payoutBaseUrl}/agent/exchange/orders/${edahabOrderId}/dial-attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ attemptNumber: 1 }),
    })
  );
  assert.equal(edahabStart.simSlot, 2, "must dial on the eDahab payout wallet's SIM (2)");
  assert.equal(edahabStart.step1UssdString, "*110*688000000*64*00#", "eDahab payout must dial *110*NUMBER*DOLLARS*CENTS#");
});

// GET /exchange/wallets is public (no auth) -- the Customer App reads
// dialPrefix from it to build the customer's own "Dial to Pay" collection
// USSD string client-side (*{dialPrefix}*{collectionNumber}*{amount}#, same
// shape as the payout leg above), never anything payout/PIN related.
test("GET /exchange/wallets exposes each wallet's dial prefix for the customer's own Dial to Pay button", async () => {
  const res = await fetch(`${payoutBaseUrl}/exchange/wallets`);
  assert.equal(res.status, 200);
  const wallets = (await asJson(res)) as Array<{ id: string; dialPrefix: string }>;
  const evc = wallets.find((w) => w.id === "evc_plus");
  const edahab = wallets.find((w) => w.id === "edahab");
  assert.equal(evc?.dialPrefix, "712");
  assert.equal(edahab?.dialPrefix, "110");
});

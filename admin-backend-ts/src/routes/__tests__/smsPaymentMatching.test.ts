// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/smsPaymentMatching.test.ts
//
// Covers the Internet Store half of ingestPaymentSms() (smsLogs.routes.ts)
// for the three real, currently-supported incoming-payment SMS formats
// (PaymentSmsParsers.kt, agent-app): Hormuud EVC Plus (sender 192),
// Somtel eDahab (sender "eDahab"), and Somnet's EVC-Plus-branded format
// (also sender 192, disambiguated by "via Somnet Telecom"). Every SMS body
// used below is the exact real format captured in PaymentSmsParsers.kt's
// own doc comments -- these tests assert the BACKEND'S matching/dedup
// behavior against realistic payloads, not the Kotlin regex itself (that
// needs a JVM/Robolectric test, out of scope for this Node test file).
//
// End-to-end per provider: SMS ingested -> correct pending order matched ->
// verify-payment flips it to in_progress -> the agent's completion call
// flips it to completed ("PAID"), proving the whole pipeline the way a real
// Agent App upload + UssdOrchestrator dial would, minus the actual USSD
// round-trip (device-side, out of backend scope).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";
import { ordersRouter } from "../orders.routes.js";

const AGENT_ID = randomUUID();
const DEVICE_ID = "test-sms-device-1";
const CUSTOMER_ID = randomUUID();
const COMPANY_HORMUUD = "test-hormuud";
const COMPANY_SOMTEL = "test-somtel";
const COMPANY_SOMNET = "test-somnet";
const CATEGORY_ID = randomUUID();

let pkgHormuud: string;
let pkgSomtel: string;
let pkgSomnet: string;

const app = express();
app.use(express.json());
app.use(ordersRouter);
let server: http.Server;
let baseUrl: string;
let agentToken: string;

before(async () => {
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM payment_transactions`);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM packages`);
  await query(`DELETE FROM service_categories`);
  await query(`DELETE FROM company_payment_methods`);
  await query(`DELETE FROM companies WHERE id IN ($1,$2,$3)`, [COMPANY_HORMUUD, COMPANY_SOMTEL, COMPANY_SOMNET]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone='252611111199'`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1 OR phone='252699000099'`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test SMS Device')`, [DEVICE_ID]);
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000099', 'Test SMS Agent', 'x', $2)`,
    [AGENT_ID, DEVICE_ID]
  );
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252611111199')`, [CUSTOMER_ID]);

  for (const [id, name] of [
    [COMPANY_HORMUUD, "Test Hormuud"],
    [COMPANY_SOMTEL, "Test Somtel"],
    [COMPANY_SOMNET, "Test Somnet"],
  ]) {
    await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,$2,1,'#000000')`, [id, name]);
  }
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_HORMUUD]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_SOMTEL]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_SOMNET]);

  pkgHormuud = randomUUID();
  pkgSomtel = randomUUID();
  pkgSomnet = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,$3,'1GB',1,1024)`, [pkgHormuud, COMPANY_HORMUUD, CATEGORY_ID]);
  await query(`INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,$3,'1GB',1,1024)`, [pkgSomtel, COMPANY_SOMTEL, CATEGORY_ID]);
  await query(`INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,$3,'1GB',1,1024)`, [pkgSomnet, COMPANY_SOMNET, CATEGORY_ID]);

  agentToken = signAccessToken(AGENT_ID, "agent");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

let orderCounter = 0;
async function insertOrder(params: {
  companyId: string;
  packageId: string;
  amount: number;
  senderPhone: string;
  status?: string;
  ageHours?: number;
}): Promise<string> {
  const id = `SMSTEST${++orderCounter}`;
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, CUSTOMER_ID, params.companyId, params.packageId, params.amount, params.status ?? "pending", params.senderPhone, "252611111199"]
  );
  if (params.ageHours) {
    await query(`UPDATE orders SET updated_at = now() - interval '${params.ageHours} hours' WHERE id=$1`, [id]);
  }
  return id;
}

async function asJson(res: Response): Promise<any> {
  return res.json();
}

// ==================== Provider 1: Hormuud EVC Plus (sender 192) ====================

test("EVC Plus (Hormuud, sender 192): real SMS matches the correct order and completes the full pending -> in_progress -> completed pipeline", async () => {
  const orderId = await insertOrder({ companyId: COMPANY_HORMUUD, packageId: pkgHormuud, amount: 0.1, senderPhone: "610346060" });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "[-EVCPLUS-] waxaad $0.1 ka heshay 0610346060, Tar: 24/07/26",
    parsedProvider: "Hormuud",
    parsedAmount: 0.1,
    parsedPhone: "0610346060",
    simSlot: 1,
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedOrderId, orderId, "must match the exact order the customer paid for, not a different one");
  assert.equal(result.body.duplicate, false);

  const smsRow = await queryOne<{ parsed_provider: string; parsed_amount: string; parsed_phone: string }>(
    `SELECT parsed_provider, parsed_amount, parsed_phone FROM sms_logs WHERE id=$1`,
    [result.body.id]
  );
  assert.equal(smsRow?.parsed_provider, "Hormuud", "sms_logs must record which provider sent this (192 = Hormuud EVC Plus)");
  assert.equal(Number(smsRow?.parsed_amount), 0.1, "the exact amount actually sent must be recorded, unmodified");
  assert.equal(smsRow?.parsed_phone, "0610346060");

  const verifyRes = await fetch(`${baseUrl}/agent/orders/${orderId}/verify-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ smsLogId: result.body.id }),
  });
  assert.equal(verifyRes.status, 200);
  const afterVerify = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(afterVerify?.status, "in_progress", "the system itself must move the order out of pending once the real SMS is verified");

  const completeRes = await fetch(`${baseUrl}/agent/orders/${orderId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
  });
  assert.equal(completeRes.status, 200);
  const finalOrder = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(finalOrder?.status, "completed", "order must reach PAID/completed automatically -- never manually set");
});

test("EVC Plus: wrong amount does not match any order", async () => {
  await insertOrder({ companyId: COMPANY_HORMUUD, packageId: pkgHormuud, amount: 0.22, senderPhone: "610346061" });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "[-EVCPLUS-] waxaad $0.5 ka heshay 0610346061, Tar: 24/07/26",
    parsedProvider: "Hormuud",
    parsedAmount: 0.5,
    parsedPhone: "0610346061",
    simSlot: 1,
  });
  assert.equal(result.body.matchedOrderId, null);
  const row = await queryOne<{ match_failure_reason: string }>(`SELECT match_failure_reason FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.match(row!.match_failure_reason!, /No pending order for \$0\.5/);
});

test("EVC Plus: wrong sender phone does not match a different customer's order for the same amount", async () => {
  await insertOrder({ companyId: COMPANY_HORMUUD, packageId: pkgHormuud, amount: 0.33, senderPhone: "610346062" });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "[-EVCPLUS-] waxaad $0.33 ka heshay 0699999999, Tar: 24/07/26",
    parsedProvider: "Hormuud",
    parsedAmount: 0.33,
    parsedPhone: "0699999999",
    simSlot: 1,
  });
  assert.equal(result.body.matchedOrderId, null, "must never fall back to matching by amount alone");
  const row = await queryOne<{ match_failure_reason: string }>(`SELECT match_failure_reason FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.match(row!.match_failure_reason!, /none for phone/);
});

test("EVC Plus: SMS arriving on the wrong SIM slot for a device-linked payment method is rejected, order stays pending", async () => {
  const methodId = randomUUID();
  await query(
    `INSERT INTO company_payment_methods (id, company_id, method, label, device_id, sim_slot) VALUES ($1,$2,'evc_plus','EVC Plus',$3,1)`,
    [methodId, COMPANY_HORMUUD, DEVICE_ID]
  );
  const orderId = await query<{ id: string }>(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone, payment_method_id)
     VALUES ($1,$2,$3,$4,0.44,'pending','610346063','252611111199',$5) RETURNING id`,
    [`SMSTEST${++orderCounter}`, CUSTOMER_ID, COMPANY_HORMUUD, pkgHormuud, methodId]
  ).then((r) => r[0].id);

  // Right amount, right phone -- but arrives on SIM 2, while this method is
  // linked to SIM 1 on this exact device.
  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "[-EVCPLUS-] waxaad $0.44 ka heshay 0610346063, Tar: 24/07/26",
    parsedProvider: "Hormuud",
    parsedAmount: 0.44,
    parsedPhone: "0610346063",
    simSlot: 2,
  });
  assert.equal(result.body.matchedOrderId, null, "a payment on the wrong SIM must never be silently accepted");
  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "pending");
  await query(`DELETE FROM company_payment_methods WHERE id=$1`, [methodId]);
});

// ==================== Provider 2: Somtel eDahab (sender "eDahab") ====================

test("eDahab (Somtel, sender 'eDahab'): real SMS format matches the correct order and completes the pipeline", async () => {
  const orderId = await insertOrder({ companyId: COMPANY_SOMTEL, packageId: pkgSomtel, amount: 0.22, senderPhone: "620346060" });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body:
      "0.22 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060  Aqanoosiga : PP260718.0005.F75709 " +
      "Haraagaaga Cusubi Waa: 2.61 Dollar..Tariikh:18-07-2026[-eDahab-Service-]",
    parsedProvider: "Somtel",
    parsedAmount: 0.22,
    parsedPhone: "620346060",
    transactionRef: "PP260718.0005.F75709",
    simSlot: 2,
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedOrderId, orderId);
  const smsRow = await queryOne<{ parsed_provider: string; transaction_ref: string }>(
    `SELECT parsed_provider, transaction_ref FROM sms_logs WHERE id=$1`,
    [result.body.id]
  );
  assert.equal(smsRow?.parsed_provider, "Somtel");
  assert.equal(smsRow?.transaction_ref, "PP260718.0005.F75709");

  const verifyRes = await fetch(`${baseUrl}/agent/orders/${orderId}/verify-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ smsLogId: result.body.id }),
  });
  assert.equal(verifyRes.status, 200);
  assert.equal((await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]))?.status, "in_progress");

  await fetch(`${baseUrl}/agent/orders/${orderId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
  });
  assert.equal((await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]))?.status, "completed");
});

test("eDahab: a redelivered/duplicate SMS with the same Aqanoosiga reference is rejected as already_processed, not re-matched or double-paid", async () => {
  const orderId = await insertOrder({ companyId: COMPANY_SOMTEL, packageId: pkgSomtel, amount: 0.5, senderPhone: "620346064" });
  const body =
    "0.5 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346064  Aqanoosiga : PP260719.0009.F00001 " +
    "Haraagaaga Cusubi Waa: 3.00 Dollar..Tariikh:19-07-2026[-eDahab-Service-]";

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body,
    parsedProvider: "Somtel",
    parsedAmount: 0.5,
    parsedPhone: "620346064",
    transactionRef: "PP260719.0009.F00001",
    simSlot: 2,
  });
  assert.equal(first.body.matchedOrderId, orderId);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body, // identical redelivered broadcast
    parsedProvider: "Somtel",
    parsedAmount: 0.5,
    parsedPhone: "620346064",
    transactionRef: "PP260719.0009.F00001",
    simSlot: 2,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.id, first.body.id, "must return the original sms_logs row, never create a second one");

  const txRows = await query(`SELECT status FROM payment_transactions WHERE order_id=$1`, [orderId]);
  const activeRows = txRows.filter((r: any) => r.status !== "duplicate_blocked");
  assert.equal(activeRows.length, 1, "exactly one active (non-duplicate) payment_transactions row -- the customer must never be charged/processed twice");
});

test("eDahab: a second real SMS arriving after the order was already fulfilled by a different payment is blocked as duplicate, order untouched", async () => {
  const orderId = await insertOrder({ companyId: COMPANY_SOMTEL, packageId: pkgSomtel, amount: 0.6, senderPhone: "620346065" });

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "0.6 Dollar Ayaad Ka Heshay X.Lambarka :620346065 Aqanoosiga : REF-A",
    parsedProvider: "Somtel",
    parsedAmount: 0.6,
    parsedPhone: "620346065",
    transactionRef: "REF-A",
    simSlot: 2,
  });
  assert.equal(first.body.matchedOrderId, orderId);

  // A different transaction_ref/body for the exact same amount+phone, before
  // the order has left 'pending' (verify-payment hasn't run yet) -- must be
  // blocked by the active-payment-transaction guard, not matched again.
  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: "0.6 Dollar Ayaad Ka Heshay X.Lambarka :620346065 Aqanoosiga : REF-B",
    parsedProvider: "Somtel",
    parsedAmount: 0.6,
    parsedPhone: "620346065",
    transactionRef: "REF-B",
    simSlot: 2,
  });
  assert.equal(second.body.matchedOrderId, orderId, "still reports the order it collided with, for visibility");
  assert.equal(second.body.duplicate, true);

  const txRows = await query<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1 ORDER BY created_at ASC`, [orderId]);
  assert.equal(txRows.length, 2);
  assert.equal(txRows[0].status, "pending");
  assert.equal(txRows[1].status, "duplicate_blocked", "the second, colliding payment must be recorded as blocked, never silently processed");
});

// ==================== Provider 3: Somnet EVC-Plus-branded (also sender 192) ====================

test("Somnet EVC Plus (sender 192, 'via Somnet Telecom' body): matches correctly and is never confused with Hormuud's own 192 format", async () => {
  const orderId = await insertOrder({ companyId: COMPANY_SOMNET, packageId: pkgSomnet, amount: 0.1, senderPhone: "685115555" });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "[-EVCPlus-] $0.1 ayaad ka Heshay AARAN DATA SERVICE (252685115555),27/07/26 04:49:01 via Somnet Telecom, Haraagaagu waa $4.95.",
    parsedProvider: "Somnet",
    parsedAmount: 0.1,
    parsedPhone: "252685115555",
    simSlot: 1,
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.matchedOrderId, orderId);
  const smsRow = await queryOne<{ parsed_provider: string }>(`SELECT parsed_provider FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.equal(smsRow?.parsed_provider, "Somnet", "must be tagged Somnet, not Hormuud, even though both use sender 192");
});

// ==================== Cross-provider safety ====================

test("multiple pending orders for the same amount: the OLDEST one is matched, never a random one", async () => {
  // Two DIFFERENT packages (same company, same amount, same customer/phone) --
  // idx_orders_pending_content_dedup only collapses same customer+company+
  // package+amount, so two legitimately distinct pending orders for the same
  // amount can coexist (e.g. re-visiting Checkout for two different packages
  // that happen to cost the same). The oldest one must win the payment.
  const secondPkg = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,$3,'1GB (alt)',0.77,1024)`, [secondPkg, COMPANY_HORMUUD, CATEGORY_ID]);

  const older = await insertOrder({ companyId: COMPANY_HORMUUD, packageId: pkgHormuud, amount: 0.77, senderPhone: "610346099" });
  await new Promise((r) => setTimeout(r, 20));
  await insertOrder({ companyId: COMPANY_HORMUUD, packageId: secondPkg, amount: 0.77, senderPhone: "610346099" });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "[-EVCPLUS-] waxaad $0.77 ka heshay 0610346099, Tar: 24/07/26",
    parsedProvider: "Hormuud",
    parsedAmount: 0.77,
    parsedPhone: "0610346099",
    simSlot: 1,
  });
  assert.equal(result.body.matchedOrderId, older, "the customer's real payment must complete the order they created first");
});

test("an SMS that fails to parse a usable amount/phone is safely rejected without touching any order", async () => {
  const orderId = await insertOrder({ companyId: COMPANY_HORMUUD, packageId: pkgHormuud, amount: 0.88, senderPhone: "610346100" });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "unknown-sender",
    body: "Hey, are we still meeting later?", // an ordinary personal text, not a payment SMS
  });
  assert.equal(result.body.matchedOrderId, null);
  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "pending", "an unrelated/unparseable SMS must never affect an unrelated order");
});

test("a payment SMS outside the 24h match window does not match a stale pending order", async () => {
  await insertOrder({ companyId: COMPANY_HORMUUD, packageId: pkgHormuud, amount: 0.99, senderPhone: "610346101", ageHours: 30 });

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "[-EVCPLUS-] waxaad $0.99 ka heshay 0610346101, Tar: 24/07/26",
    parsedProvider: "Hormuud",
    parsedAmount: 0.99,
    parsedPhone: "0610346101",
    simSlot: 1,
  });
  assert.equal(result.body.matchedOrderId, null);
});

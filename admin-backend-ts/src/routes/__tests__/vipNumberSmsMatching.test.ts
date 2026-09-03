// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/vipNumberSmsMatching.test.ts
//
// Covers the automatic VIP Number / VIP Number Package SMS matcher added to
// ingestPaymentSms() (smsLogs.routes.ts) via vipNumberSmsMatching.ts: a
// valid match marks the order paid and the VIP number(s) sold with no admin
// tap, wrong phone/amount never match, a redelivered SMS never double-
// processes an order, and a normal Internet Store payment SMS is completely
// unaffected (VIP matching only ever runs after every other matcher has
// found nothing).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";

const AGENT_ID = randomUUID();
const DEVICE_ID = "test-vip-sms-device-1";
const COMPANY_ID = "test-vip-sms-company";
const CUSTOMER_ID = randomUUID();

before(async () => {
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM vip_number_order_status_history`);
  await query(`DELETE FROM vip_number_package_order_status_history`);
  await query(`DELETE FROM vip_number_package_order_items`);
  await query(`DELETE FROM vip_number_package_orders`);
  await query(`DELETE FROM vip_number_package_items`);
  await query(`DELETE FROM vip_number_packages`);
  await query(`DELETE FROM vip_number_orders`);
  await query(`DELETE FROM vip_numbers`);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM company_payment_methods`);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  // Scoped to just this file's own rows (by id) rather than a blanket
  // DELETE — agent_devices/agents/companies are shared, seeded tables
  // (see db/seed.ts's sim_routing rows, which NOT NULL-reference seeded
  // agent_devices) that other fixtures/seed data also depend on.
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test VIP SMS Device 1') ON CONFLICT (id) DO NOTHING`, [DEVICE_ID]);
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699111199', 'Test Agent', 'x', $2) ON CONFLICT (id) DO NOTHING`,
    [AGENT_ID, DEVICE_ID]
  );
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1, 'Test Co', 1, '#000000', 'EVC Plus', '610000001') ON CONFLICT (id) DO NOTHING`,
    [COMPANY_ID]
  );
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '615557000') ON CONFLICT (id) DO NOTHING`, [CUSTOMER_ID]);
  await query(`INSERT INTO shop_payment_methods (method, label, payment_number, ussd_template) VALUES ('evc', 'EVC Plus', '620338686', '*712*620338686*{amount}#') ON CONFLICT (method) DO NOTHING`);
});

after(async () => {
  await pool.end();
});

async function createVipNumber(phoneNumber: string, price: number): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO vip_numbers (id, company_id, phone_number, category, price, status) VALUES ($1,$2,$3,'gold',$4,'reserved')`,
    [id, COMPANY_ID, phoneNumber, price]
  );
  return id;
}

async function createPendingVipOrder(vipNumberId: string, senderPhone: string, price: number): Promise<string> {
  const id = "VIP" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO vip_number_orders (id, vip_number_id, customer_id, company_id, phone_number, category, price, customer_full_name, payment_method, sender_phone)
     VALUES ($1,$2,$3,$4,'620338686','gold',$5,'Test Customer Full Name','evc',$6)`,
    [id, vipNumberId, CUSTOMER_ID, COMPANY_ID, price, senderPhone]
  );
  return id;
}

test("valid VIP Number order SMS marks the order paid, sells the number, and links the SMS", async () => {
  const vipNumberId = await createVipNumber("620111111", 0.5);
  const orderId = await createPendingVipOrder(vipNumberId, "619991299", 0.5);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-vip-valid",
    parsedProvider: "Hormuud",
    parsedAmount: 0.5,
    parsedPhone: "619991299",
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedVipNumberOrderId, orderId);
  assert.equal(result.body.matchedOrderId, null);

  const order = await queryOne<{ payment_status: string; status: string }>(
    `SELECT payment_status, status FROM vip_number_orders WHERE id=$1`,
    [orderId]
  );
  assert.equal(order!.payment_status, "paid");
  assert.equal(order!.status, "processing");

  const number = await queryOne<{ status: string }>(`SELECT status FROM vip_numbers WHERE id=$1`, [vipNumberId]);
  assert.equal(number!.status, "sold");

  const smsLog = await queryOne<{ matched_vip_number_order_id: string }>(
    `SELECT matched_vip_number_order_id FROM sms_logs WHERE id=$1`,
    [result.body.id]
  );
  assert.equal(smsLog!.matched_vip_number_order_id, orderId);
});

test("wrong sender phone does not match — order stays pending", async () => {
  const vipNumberId = await createVipNumber("620222222", 0.6);
  const orderId = await createPendingVipOrder(vipNumberId, "619992222", 0.6);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-vip-wrong-phone",
    parsedAmount: 0.6,
    parsedPhone: "619999999",
  });

  assert.equal(result.body.matchedVipNumberOrderId, null);
  const order = await queryOne<{ payment_status: string }>(`SELECT payment_status FROM vip_number_orders WHERE id=$1`, [orderId]);
  assert.equal(order!.payment_status, "pending");
});

test("wrong amount does not match", async () => {
  const vipNumberId = await createVipNumber("620333333", 0.7);
  await createPendingVipOrder(vipNumberId, "619993333", 0.7);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-vip-wrong-amount",
    parsedAmount: 0.71,
    parsedPhone: "619993333",
  });

  assert.equal(result.body.matchedVipNumberOrderId, null);
});

test("a redelivered SMS (same body/sender/minute) never double-processes the order", async () => {
  const vipNumberId = await createVipNumber("620444444", 0.8);
  const orderId = await createPendingVipOrder(vipNumberId, "619994444", 0.8);
  const receivedAt = new Date().toISOString();

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "vip-redelivery-test-body",
    parsedAmount: 0.8,
    parsedPhone: "619994444",
    receivedAt,
  });
  assert.equal(first.body.matchedVipNumberOrderId, orderId);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "vip-redelivery-test-body",
    parsedAmount: 0.8,
    parsedPhone: "619994444",
    receivedAt,
  });
  assert.equal(second.body.duplicate, true);

  const order = await queryOne<{ payment_status: string }>(`SELECT payment_status FROM vip_number_orders WHERE id=$1`, [orderId]);
  assert.equal(order!.payment_status, "paid", "still paid exactly once, not re-processed");
});

test("an already-paid order is never re-matched by a second, different SMS of the same amount/phone", async () => {
  const vipNumberId = await createVipNumber("620555555", 0.9);
  const orderId = await createPendingVipOrder(vipNumberId, "619995555", 0.9);

  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "vip-first-real-payment",
    parsedAmount: 0.9,
    parsedPhone: "619995555",
  });

  // A second VIP order, same amount+phone (e.g. customer re-orders same price) —
  // must not accidentally match the SMS that already paid the first order (it
  // won't reach here at all since ingestPaymentSms already consumed it above),
  // but confirm the first order's own second (different) SMS doesn't re-fire it.
  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "vip-second-different-sms-same-amount-phone",
    parsedAmount: 0.9,
    parsedPhone: "619995555",
  });
  // No longer a candidate (payment_status is no longer 'pending'), so this
  // SMS matches nothing at all for VIP — it's simply unmatched, not an error.
  assert.equal(second.body.matchedVipNumberOrderId, null);

  const order = await queryOne<{ payment_status: string }>(`SELECT payment_status FROM vip_number_orders WHERE id=$1`, [orderId]);
  assert.equal(order!.payment_status, "paid");
});

test("VIP Number Package order SMS marks the order paid and sells every member number", async () => {
  const numberA = await createVipNumber("620666601", 1.5);
  const numberB = await createVipNumber("620666602", 1.5);
  const packageId = randomUUID();
  await query(`INSERT INTO vip_number_packages (id, size, price) VALUES ($1, 2, 3.0)`, [packageId]);
  await query(`INSERT INTO vip_number_package_items (package_id, vip_number_id, position) VALUES ($1,$2,0),($1,$3,1)`, [
    packageId,
    numberA,
    numberB,
  ]);
  const orderId = "VIP" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO vip_number_package_orders (id, package_id, size, price, customer_id, customer_full_name, payment_method, sender_phone)
     VALUES ($1,$2,2,3.0,$3,'Test Customer Full Name','evc','619996666')`,
    [orderId, packageId, CUSTOMER_ID]
  );

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-vip-package-valid",
    parsedAmount: 3.0,
    parsedPhone: "619996666",
  });

  assert.equal(result.body.matchedVipNumberPackageOrderId, orderId);

  const order = await queryOne<{ payment_status: string; status: string }>(
    `SELECT payment_status, status FROM vip_number_package_orders WHERE id=$1`,
    [orderId]
  );
  assert.equal(order!.payment_status, "paid");
  assert.equal(order!.status, "processing");

  const numbers = await query<{ status: string }>(`SELECT status FROM vip_numbers WHERE id IN ($1,$2)`, [numberA, numberB]);
  assert.ok(numbers.every((n) => n.status === "sold"), "every member number must be sold");
});

test("a normal Internet Store payment SMS is completely unaffected — VIP matching only runs after everything else finds nothing", async () => {
  const orderId = "ORD" + Math.floor(100000000 + Math.random() * 900000000);
  const customerId = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '619997777')`, [customerId]);
  const categoryId = randomUUID();
  const packageId = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,'Test Pkg',5)`, [
    packageId,
    COMPANY_ID,
    categoryId,
  ]);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, sender_phone, receiver_phone, amount, status)
     VALUES ($1,$2,$3,$4,'619997777','619997777',5,'pending')`,
    [orderId, customerId, COMPANY_ID, packageId]
  );
  // A VIP number order that would otherwise match the exact same amount+phone.
  const vipNumberId = await createVipNumber("620777777", 5);
  const vipOrderId = await createPendingVipOrder(vipNumberId, "619997777", 5);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "store-order-vip-precedence-test",
    parsedAmount: 5,
    parsedPhone: "619997777",
  });

  assert.equal(result.body.matchedOrderId, orderId, "the Store order must win — it's matched first");
  assert.equal(result.body.matchedVipNumberOrderId, null, "VIP matching must never run when Store already matched");

  const vipOrder = await queryOne<{ payment_status: string }>(`SELECT payment_status FROM vip_number_orders WHERE id=$1`, [vipOrderId]);
  assert.equal(vipOrder!.payment_status, "pending", "the VIP order must remain untouched");
});

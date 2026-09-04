// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/shopSmsMatching.test.ts
//
// Covers the automatic Shop order SMS matcher added to ingestPaymentSms()
// (smsLogs.routes.ts) via shopSmsMatching.ts: a valid match marks the order
// paid (and advances 'pending' -> 'processing') with no admin tap, wrong
// phone/amount never match, a redelivered SMS never double-processes an
// order, and Shop matching only ever runs once every earlier matcher (Store,
// Exchange, Reseller, VIP Number/Package) has already found nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";

const AGENT_ID = randomUUID();
const CUSTOMER_ID = randomUUID();

// A "639" prefix is used throughout this file for every sender/customer
// phone number, deliberately distinct from every range already used by
// other *.test.ts files sharing this same test database (see the sibling
// vipNumberSmsMatching.test.ts/smsPaymentMatching.test.ts etc.) — every
// other test file's before() only cleans up rows keyed by its own fixed
// ids, so a phone number reused across files would collide against a row
// left over from an earlier run in the same database.
before(async () => {
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM shop_order_status_history`);
  await query(`DELETE FROM shop_order_items`);
  await query(`DELETE FROM shop_orders`);
  await query(`DELETE FROM orders WHERE sender_phone LIKE '639%'`);
  await query(`DELETE FROM customers WHERE id=$1 OR phone LIKE '639%'`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1 OR phone='252699222299'`, [AGENT_ID]);

  await query(
    `INSERT INTO agents (id, phone, name, password_hash) VALUES ($1, '252699222299', 'Test Agent', 'x') ON CONFLICT (id) DO NOTHING`,
    [AGENT_ID]
  );
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '639990000') ON CONFLICT (id) DO NOTHING`, [CUSTOMER_ID]);
  await query(
    `INSERT INTO shop_payment_methods (method, label, payment_number, ussd_template) VALUES ('evc', 'EVC Plus', '610338686', '*712*610338686*{amount}#') ON CONFLICT (method) DO NOTHING`
  );
});

after(async () => {
  await pool.end();
});

async function createPendingShopOrder(senderPhone: string, totalAmount: number): Promise<string> {
  const id = "SHP" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO shop_orders (id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount, dedup_key)
     VALUES ($1,$2,'evc',$3,'Test Customer','639990000','Test Address',$4,$1)`,
    [id, CUSTOMER_ID, senderPhone, totalAmount]
  );
  return id;
}

test("valid Shop order SMS marks the order paid, advances to processing, and links the SMS", async () => {
  const orderId = await createPendingShopOrder("639991299", 0.5);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-shop-valid",
    parsedProvider: "Hormuud",
    parsedAmount: 0.5,
    parsedPhone: "639991299",
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.matchedShopOrderId, orderId);
  assert.equal(result.body.matchedOrderId, null);

  const order = await queryOne<{ payment_status: string; status: string; paid_at: string | null }>(
    `SELECT payment_status, status, paid_at FROM shop_orders WHERE id=$1`,
    [orderId]
  );
  assert.equal(order!.payment_status, "paid");
  assert.equal(order!.status, "processing");
  assert.ok(order!.paid_at, "paid_at must be set");

  const smsLog = await queryOne<{ matched_shop_order_id: string }>(`SELECT matched_shop_order_id FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.equal(smsLog!.matched_shop_order_id, orderId);

  const history = await queryOne<{ status: string; note: string }>(
    `SELECT status, note FROM shop_order_status_history WHERE order_id=$1 ORDER BY changed_at DESC LIMIT 1`,
    [orderId]
  );
  assert.equal(history!.status, "processing");
  assert.match(history!.note, /automatically via SMS/);
});

test("wrong sender phone does not match — order stays pending", async () => {
  const orderId = await createPendingShopOrder("639992222", 0.6);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-shop-wrong-phone",
    parsedAmount: 0.6,
    parsedPhone: "639999999",
  });

  assert.equal(result.body.matchedShopOrderId, null);
  const order = await queryOne<{ payment_status: string }>(`SELECT payment_status FROM shop_orders WHERE id=$1`, [orderId]);
  assert.equal(order!.payment_status, "pending");
});

test("wrong amount does not match", async () => {
  await createPendingShopOrder("639993333", 0.7);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "test-shop-wrong-amount",
    parsedAmount: 0.71,
    parsedPhone: "639993333",
  });

  assert.equal(result.body.matchedShopOrderId, null);
});

test("a redelivered SMS (same body/sender/minute) never double-processes the order", async () => {
  const orderId = await createPendingShopOrder("639994444", 0.8);
  const receivedAt = new Date().toISOString();

  const first = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "shop-redelivery-test-body",
    parsedAmount: 0.8,
    parsedPhone: "639994444",
    receivedAt,
  });
  assert.equal(first.body.matchedShopOrderId, orderId);

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "shop-redelivery-test-body",
    parsedAmount: 0.8,
    parsedPhone: "639994444",
    receivedAt,
  });
  assert.equal(second.body.duplicate, true);

  const order = await queryOne<{ payment_status: string }>(`SELECT payment_status FROM shop_orders WHERE id=$1`, [orderId]);
  assert.equal(order!.payment_status, "paid", "still paid exactly once, not re-processed");
});

test("an already-paid order is never re-matched by a second, different SMS of the same amount/phone", async () => {
  const orderId = await createPendingShopOrder("639995555", 0.9);

  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "shop-first-real-payment",
    parsedAmount: 0.9,
    parsedPhone: "639995555",
  });

  const second = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "shop-second-different-sms-same-amount-phone",
    parsedAmount: 0.9,
    parsedPhone: "639995555",
  });
  assert.equal(second.body.matchedShopOrderId, null);

  const order = await queryOne<{ payment_status: string }>(`SELECT payment_status FROM shop_orders WHERE id=$1`, [orderId]);
  assert.equal(order!.payment_status, "paid");
});

test("a normal Internet Store payment SMS is completely unaffected — Shop matching only runs after everything else finds nothing", async () => {
  const companyId = "test-shop-sms-company";
  const orderId = "ORD" + Math.floor(100000000 + Math.random() * 900000000);
  const customerId = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '639997777')`, [customerId]);
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1, 'Test Co Shop', 2, '#000000', 'EVC Plus', '610000002') ON CONFLICT (id) DO NOTHING`,
    [companyId]
  );
  const categoryId = randomUUID();
  const packageId = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,'Test Pkg',5)`, [
    packageId,
    companyId,
    categoryId,
  ]);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, sender_phone, receiver_phone, amount, status)
     VALUES ($1,$2,$3,$4,'639997777','639997777',5,'pending')`,
    [orderId, customerId, companyId, packageId]
  );
  // A Shop order that would otherwise match the exact same amount+phone.
  const shopOrderId = await createPendingShopOrder("639997777", 5);

  const result = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: "store-order-shop-precedence-test",
    parsedAmount: 5,
    parsedPhone: "639997777",
  });

  assert.equal(result.body.matchedOrderId, orderId, "the Store order must win — it's matched first");
  assert.equal(result.body.matchedShopOrderId, null, "Shop matching must never run when Store already matched");

  const shopOrder = await queryOne<{ payment_status: string }>(`SELECT payment_status FROM shop_orders WHERE id=$1`, [shopOrderId]);
  assert.equal(shopOrder!.payment_status, "pending", "the Shop order must remain untouched");

  await query(`DELETE FROM orders WHERE id=$1`, [orderId]);
  await query(`DELETE FROM packages WHERE id=$1`, [packageId]);
  await query(`DELETE FROM companies WHERE id=$1`, [companyId]);
});

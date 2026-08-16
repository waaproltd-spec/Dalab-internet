// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   SOMLINK_PHONE=647177774 SOMLINK_PASSWORD=test-only \
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/somlinkDelivery.test.ts
//
// Never calls the real SOMLINK API — every test mocks global.fetch, so no
// run of this suite can move real wallet funds. Covers: a confirmed
// success completing the order (with macaash credited, exactly like every
// other completion path), a structured SOMLINK error leaving the order
// in_progress without completing it, a network/timeout failure landing as
// 'ambiguous' rather than 'failed' or 'completed', the duplicate-protection
// guarantee (a second concurrent/retried attempt for the same order is
// rejected before any HTTP call is made), the automatic path never
// re-attempting an order that already left 'pending' once, and the manual
// admin retry route succeeding after a prior 'failed' attempt.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { deliverViaSomlink, somlinkRouter } from "../somlink.routes.js";
import { verifyOrderAndGenerateUssd, completeOrderById } from "../orders.routes.js";
import { __setCachedTokenForTests } from "../../services/somlink.js";

const CUSTOMER_ID = randomUUID();
const ADMIN_ID = randomUUID();
const COMPANY_ID = "test-somlink-co";
const USSD_COMPANY_ID = "test-ussd-co";
const CATEGORY_ID = "data";
const CUSTOMER_PHONE = "252640000045";

let packageId: string;
let ussdPackageId: string;
let superAdminToken: string;
let app: ReturnType<typeof express>;
let server: http.Server;
let baseUrl: string;

function makeOrderId(): string {
  return "DLB" + Math.floor(100000000 + Math.random() * 900000000);
}

async function insertOrder(overrides: Partial<{ packageId: string; companyId: string; amount: number }> = {}) {
  const id = makeOrderId();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, receiver_phone, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
    [id, CUSTOMER_ID, overrides.companyId ?? COMPANY_ID, overrides.packageId ?? packageId, overrides.amount ?? 1, CUSTOMER_PHONE]
  );
  return id;
}

before(async () => {
  await query(`DELETE FROM somlink_transactions`);
  await query(`DELETE FROM ussd_dial_attempts`);
  await query(`DELETE FROM macaash_transactions`);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM packages`);
  await query(`DELETE FROM companies`);
  await query(`DELETE FROM customers`);
  await query(`DELETE FROM admin_activity_log`);
  await query(`DELETE FROM admin_users`);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'somlink-test-admin@example.com','x','super_admin')`, [ADMIN_ID]);

  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252677000099')`, [CUSTOMER_ID]);
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, fulfillment_method) VALUES ($1,'SOMLINK Test',1,'#000000','somlink')`,
    [COMPANY_ID]
  );
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, fulfillment_method) VALUES ($1,'USSD Test',1,'#000000','ussd')`,
    [USSD_COMPANY_ID]
  );
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, mb, somlink_bundle_id)
       VALUES (gen_random_uuid(),$1,$2,'3GB + 3GB',1,3072,20061) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;
  ussdPackageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, mb)
       VALUES (gen_random_uuid(),$1,$2,'1GB',1,1024) RETURNING id`,
      [USSD_COMPANY_ID, CATEGORY_ID]
    )
  )!.id;

  superAdminToken = signAccessToken(ADMIN_ID, "super_admin");

  // requireStaff() verifies the JWT itself (see auth/middleware.ts) — no
  // stand-in auth middleware needed, the real signAccessToken-issued token
  // above is enough.
  app = express();
  app.use(express.json());
  app.use(somlinkRouter);
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  __setCachedTokenForTests("test-token");
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("a confirmed DATA_PAID_SUCCESSFULLY response completes the order and credits macaash", async (t) => {
  const orderId = await insertOrder();
  await query(`UPDATE orders SET status='in_progress', macaash_earned=10 WHERE id=$1`, [orderId]);

  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ code: 200, message: "DATA_PAID_SUCCESSFULLY", paid_amount: 1, data_phone: CUSTOMER_PHONE, balance: 0.7 }), { status: 200 })
  );

  const result = await deliverViaSomlink({ id: orderId, customer_id: CUSTOMER_ID, package_id: packageId, receiver_phone: CUSTOMER_PHONE, amount: 1, macaash_earned: 10 });
  assert.equal(result.ok, true);

  const tx = await queryOne<{ status: string; response_code: number }>(`SELECT status, response_code FROM somlink_transactions WHERE order_id=$1`, [orderId]);
  assert.equal(tx?.status, "success");
  assert.equal(tx?.response_code, 200);

  // deliverViaSomlink never completes the order itself (see its own doc
  // comment) — the caller does, exactly like every other completion path.
  const completion = await completeOrderById(orderId);
  assert.equal(completion?.success, true);
  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "completed");
  const customer = await queryOne<{ macaash_points: number }>(`SELECT macaash_points FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  assert.ok((customer?.macaash_points ?? 0) >= 10);
});

test("a structured SOMLINK error (e.g. insufficient balance) leaves the order in_progress, not completed", async (t) => {
  const orderId = await insertOrder();
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [orderId]);

  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ code: 400, message: "INSUFFICIENT_BALANCE" }), { status: 200 })
  );

  const result = await deliverViaSomlink({ id: orderId, customer_id: CUSTOMER_ID, package_id: packageId, receiver_phone: CUSTOMER_PHONE, amount: 1 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "somlink_declined");

  const tx = await queryOne<{ status: string; response_message: string }>(`SELECT status, response_message FROM somlink_transactions WHERE order_id=$1`, [orderId]);
  assert.equal(tx?.status, "failed");
  assert.equal(tx?.response_message, "INSUFFICIENT_BALANCE");

  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "in_progress");
});

test("a network/timeout failure is recorded as 'ambiguous', never 'failed' or 'completed'", async (t) => {
  const orderId = await insertOrder();
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [orderId]);

  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network timeout");
  });

  const result = await deliverViaSomlink({ id: orderId, customer_id: CUSTOMER_ID, package_id: packageId, receiver_phone: CUSTOMER_PHONE, amount: 1 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "somlink_ambiguous");

  const tx = await queryOne<{ status: string }>(`SELECT status FROM somlink_transactions WHERE order_id=$1`, [orderId]);
  assert.equal(tx?.status, "ambiguous");
  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "in_progress");
});

test("duplicate protection: a second attempt while one is still pending never calls SOMLINK again", async (t) => {
  const orderId = await insertOrder();
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [orderId]);
  // Simulate a first attempt that's still in flight (e.g. a crashed worker
  // never got to record its outcome) by inserting the 'pending' row
  // directly, the same row shape deliverViaSomlink itself would insert.
  await query(
    `INSERT INTO somlink_transactions (id, order_id, bundle_id, wallet_phone, data_phone, amount, status) VALUES (gen_random_uuid(),$1,20061,'647177774',$2,1,'pending')`,
    [orderId, CUSTOMER_PHONE]
  );

  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ code: 200, message: "DATA_PAID_SUCCESSFULLY" }), { status: 200 });
  });

  const result = await deliverViaSomlink({ id: orderId, customer_id: CUSTOMER_ID, package_id: packageId, receiver_phone: CUSTOMER_PHONE, amount: 1 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "already_attempted");
  assert.equal(fetchCalls, 0, "SOMLINK must never be called for an order that already has an active attempt");
});

test("the automatic pending->in_progress path never re-attempts SOMLINK for an order that already left 'pending' once", async (t) => {
  const orderId = await insertOrder();

  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ code: 200, message: "DATA_PAID_SUCCESSFULLY", paid_amount: 1, balance: 1 }), { status: 200 });
  });

  const first = await verifyOrderAndGenerateUssd({ id: orderId, customer_id: CUSTOMER_ID, company_id: COMPANY_ID, package_id: packageId, receiver_phone: CUSTOMER_PHONE, amount: 1, status: "pending" }, null);
  assert.equal(first.ok, true);
  assert.equal(fetchCalls, 1);

  // A duplicate/retried call for the same order (e.g. a re-delivered SMS,
  // or a retried HTTP request) — the outer atomic compare-and-swap in
  // verifyOrderAndGenerateUssd rejects it before deliverViaSomlink is even
  // reached, so fetchCalls must stay at 1.
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  const second = await verifyOrderAndGenerateUssd(order, null);
  assert.equal(second.ok, false);
  assert.equal(fetchCalls, 1, "a retried automatic call must never re-attempt a real-money SOMLINK request");
});

test("a plain USSD-fulfilled company is completely unaffected (no SOMLINK call, no somlink_transactions row)", async (t) => {
  const orderId = await insertOrder({ companyId: USSD_COMPANY_ID, packageId: ussdPackageId });

  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  });

  await verifyOrderAndGenerateUssd({ id: orderId, customer_id: CUSTOMER_ID, company_id: USSD_COMPANY_ID, package_id: ussdPackageId, receiver_phone: CUSTOMER_PHONE, amount: 1, status: "pending" }, null);
  assert.equal(fetchCalls, 0, "a USSD company must never trigger a SOMLINK HTTP call");
  const tx = await queryOne(`SELECT id FROM somlink_transactions WHERE order_id=$1`, [orderId]);
  assert.equal(tx, null);
});

test("manual admin retry after a prior 'failed' attempt succeeds and completes the order via the real HTTP route", async (t) => {
  const orderId = await insertOrder();
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [orderId]);
  await query(
    `INSERT INTO somlink_transactions (id, order_id, bundle_id, wallet_phone, data_phone, amount, status, response_code, response_message, responded_at)
     VALUES (gen_random_uuid(),$1,20061,'647177774',$2,1,'failed',400,'INVALID_BUNDLE_ID',now())`,
    [orderId, CUSTOMER_PHONE]
  );

  // Must only intercept the outbound call to SOMLINK — the test's own call
  // below to the local Express test server has to reach the real fetch.
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    if (String(input).includes("127.0.0.1")) return realFetch(input, init);
    return new Response(JSON.stringify({ code: 200, message: "DATA_PAID_SUCCESSFULLY", paid_amount: 1, balance: 0.5 }), { status: 200 });
  });

  const res = await fetch(`${baseUrl}/admin/orders/${orderId}/retry-somlink`, {
    method: "POST",
    headers: { Authorization: `Bearer ${superAdminToken}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.delivery.ok, true);
  assert.equal(body.order.status, "completed");
});

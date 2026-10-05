// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   SOMLINK_PHONE=647177774 SOMLINK_PASSWORD=test-only \
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/extraPackageSendCount.test.ts
//
// Extra Packages (migration 114): the Admin sets a Send Count on a package;
// a customer pays its price once and the package is delivered that many
// times. Covers the admin field, the order copying it, USSD orders only
// completing (and notifying) after the last delivery, never dialing past
// the Send Count, partial deliveries staying recoverable, and SOMLINK
// delivering N bundles while resuming without re-sending. Never calls the
// real SOMLINK API (global.fetch is mocked).
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken, encrypt } from "../../auth/crypto.js";
import { ordersRouter, verifyOrderAndGenerateUssd } from "../orders.routes.js";
import { ussdRouter } from "../ussd.routes.js";
import { packagesRouter } from "../companies.routes.js";
import { somlinkRouter } from "../somlink.routes.js";
import { __setCachedTokenForTests } from "../../services/somlink.js";

const COMPANY_ID = "test-extra-co";
const SOMLINK_COMPANY_ID = "test-extra-somlink-co";
const CUSTOMER_PHONE = "252619991400";
const AGENT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const DEVICE_ID = "test-extra-device";

let CUSTOMER_ID: string;
let templateId: string;
let agentToken: string;
let adminToken: string;
const app = express();
app.use(express.json());
app.use(ordersRouter);
app.use(ussdRouter);
app.use(packagesRouter);
app.use(somlinkRouter);
let server: http.Server;
let baseUrl: string;
// The SOMLINK test mocks fetch for SOMLINK's API but still calls this
// test's own server through the real one.
(globalThis as any).__realFetch = globalThis.fetch;

function call(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createPackage(sendCount?: number | string, companyId = COMPANY_ID): Promise<string> {
  return (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, ussd_template_id, somlink_bundle_id, send_count)
       VALUES (gen_random_uuid(),$1,'data','Test Package',0.8,$2,$3,$4) RETURNING id`,
      [companyId, companyId === COMPANY_ID ? templateId : null, companyId === COMPANY_ID ? null : 20061, sendCount ?? 1]
    )
  )!.id;
}

async function insertPendingOrder(packageId: string, companyId = COMPANY_ID): Promise<string> {
  const id = "TESTXTRA" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel)
     VALUES ($1,$2,$3,$4,0.8,$5,$5,'pending','customer_app')`,
    [id, CUSTOMER_ID, companyId, packageId, CUSTOMER_PHONE]
  );
  return id;
}

async function startAttempt(orderId: string, attemptNumber: number) {
  const order = await queryOne<{ ussd_generated: string }>(`SELECT ussd_generated FROM orders WHERE id=$1`, [orderId]);
  return call("POST", `/agent/orders/${orderId}/dial-attempts`, agentToken, {
    simSlot: 1,
    ussdString: order!.ussd_generated,
    attemptNumber,
  });
}

async function deliver(orderId: string, attemptNumber: number, status = "success", isFinalAttempt = true) {
  const started = await startAttempt(orderId, attemptNumber);
  assert.ok(started.status === 201 || started.status === 200, `start attempt ${attemptNumber}: ${started.status}`);
  const { id } = (await started.json()) as { id: string };
  const reported = await call("PUT", `/agent/dial-attempts/${id}`, agentToken, { status, isFinalAttempt });
  assert.equal(reported.status, 200);
}

async function orderStatus(orderId: string) {
  return (await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]))!.status;
}

async function successNotifications() {
  return (
    await query(`SELECT 1 FROM notifications WHERE customer_id=$1 AND type='order_update' AND title LIKE '%Hambalyo%'`, [CUSTOMER_ID])
  ).length;
}

before(async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Extra Test Co',1,'#000000',$2)`, [
    COMPANY_ID,
    encrypt("8233"),
  ]);
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, fulfillment_method) VALUES ($1,'Extra SOMLINK Co',1,'#000000','somlink')`,
    [SOMLINK_COMPANY_ID]
  );
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_ID]);
  templateId = (
    await queryOne<{ id: string }>(
      `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status) VALUES (gen_random_uuid(),$1,'Test Package','*727*{number}*{amount}*{pin}#','enabled') RETURNING id`,
      [COMPANY_ID]
    )
  )!.id;
  CUSTOMER_ID = (await queryOne<{ id: string }>(`INSERT INTO customers (id, phone) VALUES (gen_random_uuid(),$1) RETURNING id`, [CUSTOMER_PHONE]))!.id;
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Extra Test Device')`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699001400','Test Agent','x',$2)`, [AGENT_ID, DEVICE_ID]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'extra-test-admin@example.com','x','super_admin')`, [ADMIN_ID]);
  agentToken = signAccessToken(AGENT_ID, "agent");
  adminToken = signAccessToken(ADMIN_ID, "super_admin");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  __setCachedTokenForTests("test-token");
  await query(`DELETE FROM notifications WHERE customer_id=$1`, [CUSTOMER_ID]);
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("the admin sets a package's Send Count; it defaults to 1 and is validated", async () => {
  const base = { companyId: COMPANY_ID, categoryId: "data", name: "Extra 400MB", price: 0.8 };
  const plain = (await (await call("POST", "/admin/packages", adminToken, base)).json()) as any;
  assert.equal(plain.sendCount, 1);

  const created = await call("POST", "/admin/packages", adminToken, { ...base, sendCount: 3 });
  assert.equal(created.status, 201);
  const extra = (await created.json()) as any;
  assert.equal(extra.sendCount, 3);

  for (const bad of [0, 51, 2.5, "abc"]) {
    assert.equal((await call("POST", "/admin/packages", adminToken, { ...base, sendCount: bad })).status, 400, String(bad));
  }

  const edited = (await (await call("PUT", `/admin/packages/${extra.id}`, adminToken, { sendCount: 10 })).json()) as any;
  assert.equal(edited.sendCount, 10);
  const renamed = (await (await call("PUT", `/admin/packages/${extra.id}`, adminToken, { name: "Extra 400MB x10" })).json()) as any;
  assert.equal(renamed.sendCount, 10, "editing other fields keeps the Send Count");
  assert.equal((await call("PUT", `/admin/packages/${extra.id}`, adminToken, { sendCount: 0 })).status, 400);
});

test("an order copies its package's Send Count when created, and keeps it if the package changes later", async () => {
  const pkg = await createPackage(3);
  const orderId = await insertPendingOrder(pkg);
  await query(`UPDATE packages SET send_count=5 WHERE id=$1`, [pkg]);
  const order = await queryOne<{ send_count: number }>(`SELECT send_count FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.send_count, 3);
  const normal = await insertPendingOrder(await createPackage());
  assert.equal((await queryOne<{ send_count: number }>(`SELECT send_count FROM orders WHERE id=$1`, [normal]))?.send_count, 1);
});

test("a USSD Extra Package order completes and notifies only after its last delivery, and never dials past it", async () => {
  const orderId = await insertPendingOrder(await createPackage(3));
  const verified = (await (await call("POST", `/agent/orders/${orderId}/verify-payment`, agentToken, {})).json()) as any;
  assert.equal(verified.sendCount, 3);
  assert.equal(Number(verified.deliveriesDone), 0);
  assert.equal(Number(verified.nextAttemptNumber), 1);

  await deliver(orderId, 1);
  await deliver(orderId, 2);
  assert.equal(await orderStatus(orderId), "in_progress", "2 of 3 delivered: not complete yet");
  assert.equal(await successNotifications(), 0);
  const progress = (await (await call("GET", `/agent/orders/${orderId}`, agentToken)).json()) as any;
  assert.equal(Number(progress.deliveriesDone), 2);
  assert.equal(Number(progress.nextAttemptNumber), 3);

  await deliver(orderId, 3);
  assert.equal(await orderStatus(orderId), "completed");
  assert.equal(await successNotifications(), 1, "exactly one success notification");

  assert.equal((await startAttempt(orderId, 4)).status, 409, "no 4th delivery");
  assert.equal((await startAttempt(orderId, 3)).status, 200, "a retried log of an existing attempt still answers");
});

test("a failed attempt retried within one delivery still counts as one delivery", async () => {
  const orderId = await insertPendingOrder(await createPackage(2));
  await call("POST", `/agent/orders/${orderId}/verify-payment`, agentToken, {});
  await deliver(orderId, 1, "failed", false);
  await deliver(orderId, 2, "success");
  assert.equal(await orderStatus(orderId), "in_progress");
  await deliver(orderId, 3, "success");
  assert.equal(await orderStatus(orderId), "completed");
});

test("the carrier's voucher SMS for one delivery doesn't complete a partly delivered Extra order; a person's tap does", async () => {
  const orderId = await insertPendingOrder(await createPackage(2));
  await call("POST", `/agent/orders/${orderId}/verify-payment`, agentToken, {});
  await deliver(orderId, 1);
  const voucher = (await (
    await call("POST", "/agent/orders/voucher-confirmation", agentToken, { receiverPhone: CUSTOMER_PHONE, amount: 0.8 })
  ).json()) as any;
  assert.equal(voucher.matched, true);
  assert.equal(await orderStatus(orderId), "in_progress");

  assert.equal((await call("POST", `/agent/orders/${orderId}/complete`, agentToken)).status, 200);
  assert.equal(await orderStatus(orderId), "completed");
});

test("a later delivery failing for good leaves a partly delivered order in_progress (recoverable), not failed", async () => {
  const orderId = await insertPendingOrder(await createPackage(3));
  await call("POST", `/agent/orders/${orderId}/verify-payment`, agentToken, {});
  await deliver(orderId, 1, "success");
  await deliver(orderId, 2, "failed", true);
  assert.equal(await orderStatus(orderId), "in_progress");
  const failures = await query(`SELECT 1 FROM notifications WHERE customer_id=$1 AND title LIKE '%ciladeysatay%'`, [CUSTOMER_ID]);
  assert.equal(failures.length, 0);
});

test("a normal (Send Count 1) order still completes on its first successful dial and fails on its final failed one", async () => {
  const ok = await insertPendingOrder(await createPackage());
  await call("POST", `/agent/orders/${ok}/verify-payment`, agentToken, {});
  await deliver(ok, 1);
  assert.equal(await orderStatus(ok), "completed");

  const bad = await insertPendingOrder(await createPackage());
  await call("POST", `/agent/orders/${bad}/verify-payment`, agentToken, {});
  await deliver(bad, 1, "failed", true);
  assert.equal(await orderStatus(bad), "failed");
});

test("SOMLINK sends an Extra Package N times, and a retry only sends the deliveries still owed", async (t) => {
  const pkg = await createPackage(3, SOMLINK_COMPANY_ID);
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    // Pass through calls to this test's own HTTP server.
    if (String(input).startsWith(baseUrl)) return (globalThis as any).__realFetch(input, init);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (!body.bundle_id) return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    sends++;
    return new Response(JSON.stringify({ code: 200, message: "DATA_PAID_SUCCESSFULLY", paid_amount: 0.8, balance: 5 }), { status: 200 });
  });

  const all = await insertPendingOrder(pkg, SOMLINK_COMPANY_ID);
  await verifyOrderAndGenerateUssd(await queryOne(`SELECT * FROM orders WHERE id=$1`, [all]), AGENT_ID);
  assert.equal(sends, 3);
  assert.equal(await orderStatus(all), "completed");

  // Second delivery declined: one sent, order stays in_progress.
  sends = 0;
  const partial = await insertPendingOrder(pkg, SOMLINK_COMPANY_ID);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    if (String(input).startsWith(baseUrl)) return (globalThis as any).__realFetch(input, init);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (!body.bundle_id) return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    calls++;
    if (calls === 2) return new Response(JSON.stringify({ code: 121, message: "INSUFFICIENT_BALANCE" }), { status: 200 });
    sends++;
    return new Response(JSON.stringify({ code: 200, message: "DATA_PAID_SUCCESSFULLY", paid_amount: 0.8, balance: 5 }), { status: 200 });
  });
  await verifyOrderAndGenerateUssd(await queryOne(`SELECT * FROM orders WHERE id=$1`, [partial]), AGENT_ID);
  assert.equal(sends, 1);
  assert.equal(await orderStatus(partial), "in_progress");

  // Staff retry: only the 2 still owed are sent, then it completes.
  const retried = await call("POST", `/admin/orders/${partial}/retry-somlink`, adminToken);
  assert.equal(retried.status, 200);
  assert.equal(sends, 3);
  assert.equal(await orderStatus(partial), "completed");
  const delivered = await query(`SELECT delivery_index FROM somlink_transactions WHERE order_id=$1 AND status='success' ORDER BY delivery_index`, [partial]);
  assert.deepEqual(delivered.map((r: any) => Number(r.delivery_index)), [1, 2, 3]);
});

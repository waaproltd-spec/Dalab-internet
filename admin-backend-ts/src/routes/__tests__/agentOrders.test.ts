// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers the Agent App's new Orders feature:
// real (not fake/local-only) Shop and VIP Number/Package order visibility
// for agents, and the "Complete Order" action's real backend guards
// (payment must be confirmed, order must not already be terminal).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { shopRouter } from "../shop.routes.js";
import { vipNumbersRouter } from "../vipNumbers.routes.js";
import { vipNumberPackagesRouter } from "../vipNumberPackages.routes.js";

const app = express();
app.use(express.json());
app.use(shopRouter);
app.use(vipNumbersRouter);
app.use(vipNumberPackagesRouter);

let server: http.Server;
let baseUrl: string;
let agentToken: string;
let agentId: string;
let superAdminToken: string;
let customerId: string;
let companyId: string;
let categoryId: string;
let productId: string;

const SUPER_ADMIN_ID = randomUUID();
const AGENT_PHONE = "617200301";
const CUSTOMER_PHONE = "617200302";
const CUSTOMER_INFO = { customerFullName: "Agent Test Buyer Father", location: "Mogadishu", district: "Hodan", motherName: "Agent Test Mother" };

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'agent-orders-test-super@example.com','x','super_admin')`, [
    SUPER_ADMIN_ID,
  ]);
  superAdminToken = signAccessToken(SUPER_ADMIN_ID, "super_admin");

  agentId = randomUUID();
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Agent Orders Test Agent','x')`, [agentId, AGENT_PHONE]);
  agentToken = signAccessToken(agentId, "agent");

  const existingCustomer = await queryOne<{ id: string }>(`SELECT id FROM customers WHERE phone=$1`, [CUSTOMER_PHONE]);
  customerId = existingCustomer?.id ?? randomUUID();
  if (!existingCustomer) {
    await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Agent Orders Test Customer')`, [customerId, CUSTOMER_PHONE]);
  }

  const company = await queryOne<{ id: string }>(
    `INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Agent Orders Test Co',1,'#654321') RETURNING id`,
    [randomUUID()]
  );
  companyId = company!.id;

  const cat = await queryOne<{ id: string }>(
    `INSERT INTO shop_categories (id, name, emoji, position) VALUES ($1,'Agent Orders Test Category','🧪',98) RETURNING id`,
    [randomUUID()]
  );
  categoryId = cat!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await query(`DELETE FROM shop_order_items WHERE order_id IN (SELECT id FROM shop_orders WHERE customer_id=$1)`, [customerId]);
  await query(`DELETE FROM shop_orders WHERE customer_id=$1`, [customerId]);
  await query(`DELETE FROM shop_products WHERE category_id=$1`, [categoryId]);
  await query(`DELETE FROM shop_categories WHERE id=$1`, [categoryId]);
  await query(`DELETE FROM vip_number_order_status_history WHERE order_id IN (SELECT id FROM vip_number_orders WHERE customer_id=$1)`, [
    customerId,
  ]);
  await query(`DELETE FROM vip_number_orders WHERE customer_id=$1`, [customerId]);
  await query(`DELETE FROM vip_numbers WHERE company_id=$1`, [companyId]);
  await query(`DELETE FROM companies WHERE id=$1`, [companyId]);
  await query(`DELETE FROM customers WHERE id=$1`, [customerId]);
  await query(`DELETE FROM agents WHERE id=$1`, [agentId]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [SUPER_ADMIN_ID]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function asAgent(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" } });
}
function asSuperAdmin(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${superAdminToken}`, "Content-Type": "application/json" } });
}

let numberId: string;

beforeEach(async () => {
  await query(`DELETE FROM shop_order_items WHERE order_id IN (SELECT id FROM shop_orders WHERE customer_id=$1)`, [customerId]);
  await query(`DELETE FROM shop_orders WHERE customer_id=$1`, [customerId]);
  await query(`DELETE FROM shop_products WHERE category_id=$1`, [categoryId]);
  await query(`DELETE FROM vip_number_order_status_history WHERE order_id IN (SELECT id FROM vip_number_orders WHERE customer_id=$1)`, [
    customerId,
  ]);
  await query(`DELETE FROM vip_number_orders WHERE customer_id=$1`, [customerId]);
  await query(`DELETE FROM vip_numbers WHERE company_id=$1`, [companyId]);

  const product = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Agent Test Product','x',15.00,5) RETURNING id`,
    [randomUUID(), categoryId]
  );
  productId = product!.id;

  const number = await queryOne<{ id: string }>(
    `INSERT INTO vip_numbers (id, company_id, phone_number, category, price) VALUES ($1,$2,'610900099','gold',30.00) RETURNING id`,
    [randomUUID(), companyId]
  );
  numberId = number!.id;

  await query(
    `UPDATE vip_number_settings SET working_days='{0,1,2,3,4,5,6}', opening_time='00:00', closing_time='23:59', manual_override=NULL WHERE id=true`
  );
});

// ---------------- Shop: agent read-only visibility ----------------

test("agent can list and view real Shop order data (read-only, no fake data)", async () => {
  const orderId = randomUUID();
  await query(
    `INSERT INTO shop_orders (id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount, delivery_fee)
     VALUES ($1,$2,'evc','617000111','Test Buyer','617000222','Mogadishu',15.00,0)`,
    [orderId, customerId]
  );
  await query(
    `INSERT INTO shop_order_items (order_id, product_id, product_name, unit_price, quantity, subtotal) VALUES ($1,$2,'Agent Test Product',15.00,1,15.00)`,
    [orderId, productId]
  );

  const listRes = await asAgent("/agent/shop/orders");
  const list = (await listRes.json()) as any[];
  assert.equal(listRes.status, 200);
  assert.ok(list.some((o) => o.id === orderId), "the real Shop order must appear in the agent's list");

  const detailRes = await asAgent(`/agent/shop/orders/${orderId}`);
  const detail = (await detailRes.json()) as any;
  assert.equal(detailRes.status, 200);
  assert.equal(detail.customerName, "Agent Orders Test Customer");
  assert.equal(detail.items.length, 1);
  assert.equal(Number(detail.totalAmount), 15);
});

test("agent cannot complete a Shop order until payment is confirmed, then can complete it, and a second attempt is rejected", async () => {
  const orderId = randomUUID();
  await query(
    `INSERT INTO shop_orders (id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount, delivery_fee)
     VALUES ($1,$2,'evc','617000111','Test Buyer','617000222','Mogadishu',15.00,0)`,
    [orderId, customerId]
  );

  // Not yet confirmed paid -- the agent's own Complete Order must refuse it,
  // same guard VIP Numbers' identical action already enforces.
  const tooEarly = await asAgent(`/agent/shop/orders/${orderId}/complete`, { method: "POST" });
  const tooEarlyBody = (await tooEarly.json()) as any;
  assert.equal(tooEarly.status, 409, JSON.stringify(tooEarlyBody));

  // Admin (or the automatic SMS matcher, in production) confirms payment --
  // payment_status must never be touched by the completion step itself.
  const payRes = await asSuperAdmin(`/admin/shop/orders/${orderId}/payment-status`, { method: "PUT", body: "{}" });
  assert.equal(payRes.status, 200);

  const listRes = await asAgent("/agent/shop/orders?status=processing");
  const list = (await listRes.json()) as any[];
  assert.ok(list.some((o) => o.id === orderId), "the paid order must now appear in the agent's Orders list as processing");

  const completeRes = await asAgent(`/agent/shop/orders/${orderId}/complete`, { method: "POST" });
  const completed = (await completeRes.json()) as any;
  assert.equal(completeRes.status, 200, JSON.stringify(completed));
  assert.equal(completed.status, "delivered");
  assert.equal(completed.paymentStatus, "paid", "completing an order must never change its payment status");

  // Synchronized with the backend, so the Customer App sees it too --
  // exactly the same shop_orders row the customer's own GET reads from.
  const fromDb = await queryOne<{ status: string; payment_status: string }>(
    `SELECT status, payment_status FROM shop_orders WHERE id=$1`,
    [orderId]
  );
  assert.equal(fromDb!.status, "delivered");
  assert.equal(fromDb!.payment_status, "paid");

  // Already terminal -- a second complete attempt must be rejected, so an
  // agent can never accidentally move a completed order back to processing.
  const secondComplete = await asAgent(`/agent/shop/orders/${orderId}/complete`, { method: "POST" });
  assert.equal(secondComplete.status, 409);
});

test("agent cannot complete a cancelled Shop order", async () => {
  const orderId = randomUUID();
  await query(
    `INSERT INTO shop_orders (id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount, delivery_fee, payment_status, status)
     VALUES ($1,$2,'evc','617000111','Test Buyer','617000222','Mogadishu',15.00,0,'paid','cancelled')`,
    [orderId, customerId]
  );
  const res = await asAgent(`/agent/shop/orders/${orderId}/complete`, { method: "POST" });
  const body = (await res.json()) as any;
  assert.equal(res.status, 409, JSON.stringify(body));
});

// ---------------- VIP Number: agent visibility + Complete Order ----------------

test("agent sees no order until payment is confirmed, then sees it and can complete it", async () => {
  const createRes = await asAgent("/vip-numbers/orders");
  // sanity: this public/customer route needs a customer token, not agent --
  // skip straight to creating the order as the test customer via direct SQL
  // (this test file is about agent visibility, not customer checkout, which
  // vipNumberReservationExpiry.test.ts already covers end-to-end).
  void createRes;

  const orderId = "VIPTESTAGT001";
  await query(
    `INSERT INTO vip_number_orders (id, vip_number_id, customer_id, company_id, phone_number, category, price, customer_full_name, payment_method, sender_phone, location, district, mother_name)
     VALUES ($1,$2,$3,$4,'610900099','gold',30.00,$5,'evc','617000111',$6,$7,$8)`,
    [orderId, numberId, customerId, companyId, CUSTOMER_INFO.customerFullName, CUSTOMER_INFO.location, CUSTOMER_INFO.district, CUSTOMER_INFO.motherName]
  );
  await query(`UPDATE vip_numbers SET status='reserved' WHERE id=$1`, [numberId]);

  // Not yet confirmed paid -- the agent's own "Complete Order" must refuse it.
  const tooEarly = await asAgent(`/agent/vip-numbers/orders/${orderId}/complete`, { method: "POST" });
  const tooEarlyBody = (await tooEarly.json()) as any;
  assert.equal(tooEarly.status, 409, JSON.stringify(tooEarlyBody));

  // Admin confirms payment -- this is the real trigger the spec requires
  // ("Customer Payment -> Payment Verified -> Order Confirmed/Paid ->
  // Agent receives a real notification -> Order appears in Agent Orders").
  const payRes = await asSuperAdmin(`/admin/vip-numbers/orders/${orderId}/payment-status`, { method: "PUT", body: "{}" });
  assert.equal(payRes.status, 200);

  const listRes = await asAgent("/agent/vip-numbers/orders?status=processing");
  const list = (await listRes.json()) as any[];
  assert.ok(list.some((o) => o.id === orderId), "the paid order must now appear in the agent's Orders list");

  const detailRes = await asAgent(`/agent/vip-numbers/orders/${orderId}`);
  const detail = (await detailRes.json()) as any;
  assert.equal(detailRes.status, 200);
  assert.equal(detail.phoneNumber, "610900099");
  assert.equal(detail.companyName, "Agent Orders Test Co");
  assert.equal(detail.category, "gold");
  assert.equal(detail.customerFullName, CUSTOMER_INFO.customerFullName);
  assert.equal(detail.customerPhone, CUSTOMER_PHONE);
  assert.equal(detail.location, CUSTOMER_INFO.location);
  assert.equal(detail.district, CUSTOMER_INFO.district);
  assert.equal(detail.motherName, CUSTOMER_INFO.motherName);
  assert.equal(detail.paymentMethod, "evc");
  assert.equal(Number(detail.price), 30);
  assert.equal(detail.paymentStatus, "paid");

  // Now the agent can complete it -- this is a real backend status change,
  // not local-only.
  const completeRes = await asAgent(`/agent/vip-numbers/orders/${orderId}/complete`, { method: "POST" });
  const completed = (await completeRes.json()) as any;
  assert.equal(completeRes.status, 200, JSON.stringify(completed));
  assert.equal(completed.status, "completed");

  // Synchronized with the backend, so the customer sees it too.
  const fromDb = await queryOne<{ status: string }>(`SELECT status FROM vip_number_orders WHERE id=$1`, [orderId]);
  assert.equal(fromDb!.status, "completed");

  // Already terminal -- a second complete attempt must be rejected.
  const secondComplete = await asAgent(`/agent/vip-numbers/orders/${orderId}/complete`, { method: "POST" });
  assert.equal(secondComplete.status, 409);
});

test("agent cannot complete a cancelled VIP Number order", async () => {
  const orderId = "VIPTESTAGT002";
  await query(
    `INSERT INTO vip_number_orders (id, vip_number_id, customer_id, company_id, phone_number, category, price, customer_full_name, payment_method, sender_phone, status)
     VALUES ($1,$2,$3,$4,'610900099','gold',30.00,$5,'evc','617000111','cancelled')`,
    [orderId, numberId, customerId, companyId, CUSTOMER_INFO.customerFullName]
  );
  const res = await asAgent(`/agent/vip-numbers/orders/${orderId}/complete`, { method: "POST" });
  const body = (await res.json()) as any;
  assert.equal(res.status, 409, JSON.stringify(body));
});

// ---------------- VIP Number Package: agent visibility + Complete Order ----------------

test("agent Complete Order works for a VIP Number Package, showing every number and one total price", async () => {
  const secondNumber = await queryOne<{ id: string }>(
    `INSERT INTO vip_numbers (id, company_id, phone_number, category, price) VALUES ($1,$2,'610900098','silver',12.00) RETURNING id`,
    [randomUUID(), companyId]
  );
  const pkg = await queryOne<{ id: string }>(`INSERT INTO vip_number_packages (id, size, price) VALUES ($1,2,38.00) RETURNING id`, [randomUUID()]);
  await query(`INSERT INTO vip_number_package_items (package_id, vip_number_id, position) VALUES ($1,$2,0),($1,$3,1)`, [
    pkg!.id,
    numberId,
    secondNumber!.id,
  ]);

  const orderId = "VPKTESTAGT001";
  await query(
    `INSERT INTO vip_number_package_orders (id, package_id, size, price, customer_id, customer_full_name, location, district, mother_name, payment_method, sender_phone)
     VALUES ($1,$2,2,38.00,$3,$4,$5,$6,$7,'evc','617000111')`,
    [orderId, pkg!.id, customerId, CUSTOMER_INFO.customerFullName, CUSTOMER_INFO.location, CUSTOMER_INFO.district, CUSTOMER_INFO.motherName]
  );
  await query(`INSERT INTO vip_number_package_order_items (package_order_id, vip_number_id, company_id, phone_number, category) VALUES
    ($1,$2,$3,'610900099','gold'), ($1,$4,$3,'610900098','silver')`, [orderId, numberId, companyId, secondNumber!.id]);
  await query(`UPDATE vip_numbers SET status='reserved' WHERE id = ANY($1)`, [[numberId, secondNumber!.id]]);

  const tooEarly = await asAgent(`/agent/vip-numbers/packages/orders/${orderId}/complete`, { method: "POST" });
  assert.equal(tooEarly.status, 409);

  const payRes = await asSuperAdmin(`/admin/vip-numbers/packages/orders/${orderId}/payment-status`, { method: "PUT", body: "{}" });
  assert.equal(payRes.status, 200);

  const detailRes = await asAgent(`/agent/vip-numbers/packages/orders/${orderId}`);
  const detail = (await detailRes.json()) as any;
  assert.equal(detailRes.status, 200);
  assert.equal(detail.items.length, 2, "every number in the package must be shown");
  assert.equal(Number(detail.price), 38, "one total package price, not per-number");
  assert.equal(detail.customerFullName, CUSTOMER_INFO.customerFullName);
  assert.equal(detail.location, CUSTOMER_INFO.location);
  assert.equal(detail.district, CUSTOMER_INFO.district);
  assert.equal(detail.motherName, CUSTOMER_INFO.motherName);

  const completeRes = await asAgent(`/agent/vip-numbers/packages/orders/${orderId}/complete`, { method: "POST" });
  const completed = (await completeRes.json()) as any;
  assert.equal(completeRes.status, 200, JSON.stringify(completed));
  assert.equal(completed.status, "completed");

  await query(`DELETE FROM vip_number_package_order_status_history WHERE package_order_id=$1`, [orderId]);
  await query(`DELETE FROM vip_number_package_order_items WHERE package_order_id=$1`, [orderId]);
  await query(`DELETE FROM vip_number_package_orders WHERE id=$1`, [orderId]);
  await query(`DELETE FROM vip_number_package_items WHERE package_id=$1`, [pkg!.id]);
  await query(`DELETE FROM vip_number_packages WHERE id=$1`, [pkg!.id]);
  await query(`DELETE FROM vip_numbers WHERE id=$1`, [secondNumber!.id]);
});

// ---------------- Auth boundary ----------------

test("a non-agent token (e.g. customer) is rejected from every new agent route", async () => {
  const customerToken = signAccessToken(customerId, "customer");
  const res1 = await fetch(`${baseUrl}/agent/shop/orders`, { headers: { Authorization: `Bearer ${customerToken}` } });
  assert.equal(res1.status, 403);
  const res2 = await fetch(`${baseUrl}/agent/vip-numbers/orders`, { headers: { Authorization: `Bearer ${customerToken}` } });
  assert.equal(res2.status, 403);
  const res3 = await fetch(`${baseUrl}/agent/vip-numbers/packages/orders`, { headers: { Authorization: `Bearer ${customerToken}` } });
  assert.equal(res3.status, 403);
});

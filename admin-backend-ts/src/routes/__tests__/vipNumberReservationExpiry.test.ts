// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers the VIP Number reservation/pending-
// payment/expiry lifecycle end-to-end through real HTTP routes:
//
//   1. Pending -> Successful Payment
//   2. Pending -> Expired (reservation window elapsed, no payment)
//   3. Pending -> Cancelled (customer-initiated)
//   4. Two customers can never both reserve/purchase the same number
//   5. The customer who placed a still-pending order can still see it
//   6. A paid customer can still see their number after it leaves the
//      public catalog
//   7. A number released by expiry becomes purchasable by someone else
//
// expireVipNumberOrderIfStale is exercised directly (rather than waiting
// for the real RESERVATION_WINDOW_MINUTES=15 or the periodic sweep's
// 60-second tick) by back-dating the order's created_at, the same
// approach every other time-window test in this codebase uses -- it's the
// exact function both the periodic sweep and the inline dup-order check
// in POST /vip-numbers/orders call, so exercising it directly here is
// equivalent to waiting for either of those in practice.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { vipNumbersRouter, expireVipNumberOrderIfStale } from "../vipNumbers.routes.js";
import { vipNumberPackagesRouter, expirePackageOrderIfStale } from "../vipNumberPackages.routes.js";

const app = express();
app.use(express.json());
app.use(vipNumbersRouter);
app.use(vipNumberPackagesRouter);

let server: http.Server;
let baseUrl: string;
let superAdminToken: string;
let customerAToken: string;
let customerBToken: string;
let customerAId: string;
let customerBId: string;
let companyId: string;

const SUPER_ADMIN_ID = randomUUID();
const CUSTOMER_A_PHONE = "617100201";
const CUSTOMER_B_PHONE = "617100202";

async function ensureCustomer(phone: string, name: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(`SELECT id FROM customers WHERE phone=$1`, [phone]);
  if (existing) return existing.id;
  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,$3)`, [id, phone, name]);
  return id;
}

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'vip-reservation-test-super@example.com','x','super_admin')`, [
    SUPER_ADMIN_ID,
  ]);
  superAdminToken = signAccessToken(SUPER_ADMIN_ID, "super_admin");

  customerAId = await ensureCustomer(CUSTOMER_A_PHONE, "VIP Reservation Test Customer A");
  customerBId = await ensureCustomer(CUSTOMER_B_PHONE, "VIP Reservation Test Customer B");
  customerAToken = signAccessToken(customerAId, "customer");
  customerBToken = signAccessToken(customerBId, "customer");

  const company = await queryOne<{ id: string }>(
    `INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'VIP Reservation Test Co',1,'#123456') RETURNING id`,
    [randomUUID()]
  );
  companyId = company!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await query(`DELETE FROM vip_number_order_status_history WHERE order_id IN (SELECT id FROM vip_number_orders WHERE customer_id = ANY($1))`, [
    [customerAId, customerBId],
  ]);
  await query(`DELETE FROM vip_number_orders WHERE customer_id = ANY($1)`, [[customerAId, customerBId]]);
  await query(`DELETE FROM vip_numbers WHERE company_id=$1`, [companyId]);
  await query(`DELETE FROM companies WHERE id=$1`, [companyId]);
  await query(`DELETE FROM customers WHERE id = ANY($1)`, [[customerAId, customerBId]]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [SUPER_ADMIN_ID]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function asSuperAdmin(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${superAdminToken}`, "Content-Type": "application/json" } });
}
function asCustomerA(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${customerAToken}`, "Content-Type": "application/json" } });
}
function asCustomerB(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${customerBToken}`, "Content-Type": "application/json" } });
}

let numberId: string;
const CUSTOMER_INFO = { customerFullName: "Test Buyer Father Grandfather", location: "Mogadishu", district: "Hodan", motherName: "Test Mother Name" };

beforeEach(async () => {
  await query(`DELETE FROM vip_number_order_status_history WHERE order_id IN (SELECT id FROM vip_number_orders WHERE customer_id = ANY($1))`, [
    [customerAId, customerBId],
  ]);
  await query(`DELETE FROM vip_number_orders WHERE customer_id = ANY($1)`, [[customerAId, customerBId]]);
  await query(`DELETE FROM vip_numbers WHERE company_id=$1`, [companyId]);

  const number = await queryOne<{ id: string }>(
    `INSERT INTO vip_numbers (id, company_id, phone_number, category, price) VALUES ($1,$2,'610900001','gold',22.20) RETURNING id`,
    [randomUUID(), companyId]
  );
  numberId = number!.id;

  // Always Open with no manual override, so this file's tests never
  // depend on real-world time-of-day/day-of-week.
  await query(
    `UPDATE vip_number_settings SET working_days='{0,1,2,3,4,5,6}', opening_time='00:00', closing_time='23:59', manual_override=NULL WHERE id=true`
  );
});

// ---------------- 1. Pending -> Successful Payment ----------------

test("Pending -> Successful Payment: order and number both end up correctly marked", async () => {
  const createRes = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  const order = (await createRes.json()) as any;
  assert.equal(createRes.status, 201, JSON.stringify(order));
  assert.equal(order.status, "pending");
  assert.equal(order.paymentStatus, "pending");

  const reserved = await queryOne<{ status: string }>(`SELECT status FROM vip_numbers WHERE id=$1`, [numberId]);
  assert.equal(reserved!.status, "reserved", "the number must be reserved the instant the order is created");

  const payRes = await asSuperAdmin(`/admin/vip-numbers/orders/${order.id}/payment-status`, { method: "PUT", body: "{}" });
  const paid = (await payRes.json()) as any;
  assert.equal(payRes.status, 200, JSON.stringify(paid));
  assert.equal(paid.paymentStatus, "paid");
  assert.equal(paid.status, "processing", "pending -> processing once payment is confirmed");

  const sold = await queryOne<{ status: string }>(`SELECT status FROM vip_numbers WHERE id=$1`, [numberId]);
  assert.equal(sold!.status, "sold", "the number becomes officially owned/sold once payment is confirmed");
});

// ---------------- 2. Pending -> Expired ----------------

test("Pending -> Expired: a stale reservation is released and the order marked expired", async () => {
  const createRes = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  const order = (await createRes.json()) as any;
  assert.equal(createRes.status, 201);

  // Not yet stale -- a fresh order must survive an expiry pass untouched.
  const tooEarly = await expireVipNumberOrderIfStale(order.id);
  assert.equal(tooEarly, false, "a fresh pending order must not expire early");
  const stillPending = await queryOne<{ status: string }>(`SELECT status FROM vip_number_orders WHERE id=$1`, [order.id]);
  assert.equal(stillPending!.status, "pending");

  // Back-date past the 15-minute reservation window.
  await query(`UPDATE vip_number_orders SET created_at = now() - interval '16 minutes' WHERE id=$1`, [order.id]);
  const expired = await expireVipNumberOrderIfStale(order.id);
  assert.equal(expired, true);

  const expiredOrder = await queryOne<{ status: string; payment_status: string }>(`SELECT status, payment_status FROM vip_number_orders WHERE id=$1`, [
    order.id,
  ]);
  assert.equal(expiredOrder!.status, "expired");
  assert.equal(expiredOrder!.payment_status, "pending", "expiry never touches payment_status -- it was never paid");

  const released = await queryOne<{ status: string }>(`SELECT status FROM vip_numbers WHERE id=$1`, [numberId]);
  assert.equal(released!.status, "available", "the number's reservation is released on expiry");

  // Idempotent -- expiring an already-expired order a second time is a no-op.
  const secondPass = await expireVipNumberOrderIfStale(order.id);
  assert.equal(secondPass, false);
});

// ---------------- 3. Pending -> Cancelled ----------------

test("Pending -> Cancelled: customer-initiated cancel releases the reservation", async () => {
  const createRes = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  const order = (await createRes.json()) as any;

  const cancelRes = await asCustomerA(`/vip-numbers/orders/${order.id}/cancel`, { method: "POST" });
  const cancelled = (await cancelRes.json()) as any;
  assert.equal(cancelRes.status, 200, JSON.stringify(cancelled));
  assert.equal(cancelled.status, "cancelled");

  const released = await queryOne<{ status: string }>(`SELECT status FROM vip_numbers WHERE id=$1`, [numberId]);
  assert.equal(released!.status, "available");

  // Once cancelled, it's terminal -- a second cancel attempt is rejected.
  const secondCancel = await asCustomerA(`/vip-numbers/orders/${order.id}/cancel`, { method: "POST" });
  assert.equal(secondCancel.status, 409);
});

// ---------------- 4. Prevent duplicate purchase of the same VIP Number ----------------

test("prevents a second customer from reserving/purchasing a number Customer A already has pending", async () => {
  const firstRes = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  assert.equal(firstRes.status, 201);

  const secondRes = await asCustomerB("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "edahab", senderPhone: "627000222", ...CUSTOMER_INFO }),
  });
  const secondBody = (await secondRes.json()) as any;
  assert.equal(secondRes.status, 409, JSON.stringify(secondBody));

  const orders = await query<{ customer_id: string }>(`SELECT customer_id FROM vip_number_orders WHERE vip_number_id=$1`, [numberId]);
  assert.equal(orders.length, 1, "only Customer A's reservation must exist -- Customer B's attempt must not create a second order");
});

test("concurrent same-instant purchase attempts on the same number: exactly one wins", async () => {
  const body = () =>
    JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO });
  const [a, b] = await Promise.all([
    asCustomerA("/vip-numbers/orders", { method: "POST", body: body() }),
    asCustomerB("/vip-numbers/orders", { method: "POST", body: body() }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], "exactly one request must succeed and the other must be rejected as already taken");

  const orders = await query<{ id: string }>(`SELECT id FROM vip_number_orders WHERE vip_number_id=$1`, [numberId]);
  assert.equal(orders.length, 1, "the FOR UPDATE lock in order-creation must prevent two orders for the same number");
});

// ---------------- 5. Customer can still see their Pending order ----------------

test("the customer who placed a pending order can still see it in their own Orders list", async () => {
  const createRes = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  const created = (await createRes.json()) as any;

  const listRes = await asCustomerA("/vip-numbers/orders");
  const list = (await listRes.json()) as any[];
  const mine = list.find((o) => o.id === created.id);
  assert.ok(mine, "the pending order must appear in the customer's own order list");
  assert.equal(mine.phoneNumber, "610900001");
  assert.equal(Number(mine.price), 22.2);
  assert.equal(mine.status, "pending");
  assert.ok(mine.createdAt);

  const detailRes = await asCustomerA(`/vip-numbers/orders/${created.id}`);
  const detail = (await detailRes.json()) as any;
  assert.equal(detailRes.status, 200);
  assert.equal(detail.status, "pending");
});

// ---------------- 6. Paid customer keeps seeing their number after catalog removal ----------------

test("a customer's successfully purchased number stays visible to them after it leaves the public catalog", async () => {
  const createRes = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  const order = (await createRes.json()) as any;
  await asSuperAdmin(`/admin/vip-numbers/orders/${order.id}/payment-status`, { method: "PUT", body: "{}" });

  const catalogRes = await fetch(`${baseUrl}/vip-numbers?companyId=${companyId}`);
  const catalog = (await catalogRes.json()) as any[];
  assert.ok(!catalog.some((n) => n.id === numberId), "a sold number must no longer appear in the public catalog");

  const listRes = await asCustomerA("/vip-numbers/orders");
  const list = (await listRes.json()) as any[];
  const mine = list.find((o) => o.id === order.id);
  assert.ok(mine, "the customer must still see their own purchased number");
  assert.equal(mine.status, "processing");
  assert.equal(mine.paymentStatus, "paid");
});

// ---------------- 7. Expired numbers become available for other customers again ----------------

test("a number released by expiry can be purchased by a different customer", async () => {
  const firstRes = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  const firstOrder = (await firstRes.json()) as any;
  assert.equal(firstRes.status, 201);

  await query(`UPDATE vip_number_orders SET created_at = now() - interval '16 minutes' WHERE id=$1`, [firstOrder.id]);
  const expired = await expireVipNumberOrderIfStale(firstOrder.id);
  assert.equal(expired, true);

  const catalogRes = await fetch(`${baseUrl}/vip-numbers?companyId=${companyId}`);
  const catalog = (await catalogRes.json()) as any[];
  assert.ok(catalog.some((n) => n.id === numberId), "the released number must reappear in the public catalog");

  const secondRes = await asCustomerB("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "edahab", senderPhone: "627000222", ...CUSTOMER_INFO }),
  });
  const secondOrder = (await secondRes.json()) as any;
  assert.equal(secondRes.status, 201, JSON.stringify(secondOrder));
  assert.equal(secondOrder.status, "pending");

  const numberRow = await queryOne<{ status: string }>(`SELECT status FROM vip_numbers WHERE id=$1`, [numberId]);
  assert.equal(numberRow!.status, "reserved", "now reserved by Customer B, not Customer A's expired order");
});

// ---------------- Working hours enforcement ----------------

test("order creation is blocked with 409 while VIP Numbers is closed (manual override)", async () => {
  await query(`UPDATE vip_number_settings SET manual_override='closed' WHERE id=true`);
  const res = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 409, JSON.stringify(body));

  const numberRow = await queryOne<{ status: string }>(`SELECT status FROM vip_numbers WHERE id=$1`, [numberId]);
  assert.equal(numberRow!.status, "available", "a blocked attempt must never reserve the number");
});

// ---------------- USSD amount formatting (the reported $22.20 -> "222" bug) ----------------

test("the generated USSD dial string uses the correct dollars*cents segments, never the collapsed single-token bug", async () => {
  const res = await asCustomerA("/vip-numbers/orders", {
    method: "POST",
    body: JSON.stringify({ vipNumberId: numberId, paymentMethod: "evc", senderPhone: "617000111", ...CUSTOMER_INFO }),
  });
  const order = (await res.json()) as any;
  assert.equal(res.status, 201);
  assert.equal(order.dialUssd, "*712*610338686*22*20#");
  assert.notEqual(order.dialUssd, "*712*610338686*222#", "must never collapse $22.20 into the buggy single token 222");
});

// ---------------- Package order: expiry mirrors the individual flow ----------------

test("package order: Pending -> Expired releases every member number", async () => {
  const secondNumber = await queryOne<{ id: string }>(
    `INSERT INTO vip_numbers (id, company_id, phone_number, category, price) VALUES ($1,$2,'610900002','silver',10.00) RETURNING id`,
    [randomUUID(), companyId]
  );
  const pkg = await queryOne<{ id: string }>(
    `INSERT INTO vip_number_packages (id, size, price) VALUES ($1,2,30.00) RETURNING id`,
    [randomUUID()]
  );
  await query(`INSERT INTO vip_number_package_items (package_id, vip_number_id, position) VALUES ($1,$2,0),($1,$3,1)`, [
    pkg!.id,
    numberId,
    secondNumber!.id,
  ]);

  const createRes = await asCustomerA("/vip-numbers/packages/orders", {
    method: "POST",
    body: JSON.stringify({ packageId: pkg!.id, paymentMethod: "evc", senderPhone: "617000111", customerFullName: CUSTOMER_INFO.customerFullName }),
  });
  const order = (await createRes.json()) as any;
  assert.equal(createRes.status, 201, JSON.stringify(order));
  assert.equal(order.dialUssd, "*712*610338686*30*00#");

  await query(`UPDATE vip_number_package_orders SET created_at = now() - interval '16 minutes' WHERE id=$1`, [order.id]);
  const expired = await expirePackageOrderIfStale(order.id);
  assert.equal(expired, true);

  const numbers = await query<{ status: string }>(`SELECT status FROM vip_numbers WHERE id = ANY($1)`, [[numberId, secondNumber!.id]]);
  assert.ok(numbers.every((n) => n.status === "available"), "every member number must be released back to available");

  await query(`DELETE FROM vip_number_package_order_status_history WHERE package_order_id=$1`, [order.id]);
  await query(`DELETE FROM vip_number_package_order_items WHERE package_order_id=$1`, [order.id]);
  await query(`DELETE FROM vip_number_package_orders WHERE id=$1`, [order.id]);
  await query(`DELETE FROM vip_number_package_items WHERE package_id=$1`, [pkg!.id]);
  await query(`DELETE FROM vip_number_packages WHERE id=$1`, [pkg!.id]);
});

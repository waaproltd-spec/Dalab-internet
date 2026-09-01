// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers the Shop feature end-to-end through
// real HTTP routes: public catalog reads, a customer placing an order
// (stock reservation, server-computed total, USSD dial string), Admin
// payment confirmation + staged delivery status updates (with stock
// restored on cancel), and that every /admin/shop/* route rejects a staff
// admin who lacks the "shop.manage" permission.
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

const app = express();
app.use(express.json());
app.use(shopRouter);

let server: http.Server;
let baseUrl: string;
let superAdminToken: string;
let plainAdminToken: string;
let customerToken: string;
let customerId: string;
let categoryId: string;
let productId: string;

const SUPER_ADMIN_ID = randomUUID();
const PLAIN_ADMIN_ID = randomUUID();
const CUSTOMER_PHONE = "617000111";

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'shop-test-super@example.com','x','super_admin')`, [SUPER_ADMIN_ID]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,'shop-test-admin@example.com','x','admin','{}')`, [PLAIN_ADMIN_ID]);
  superAdminToken = signAccessToken(SUPER_ADMIN_ID, "super_admin");
  plainAdminToken = signAccessToken(PLAIN_ADMIN_ID, "admin");

  const existingCustomer = await queryOne<{ id: string }>(`SELECT id FROM customers WHERE phone=$1`, [CUSTOMER_PHONE]);
  customerId = existingCustomer?.id ?? randomUUID();
  if (!existingCustomer) {
    await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Shop Test Customer')`, [customerId, CUSTOMER_PHONE]);
  }
  customerToken = signAccessToken(customerId, "customer");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await query(`DELETE FROM shop_order_items WHERE order_id IN (SELECT id FROM shop_orders WHERE customer_id=$1)`, [customerId]);
  await query(`DELETE FROM shop_orders WHERE customer_id=$1`, [customerId]);
  await query(`DELETE FROM shop_products WHERE name LIKE 'Test %'`);
  await query(`DELETE FROM shop_categories WHERE name = 'Test Category'`);
  await query(`DELETE FROM customers WHERE id=$1`, [customerId]);
  await query(`DELETE FROM admin_users WHERE id = ANY($1)`, [[SUPER_ADMIN_ID, PLAIN_ADMIN_ID]]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function asSuperAdmin(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${superAdminToken}`, "Content-Type": "application/json" } });
}
function asPlainAdmin(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${plainAdminToken}`, "Content-Type": "application/json" } });
}
function asCustomer(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${customerToken}`, "Content-Type": "application/json" } });
}

beforeEach(async () => {
  await query(`DELETE FROM shop_order_items WHERE order_id IN (SELECT id FROM shop_orders WHERE customer_id=$1)`, [customerId]);
  await query(`DELETE FROM shop_orders WHERE customer_id=$1`, [customerId]);
  await query(`DELETE FROM shop_products WHERE name LIKE 'Test %'`);
  await query(`DELETE FROM shop_categories WHERE name = 'Test Category'`);

  const cat = await queryOne<{ id: string }>(
    `INSERT INTO shop_categories (id, name, emoji, position) VALUES ($1,'Test Category','👟',99) RETURNING id`,
    [randomUUID()]
  );
  categoryId = cat!.id;
  const product = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Sneakers','A test product',25.00,3) RETURNING id`,
    [randomUUID(), categoryId]
  );
  productId = product!.id;
});

test("the 5 fixed categories were seeded by the migration, with no clothing category", async () => {
  const res = await fetch(`${baseUrl}/shop/categories`);
  assert.equal(res.status, 200);
  const categories = (await res.json()) as any[];
  const names = categories.map((c) => c.name);
  for (const expected of ["Shoes", "Eyewear", "Perfumes", "Watches", "Gifts"]) {
    assert.ok(names.includes(expected), `expected ${expected} to be seeded`);
  }
  assert.ok(!names.some((n) => /cloth/i.test(n)), "no clothing category should exist");
});

test("GET /shop/products lists an active product with no auth required", async () => {
  const res = await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}`);
  assert.equal(res.status, 200);
  const products = (await res.json()) as any[];
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "Test Sneakers");
  assert.equal(Number(products[0].price), 25);
});

test("GET /shop/payment-methods is public and returns both seeded methods", async () => {
  const res = await fetch(`${baseUrl}/shop/payment-methods`);
  assert.equal(res.status, 200);
  const methods = (await res.json()) as any[];
  assert.deepEqual(methods.map((m) => m.method).sort(), ["edahab", "evc"]);
});

test("a customer can place an order: stock is reserved, total is server-computed, and a USSD dial string is returned", async () => {
  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 2 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  const order = (await res.json()) as any;
  assert.equal(res.status, 201, JSON.stringify(order));
  assert.equal(Number(order.totalAmount), 50); // 25 * 2, never trusts a client-sent price
  assert.equal(order.paymentStatus, "pending");
  assert.equal(order.status, "pending");
  assert.equal(order.dialUssd, "*712*610338686*50#");
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].quantity, 2);

  const product = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(product!.stock, 1, "stock must be decremented at order-creation time");
});

// A whole-dollar total (like the $50 case above) can't tell "correctly
// formatted" apart from "the raw decimal string" -- both happen to render
// identically. This uses a fractional total specifically to catch the
// exact bug ussdFormatting.ts's own header comment documents (a raw "."
// is not a valid USSD/MMI dial character): $0.10 must dial as "01", not
// "0.1".
test("the USSD dial string uses formatUssdAmount, not a raw decimal string, for a fractional total", async () => {
  const cheapProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, price, stock) VALUES ($1,$2,'Test Keychain',0.10,5) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: cheapProduct!.id, quantity: 1 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  const order = (await res.json()) as any;
  assert.equal(res.status, 201, JSON.stringify(order));
  assert.equal(Number(order.totalAmount), 0.1);
  assert.equal(order.dialUssd, "*712*610338686*01#", "must be the dollars+cents dial format, not a literal decimal point");
});

test("ordering more than available stock is rejected and reserves nothing", async () => {
  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 99 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  assert.equal(res.status, 409);
  const product = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(product!.stock, 3, "a rejected order must not touch stock");
});

test("an unknown payment method is rejected before any stock is touched", async () => {
  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "jeeb",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  assert.equal(res.status, 400);
});

test("paying via EVC Plus with an eDahab-prefixed sender number is rejected -- the sender number must match the chosen payment method", async () => {
  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "evc",
      senderPhone: "627000111", // eDahab's 62 prefix, not evc's 61/77
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  assert.equal(res.status, 400);
  const product = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(product!.stock, 3, "a phone/method mismatch must not touch stock");
});

test("full lifecycle: Admin confirms payment, then advances delivery status to delivered", async () => {
  const createRes = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "edahab",
      senderPhone: "627000111", // eDahab's own 62 prefix, not evc's 61
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  const order = (await createRes.json()) as any;
  assert.equal(createRes.status, 201, JSON.stringify(order));

  const payRes = await asSuperAdmin(`/admin/shop/orders/${order.id}/payment-status`, { method: "PUT", body: "{}" });
  const paid = (await payRes.json()) as any;
  assert.equal(payRes.status, 200, JSON.stringify(paid));
  assert.equal(paid.paymentStatus, "paid");
  assert.equal(paid.status, "processing", "confirming payment auto-advances a still-pending order");

  const shipRes = await asSuperAdmin(`/admin/shop/orders/${order.id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status: "shipped", trackingReference: "DHL-123", trackingNote: "Left the warehouse" }),
  });
  assert.equal(shipRes.status, 200);
  const shipped = (await shipRes.json()) as any;
  assert.equal(shipped.trackingReference, "DHL-123");

  const deliverRes = await asSuperAdmin(`/admin/shop/orders/${order.id}/status`, { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  assert.equal(deliverRes.status, 200);
  const delivered = (await deliverRes.json()) as any;
  assert.equal(delivered.status, "delivered");
  assert.ok(delivered.deliveredAt, "deliveredAt must be stamped");
  assert.equal(delivered.trackingReference, "DHL-123", "an unspecified field on a later update must not be wiped");
});

test("cancelling an order restores the stock it reserved", async () => {
  const createRes = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 2 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  const order = (await createRes.json()) as any;
  let product = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(product!.stock, 1);

  const cancelRes = await asSuperAdmin(`/admin/shop/orders/${order.id}/status`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
  assert.equal(cancelRes.status, 200);

  product = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(product!.stock, 3, "cancelling must give the reserved stock back");
});

test("a regular Admin without shop.manage is rejected from every /admin/shop route, matching it being hidden from their sidebar", async () => {
  const getCategories = await asPlainAdmin("/admin/shop/categories");
  assert.equal(getCategories.status, 403);
  const getProducts = await asPlainAdmin("/admin/shop/products");
  assert.equal(getProducts.status, 403);
  const getOrders = await asPlainAdmin("/admin/shop/orders");
  assert.equal(getOrders.status, 403);
  const createCategory = await asPlainAdmin("/admin/shop/categories", { method: "POST", body: JSON.stringify({ name: "Nope" }) });
  assert.equal(createCategory.status, 403);
});

test("a Super Admin can manage categories and products end-to-end", async () => {
  const createRes = await asSuperAdmin("/admin/shop/categories", { method: "POST", body: JSON.stringify({ name: "Temp Category", emoji: "🧢" }) });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as any;

  const productRes = await asSuperAdmin("/admin/shop/products", {
    method: "POST",
    body: JSON.stringify({ categoryId: created.id, name: "Test Cap", price: 10, stock: 5 }),
  });
  assert.equal(productRes.status, 201);
  const product = (await productRes.json()) as any;
  assert.equal(Number(product.price), 10);
  assert.equal(product.stock, 5);

  const updateRes = await asSuperAdmin(`/admin/shop/products/${product.id}`, { method: "PUT", body: JSON.stringify({ price: 12, stock: 8 }) });
  assert.equal(updateRes.status, 200);
  const updated = (await updateRes.json()) as any;
  assert.equal(Number(updated.price), 12);
  assert.equal(updated.stock, 8);

  const deleteProductRes = await asSuperAdmin(`/admin/shop/products/${product.id}`, { method: "DELETE" });
  assert.equal(deleteProductRes.status, 200);
  const deleteCategoryRes = await asSuperAdmin(`/admin/shop/categories/${created.id}`, { method: "DELETE" });
  assert.equal(deleteCategoryRes.status, 200);
});

test("a category with products under it cannot be hard-deleted", async () => {
  const res = await asSuperAdmin(`/admin/shop/categories/${categoryId}`, { method: "DELETE" });
  assert.equal(res.status, 409);
});

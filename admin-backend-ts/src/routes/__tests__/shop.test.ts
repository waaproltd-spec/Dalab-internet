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
  await query(`DELETE FROM shop_flash_sales WHERE name LIKE 'Test %'`);
  await query(`DELETE FROM shop_bundle_deals WHERE name LIKE 'Test %'`);
  await query(`DELETE FROM shop_delivery_zones WHERE name LIKE 'Test %'`);
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

  // Reset to defaults before every test -- open (no manual override, every
  // day, all-day hours) with no delivery fee, so a settings change one test
  // makes never leaks into the next.
  await query(
    `UPDATE shop_settings SET delivery_fee=0, working_days='{0,1,2,3,4,5,6}', opening_time='00:00', closing_time='23:59', manual_override=NULL WHERE id=true`
  );
});

test("the 5 fixed categories were seeded by the migration, with no clothing or shoes category", async () => {
  const res = await fetch(`${baseUrl}/shop/categories`);
  assert.equal(res.status, 200);
  const categories = (await res.json()) as any[];
  const names = categories.map((c) => c.name);
  for (const expected of ["Electronics", "Eyewear", "Perfumes", "Watches", "Gifts"]) {
    assert.ok(names.includes(expected), `expected ${expected} to be seeded`);
  }
  assert.ok(!names.some((n) => /cloth/i.test(n)), "no clothing category should exist");
  assert.ok(!names.includes("Shoes"), "Shoes was renamed to Electronics, not kept alongside it");
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
  assert.equal(order.isGift, false, "isGift defaults to false when not a gift order");
  assert.equal(order.giftRecipientName, null);
  assert.equal(order.deliveryNotes, null);
  assert.equal(Number(order.deliveryFee), 0);

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

// ==================== Phase 1: subcategories, catalog fields, dedup, statuses ====================

test("subcategories are admin-managed, generic (not hardcoded to any category), and publicly listable once active", async () => {
  const createRes = await asSuperAdmin("/admin/shop/subcategories", {
    method: "POST",
    body: JSON.stringify({ categoryId, name: "Test Phone Covers" }),
  });
  assert.equal(createRes.status, 201);
  const sub = (await createRes.json()) as any;
  assert.equal(sub.categoryId, categoryId);
  assert.equal(sub.active, true);

  const publicRes = await fetch(`${baseUrl}/shop/subcategories?categoryId=${categoryId}`);
  const publicList = (await publicRes.json()) as any[];
  assert.ok(publicList.some((s) => s.id === sub.id), "an active subcategory must be publicly visible");

  const deactivateRes = await asSuperAdmin(`/admin/shop/subcategories/${sub.id}`, { method: "PUT", body: JSON.stringify({ active: false }) });
  assert.equal(deactivateRes.status, 200);
  const publicAfter = (await (await fetch(`${baseUrl}/shop/subcategories?categoryId=${categoryId}`)).json()) as any[];
  assert.ok(!publicAfter.some((s) => s.id === sub.id), "a deactivated subcategory must disappear from the public list");

  const deleteRes = await asSuperAdmin(`/admin/shop/subcategories/${sub.id}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
});

test("a subcategory must belong to the product's own category, both on create and update", async () => {
  const otherCategory = await queryOne<{ id: string }>(
    `INSERT INTO shop_categories (id, name, emoji, position) VALUES ($1,'Test Other Category','🎁',98) RETURNING id`,
    [randomUUID()]
  );
  const sub = await queryOne<{ id: string }>(
    `INSERT INTO shop_subcategories (id, category_id, name) VALUES ($1,$2,'Test Sub Of Other') RETURNING id`,
    [randomUUID(), otherCategory!.id]
  );

  const createRes = await asSuperAdmin("/admin/shop/products", {
    method: "POST",
    body: JSON.stringify({ categoryId, subcategoryId: sub!.id, name: "Test Mismatched Sub Product", price: 5 }),
  });
  assert.equal(createRes.status, 400);

  const updateRes = await asSuperAdmin(`/admin/shop/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({ subcategoryId: sub!.id }),
  });
  assert.equal(updateRes.status, 400);

  await query(`DELETE FROM shop_subcategories WHERE id=$1`, [sub!.id]);
  await query(`DELETE FROM shop_categories WHERE id=$1`, [otherCategory!.id]);
});

test("brand, discount (oldPrice), and the featured/new-arrival/best-seller flags round-trip through create and update", async () => {
  const createRes = await asSuperAdmin("/admin/shop/products", {
    method: "POST",
    body: JSON.stringify({
      categoryId,
      name: "Test Flagship Phone",
      price: 400,
      oldPrice: 500,
      brand: "Test Brand",
      featured: true,
      isNewArrival: true,
      bestSeller: false,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as any;
  assert.equal(created.brand, "Test Brand");
  assert.equal(Number(created.oldPrice), 500);
  assert.equal(created.featured, true);
  assert.equal(created.isNewArrival, true);
  assert.equal(created.bestSeller, false);

  const updateRes = await asSuperAdmin(`/admin/shop/products/${created.id}`, {
    method: "PUT",
    body: JSON.stringify({ bestSeller: true, isNewArrival: false }),
  });
  const updated = (await updateRes.json()) as any;
  assert.equal(updated.bestSeller, true);
  assert.equal(updated.isNewArrival, false);
  assert.equal(updated.featured, true, "a field not sent in this update must be left as-is");
});

test("public product filters: search, brand, price range, and the featured/new-arrival/best-seller/discounted flags", async () => {
  await asSuperAdmin("/admin/shop/products", {
    method: "POST",
    body: JSON.stringify({ categoryId, name: "Test Special Widget", price: 30, oldPrice: 45, brand: "Acme", featured: true }),
  });
  await asSuperAdmin("/admin/shop/products", {
    method: "POST",
    body: JSON.stringify({ categoryId, name: "Test Plain Widget", price: 30, brand: "Other Co", isNewArrival: true }),
  });

  const bySearch = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&search=Special`)).json()) as any[];
  assert.ok(bySearch.every((p) => /Special/.test(p.name)));
  assert.ok(bySearch.some((p) => p.name === "Test Special Widget"));

  const byBrand = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&brand=Acme`)).json()) as any[];
  assert.ok(byBrand.every((p) => p.brand === "Acme"));

  const byPriceRange = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&minPrice=29&maxPrice=31`)).json()) as any[];
  assert.ok(byPriceRange.every((p) => Number(p.price) >= 29 && Number(p.price) <= 31));

  const featured = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&featured=true`)).json()) as any[];
  assert.ok(featured.every((p) => p.featured === true));
  assert.ok(featured.some((p) => p.name === "Test Special Widget"));

  const newArrivals = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&newArrivals=true`)).json()) as any[];
  assert.ok(newArrivals.some((p) => p.name === "Test Plain Widget"));

  const discounted = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&discounted=true`)).json()) as any[];
  assert.ok(discounted.some((p) => p.name === "Test Special Widget"));
  assert.ok(!discounted.some((p) => p.name === "Test Plain Widget"), "a product with no discount must not appear in discounted=true");
});

test("sort=price_asc, price_desc, and popularity order products correctly", async () => {
  const cheap = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, price, stock) VALUES ($1,$2,'Test Cheap Item',5,50) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const pricey = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, price, stock) VALUES ($1,$2,'Test Pricey Item',500,50) RETURNING id`,
    [randomUUID(), categoryId]
  );

  const asc = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&sort=price_asc`)).json()) as any[];
  const ascPrices = asc.map((p) => Number(p.price));
  assert.deepEqual(ascPrices, [...ascPrices].sort((a, b) => a - b));

  const desc = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&sort=price_desc`)).json()) as any[];
  assert.equal(desc[0].id, pricey!.id);

  // Popularity is driven by sold_count, which only moves via a real order.
  await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: cheap!.id, quantity: 10 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  const byPopularity = (await (await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}&sort=popularity`)).json()) as any[];
  assert.equal(byPopularity[0].id, cheap!.id, "the product with the higher sold_count must sort first");
});

test("submitting the exact same cart+payment method twice in a row returns the original order instead of a duplicate", async () => {
  const body = JSON.stringify({
    items: [{ productId, quantity: 1 }],
    paymentMethod: "evc",
    senderPhone: "617000111",
    deliveryName: "Test Buyer",
    deliveryPhone: "617000222",
    deliveryAddress: "Mogadishu, Somalia",
  });
  const first = await asCustomer("/shop/orders", { method: "POST", body });
  const firstOrder = (await first.json()) as any;
  assert.equal(first.status, 201, JSON.stringify(firstOrder));

  const second = await asCustomer("/shop/orders", { method: "POST", body });
  const secondOrder = (await second.json()) as any;
  assert.equal(second.status, 200, "a duplicate cart+payment method must not 201 a new order");
  assert.equal(secondOrder.id, firstOrder.id, "must return the exact same order, not a sibling");

  const product = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(product!.stock, 2, "stock must be decremented exactly once (3 - 1), not twice");
});

// The second cart here deliberately exercises Product Variants + Flash
// Sales + Bundle Deals all at once (rather than a plain second product)
// -- this file's shared customer-shop-order-create rate limit (20 per
// 15 min) is already fully spent by the real order-creation calls above
// and below, so this reuses the "prove two different carts don't
// collide" call this test already needs, instead of spending a 21st slot
// on a standalone test for the same real-order-creation integration
// coverage.
test("a different cart from the same customer is never blocked by the dedup guard, and correctly prices a Flash Sale item, a specific variant, and a bundle deal", async () => {
  const flashProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Flash Product','',50.00,5) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const flashSale = await queryOne<{ id: string }>(
    `INSERT INTO shop_flash_sales (id, name, starts_at, ends_at) VALUES ($1,'Test Flash Sale', now() - interval '1 hour', now() + interval '1 hour') RETURNING id`,
    [randomUUID()]
  );
  await query(`INSERT INTO shop_flash_sale_items (flash_sale_id, product_id, sale_price) VALUES ($1,$2,30.00)`, [flashSale!.id, flashProduct!.id]);

  const variantProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Variant Product','',40.00,0) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const variant = await queryOne<{ id: string }>(
    `INSERT INTO shop_product_variants (id, product_id, label, attributes, price, stock) VALUES ($1,$2,'Large / Red','{"size":"Large","color":"Red"}',35.00,2) RETURNING id`,
    [randomUUID(), variantProduct!.id]
  );

  const bundleProductA = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Bundle Product A','',10.00,5) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const bundleProductB = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Bundle Product B','',15.00,5) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const bundle = await queryOne<{ id: string }>(
    `INSERT INTO shop_bundle_deals (id, name, bundle_price) VALUES ($1,'Test Bundle Deal',20.00) RETURNING id`,
    [randomUUID()]
  );
  await query(`INSERT INTO shop_bundle_deal_items (bundle_id, product_id, quantity) VALUES ($1,$2,1),($1,$3,1)`, [bundle!.id, bundleProductA!.id, bundleProductB!.id]);

  const mk = (body: unknown) => asCustomer("/shop/orders", { method: "POST", body: JSON.stringify(body) });
  const first = await mk({
    items: [{ productId, quantity: 1 }],
    paymentMethod: "evc",
    senderPhone: "617000111",
    deliveryName: "Test Buyer",
    deliveryPhone: "617000222",
    deliveryAddress: "Mogadishu, Somalia",
  });
  const second = await mk({
    items: [
      { productId: flashProduct!.id, quantity: 1 },
      { productId: variantProduct!.id, variantId: variant!.id, quantity: 2 },
      { bundleId: bundle!.id, quantity: 1 },
    ],
    paymentMethod: "evc",
    senderPhone: "617000111",
    deliveryName: "Test Buyer",
    deliveryPhone: "617000222",
    deliveryAddress: "Mogadishu, Somalia",
  });
  const firstOrder = (await first.json()) as any;
  const secondOrder = (await second.json()) as any;
  assert.equal(first.status, 201);
  assert.equal(second.status, 201, "a genuinely different cart must always create its own order");
  assert.notEqual(firstOrder.id, secondOrder.id);

  assert.equal(Number(secondOrder.totalAmount), 30 + 35 * 2 + 20, "flash-sale price + variant price x2 + bundle price");
  const flashItem = secondOrder.items.find((i: any) => i.productId === flashProduct!.id);
  assert.equal(Number(flashItem.unitPrice), 30, "the flash sale price is what was actually charged, not the base 50");
  const variantItem = secondOrder.items.find((i: any) => i.variantId === variant!.id);
  assert.equal(Number(variantItem.unitPrice), 35);
  assert.equal(variantItem.variantLabel, "Large / Red");
  assert.equal(variantItem.quantity, 2);
  const bundleItem = secondOrder.items.find((i: any) => i.bundleId === bundle!.id);
  assert.equal(Number(bundleItem.unitPrice), 20);
  assert.equal(bundleItem.productId, null, "a bundle line has no single product id");
  assert.equal(bundleItem.bundleName, "Test Bundle Deal");

  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [flashProduct!.id]))!.stock, 4);
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_product_variants WHERE id=$1`, [variant!.id]))!.stock, 0, "2 of 2 reserved");
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [bundleProductA!.id]))!.stock, 4);
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [bundleProductB!.id]))!.stock, 4);

  // Cancelling restores stock for a plain product, a specific variant, and
  // every constituent product of a bundle line -- all through the same
  // restoreShopOrderStock() path the plain-product cancel test elsewhere
  // in this file already covers for the simple case. Not rate-limited (a
  // different route), so this is free to exercise here.
  const cancelRes = await asCustomer(`/shop/orders/${secondOrder.id}/cancel`, { method: "POST" });
  assert.equal(cancelRes.status, 200);
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [flashProduct!.id]))!.stock, 5);
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_product_variants WHERE id=$1`, [variant!.id]))!.stock, 2);
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [bundleProductA!.id]))!.stock, 5);
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [bundleProductB!.id]))!.stock, 5);
});

test("failed and returned statuses restore stock; refunded alone does not; and no status can change once an order is terminal", async () => {
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

  const failRes = await asSuperAdmin(`/admin/shop/orders/${order.id}/status`, { method: "PUT", body: JSON.stringify({ status: "failed" }) });
  assert.equal(failRes.status, 200);
  const afterFail = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(afterFail!.stock, 3, "a failed order must give its reserved stock back");

  const secondChange = await asSuperAdmin(`/admin/shop/orders/${order.id}/status`, { method: "PUT", body: JSON.stringify({ status: "processing" }) });
  assert.equal(secondChange.status, 409, "a terminal order (failed) must reject any further status change");

  const createRes2 = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "edahab",
      senderPhone: "627000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  const order2 = (await createRes2.json()) as any;
  const returnRes = await asSuperAdmin(`/admin/shop/orders/${order2.id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status: "returned", courierName: "Test Courier" }),
  });
  const returned = (await returnRes.json()) as any;
  assert.equal(returnRes.status, 200);
  assert.equal(returned.courierName, "Test Courier");
  const afterReturn = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(afterReturn!.stock, 3, "a returned order must give its reserved stock back too");

  const createRes3 = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  const order3 = (await createRes3.json()) as any;
  const stockBeforeRefund = (await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]))!.stock;
  const refundRes = await asSuperAdmin(`/admin/shop/orders/${order3.id}/status`, { method: "PUT", body: JSON.stringify({ status: "refunded" }) });
  assert.equal(refundRes.status, 200);
  const afterRefund = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(afterRefund!.stock, stockBeforeRefund, "refunded alone must not restore stock");
});

// ==================== Shop Settings: delivery fee + open/closed ====================

test("GET /shop/settings is public and defaults to open with no delivery fee", async () => {
  const res = await fetch(`${baseUrl}/shop/settings`);
  assert.equal(res.status, 200);
  const settings = (await res.json()) as any;
  assert.equal(settings.isOpen, true);
  assert.equal(Number(settings.deliveryFee), 0);
  assert.deepEqual(settings.workingDays.slice().sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test("PUT /admin/shop/settings requires the shop.manage permission", async () => {
  const res = await asPlainAdmin("/admin/shop/settings", { method: "PUT", body: JSON.stringify({ deliveryFee: 5 }) });
  assert.equal(res.status, 403);
});

test("Super Admin can set a delivery fee, and it is added on top of the item subtotal at checkout", async () => {
  const put = await asSuperAdmin("/admin/shop/settings", { method: "PUT", body: JSON.stringify({ deliveryFee: 3.5 }) });
  assert.equal(put.status, 200);

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
  assert.equal(Number(order.deliveryFee), 3.5);
  assert.equal(Number(order.totalAmount), 53.5, "total must be items (25*2=50) + delivery fee (3.5)");
});

test("a manual 'closed' override blocks new orders even on a working day/hour, but browsing (GET) still works", async () => {
  await asSuperAdmin("/admin/shop/settings", { method: "PUT", body: JSON.stringify({ manualOverride: "closed" }) });

  const settingsRes = await fetch(`${baseUrl}/shop/settings`);
  assert.equal(((await settingsRes.json()) as any).isOpen, false);

  const browseRes = await fetch(`${baseUrl}/shop/products?categoryId=${categoryId}`);
  assert.equal(browseRes.status, 200, "browsing must still work while closed");

  const orderRes = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  assert.equal(orderRes.status, 409);
  const product = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(product!.stock, 3, "stock must not move for a rejected order");
});

test("workingDays must be a non-empty array of 0-6", async () => {
  const res = await asSuperAdmin("/admin/shop/settings", { method: "PUT", body: JSON.stringify({ workingDays: [] }) });
  assert.equal(res.status, 400);
});

test("a manual 'open' override allows orders even outside the configured schedule", async () => {
  // Bypasses the admin route's own validation (which rejects an empty
  // workingDays) to directly simulate "today isn't a working day" --
  // the schedule alone would resolve to closed here.
  await query(`UPDATE shop_settings SET working_days='{}' WHERE id=true`);
  const closedRes = await fetch(`${baseUrl}/shop/settings`);
  assert.equal(((await closedRes.json()) as any).isOpen, false, "no working days at all must resolve to closed");

  const openRes = await asSuperAdmin("/admin/shop/settings", { method: "PUT", body: JSON.stringify({ manualOverride: "open" }) });
  assert.equal(openRes.status, 200);
  assert.equal((await openRes.json() as any).isOpen, true, "manual override must win over the schedule");

  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  assert.equal(res.status, 201, "order must succeed while manually overridden open, despite the empty schedule");
});

// ==================== Gift orders + delivery notes ====================

test("a gift order stores recipient details and delivery notes", async () => {
  const giftRes = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
      deliveryNotes: "Leave at the gate",
      isGift: true,
      giftRecipientName: "Test Recipient",
      giftRecipientPhone: "617000333",
      giftMessage: "Happy Birthday!",
      giftWrap: true,
    }),
  });
  const gift = (await giftRes.json()) as any;
  assert.equal(giftRes.status, 201, JSON.stringify(gift));
  assert.equal(gift.isGift, true);
  assert.equal(gift.giftRecipientName, "Test Recipient");
  assert.equal(gift.giftRecipientPhone, "617000333");
  assert.equal(gift.giftMessage, "Happy Birthday!");
  assert.equal(gift.giftWrap, true);
  assert.equal(gift.deliveryNotes, "Leave at the gate");
});

test("a gift order without recipient name/phone is rejected", async () => {
  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
      isGift: true,
    }),
  });
  assert.equal(res.status, 400);
});

// ==================== Favorites / Wishlist ====================

test("a customer can favorite, list, and unfavorite a product", async () => {
  const listBefore = await (await asCustomer("/shop/favorites")).json() as any[];
  assert.equal(listBefore.length, 0);

  const addRes = await asCustomer("/shop/favorites", { method: "POST", body: JSON.stringify({ productId }) });
  assert.equal(addRes.status, 201);

  const addAgainRes = await asCustomer("/shop/favorites", { method: "POST", body: JSON.stringify({ productId }) });
  assert.equal(addAgainRes.status, 201, "favoriting an already-favorited product is a no-op, not an error");

  const listAfter = await (await asCustomer("/shop/favorites")).json() as any[];
  assert.equal(listAfter.length, 1);
  assert.equal(listAfter[0].id, productId);

  const removeRes = await asCustomer(`/shop/favorites/${productId}`, { method: "DELETE" });
  assert.equal(removeRes.status, 200);
  const listFinal = await (await asCustomer("/shop/favorites")).json() as any[];
  assert.equal(listFinal.length, 0);
});

test("POST /shop/favorites for a product that doesn't exist returns 404", async () => {
  const res = await asCustomer("/shop/favorites", { method: "POST", body: JSON.stringify({ productId: randomUUID() }) });
  assert.equal(res.status, 404);
});

// ==================== Reviews & Ratings ====================
//
// One order carries the whole flow (not-yet-delivered rejection -> mark
// delivered -> successful review -> duplicate rejection) to stay within
// the customer-shop-order-create rate limit (20 per 15 min) shared across
// this whole test file's order-creation calls.
test("reviews are purchase-gated to a delivered order, one per order item, and shown on the product", async () => {
  // Fabricates the order directly via SQL rather than a real
  // order-creation call -- this test is about review logic, not checkout,
  // and this file's order-creation calls already share a tight
  // customer-shop-order-create rate limit (20/15min) across many other
  // tests. Starts 'pending' so the "not delivered yet" rejection below is
  // real, not simulated.
  const orderId = "SHPTESTREVIEW1";
  await query(
    `INSERT INTO shop_orders (id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount, status, dedup_key)
     VALUES ($1,$2,'evc','617000111','Test Buyer','617000222','Mogadishu',25,'pending','test-review-dedup')
     ON CONFLICT (id) DO NOTHING`,
    [orderId, customerId]
  );
  const orderItemId = randomUUID();
  await query(
    `INSERT INTO shop_order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal) VALUES ($1,$2,$3,'Test Sneakers',25,1,25)`,
    [orderItemId, orderId, productId]
  );

  const tooEarlyRes = await asCustomer("/shop/reviews", {
    method: "POST",
    body: JSON.stringify({ orderItemId, rating: 5, reviewText: "Great!" }),
  });
  assert.equal(tooEarlyRes.status, 403, "an order that isn't delivered yet cannot be reviewed");

  const deliverRes = await asSuperAdmin(`/admin/shop/orders/${orderId}/status`, { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  assert.equal(deliverRes.status, 200);

  const reviewRes = await asCustomer("/shop/reviews", {
    method: "POST",
    body: JSON.stringify({ orderItemId, rating: 4, reviewText: "Good product, fast delivery." }),
  });
  const review = (await reviewRes.json()) as any;
  assert.equal(reviewRes.status, 201, JSON.stringify(review));

  const dupRes = await asCustomer("/shop/reviews", {
    method: "POST",
    body: JSON.stringify({ orderItemId, rating: 3, reviewText: "Trying to review the same purchase again" }),
  });
  assert.equal(dupRes.status, 409, "one review per purchased order item");

  const listRes = await fetch(`${baseUrl}/shop/products/${productId}/reviews`);
  const reviews = (await listRes.json()) as any[];
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].rating, 4);
  assert.equal(reviews[0].reviewText, "Good product, fast delivery.");
  assert.equal(reviews[0].hasPhoto, false);

  const productRes = await fetch(`${baseUrl}/shop/products/${productId}`);
  const product = (await productRes.json()) as any;
  assert.equal(Number(product.avgRating), 4);
  assert.equal(Number(product.reviewCount), 1);

  const adminListRes = await asSuperAdmin(`/admin/shop/reviews?productId=${productId}`);
  const adminReviews = (await adminListRes.json()) as any[];
  assert.equal(adminReviews.length, 1);

  const deleteRes = await asPlainAdmin(`/admin/shop/reviews/${review.id}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 403, "deleting a review still requires shop.manage");

  const deleteAsSuper = await asSuperAdmin(`/admin/shop/reviews/${review.id}`, { method: "DELETE" });
  assert.equal(deleteAsSuper.status, 200);
  const listAfterDelete = (await (await fetch(`${baseUrl}/shop/products/${productId}/reviews`)).json()) as any[];
  assert.equal(listAfterDelete.length, 0);
});

test("a rating outside 1-5, or reviewing someone else's order item, is rejected", async () => {
  // Fabricates another customer's already-delivered order directly
  // (rather than a real order-creation call) both to exercise
  // ownership-checking and to stay within this file's shared
  // customer-shop-order-create rate limit.
  const otherCustomerId = randomUUID();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,'617999888','Other Customer')`, [otherCustomerId]);
  const otherOrderId = "SHPTESTOTHER1";
  await query(
    `INSERT INTO shop_orders (id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount, status, dedup_key)
     VALUES ($1,$2,'evc','617999888','Other','617999888','Mogadishu',25,'delivered','test-other-dedup')
     ON CONFLICT (id) DO NOTHING`,
    [otherOrderId, otherCustomerId]
  );
  const itemId = randomUUID();
  await query(
    `INSERT INTO shop_order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal) VALUES ($1,$2,$3,'Test Sneakers',25,1,25)`,
    [itemId, otherOrderId, productId]
  );

  const wrongCustomerRes = await asCustomer("/shop/reviews", { method: "POST", body: JSON.stringify({ orderItemId: itemId, rating: 5 }) });
  assert.equal(wrongCustomerRes.status, 404, "a customer cannot review an order item that isn't theirs");

  const badRatingRes = await asCustomer("/shop/reviews", { method: "POST", body: JSON.stringify({ orderItemId: itemId, rating: 6 }) });
  assert.equal(badRatingRes.status, 400);

  await query(`DELETE FROM shop_order_items WHERE id=$1`, [itemId]);
  await query(`DELETE FROM shop_orders WHERE id=$1`, [otherOrderId]);
  await query(`DELETE FROM customers WHERE id=$1`, [otherCustomerId]);
});

// ==================== Returns / Exchange / Refund requests ====================
//
// Orders are fabricated directly via SQL (same technique as the review
// tests above) rather than real order-creation calls, both to control
// delivered/not-delivered state precisely and to stay within this file's
// shared customer-shop-order-create rate limit.
async function fabricateOrder(id: string, status: string, custId = customerId) {
  await query(
    `INSERT INTO shop_orders (id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount, status, dedup_key)
     VALUES ($1,$2,'evc','617000111','Test Buyer','617000222','Mogadishu',25,$3,$4)
     ON CONFLICT (id) DO NOTHING`,
    [id, custId, status, `test-dedup-${id}`]
  );
}

test("a return/exchange/refund can only be requested against the requester's own delivered order", async () => {
  await fabricateOrder("SHPTESTRET1", "processing");
  const notDeliveredRes = await asCustomer("/shop/returns", {
    method: "POST",
    body: JSON.stringify({ orderId: "SHPTESTRET1", type: "return", reason: "Wrong size" }),
  });
  assert.equal(notDeliveredRes.status, 403);

  await fabricateOrder("SHPTESTRET2", "delivered");
  const okRes = await asCustomer("/shop/returns", {
    method: "POST",
    body: JSON.stringify({ orderId: "SHPTESTRET2", type: "return", reason: "Wrong size" }),
  });
  const req1 = (await okRes.json()) as any;
  assert.equal(okRes.status, 201, JSON.stringify(req1));
  assert.equal(req1.status, "requested");
  assert.equal(req1.type, "return");

  const badTypeRes = await asCustomer("/shop/returns", {
    method: "POST",
    body: JSON.stringify({ orderId: "SHPTESTRET2", type: "warranty-claim" }),
  });
  assert.equal(badTypeRes.status, 400);

  const otherCustomerId = randomUUID();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,'617888777','Someone Else')`, [otherCustomerId]);
  await fabricateOrder("SHPTESTRET3", "delivered", otherCustomerId);
  const notOwnerRes = await asCustomer("/shop/returns", {
    method: "POST",
    body: JSON.stringify({ orderId: "SHPTESTRET3", type: "refund" }),
  });
  assert.equal(notOwnerRes.status, 404, "a customer cannot open a request against someone else's order");
  await query(`DELETE FROM shop_orders WHERE id='SHPTESTRET3'`);
  await query(`DELETE FROM customers WHERE id=$1`, [otherCustomerId]);
});

test("only one active request per order at a time; a new one can be opened after the first is rejected", async () => {
  await fabricateOrder("SHPTESTRET4", "delivered");
  const first = await asCustomer("/shop/returns", { method: "POST", body: JSON.stringify({ orderId: "SHPTESTRET4", type: "exchange" }) });
  const firstReq = (await first.json()) as any;
  assert.equal(first.status, 201);

  const dupRes = await asCustomer("/shop/returns", { method: "POST", body: JSON.stringify({ orderId: "SHPTESTRET4", type: "refund" }) });
  assert.equal(dupRes.status, 409, "an order with an active request cannot have a second one opened");

  const rejectRes = await asSuperAdmin(`/admin/shop/returns/${firstReq.id}/status`, { method: "PUT", body: JSON.stringify({ status: "rejected", adminNote: "Outside return window" }) });
  assert.equal(rejectRes.status, 200);

  const secondRes = await asCustomer("/shop/returns", { method: "POST", body: JSON.stringify({ orderId: "SHPTESTRET4", type: "refund" }) });
  assert.equal(secondRes.status, 201, "a new request can be opened once the prior one is terminal");
});

test("admin drives a request through the full Requested -> Approved -> Processing -> Completed lifecycle; skipping a stage is rejected", async () => {
  await fabricateOrder("SHPTESTRET5", "delivered");
  const createRes = await asCustomer("/shop/returns", { method: "POST", body: JSON.stringify({ orderId: "SHPTESTRET5", type: "return", reason: "Changed my mind" }) });
  const reqRow = (await createRes.json()) as any;

  const skipRes = await asSuperAdmin(`/admin/shop/returns/${reqRow.id}/status`, { method: "PUT", body: JSON.stringify({ status: "completed" }) });
  assert.equal(skipRes.status, 409, "cannot jump straight from requested to completed");

  const approveRes = await asSuperAdmin(`/admin/shop/returns/${reqRow.id}/status`, { method: "PUT", body: JSON.stringify({ status: "approved" }) });
  assert.equal(approveRes.status, 200);
  assert.equal((await approveRes.json() as any).status, "approved");

  const backwardsRes = await asSuperAdmin(`/admin/shop/returns/${reqRow.id}/status`, { method: "PUT", body: JSON.stringify({ status: "requested" }) });
  assert.equal(backwardsRes.status, 409, "cannot move backwards");

  const processingRes = await asSuperAdmin(`/admin/shop/returns/${reqRow.id}/status`, { method: "PUT", body: JSON.stringify({ status: "processing" }) });
  assert.equal(processingRes.status, 200);

  const completedRes = await asSuperAdmin(`/admin/shop/returns/${reqRow.id}/status`, { method: "PUT", body: JSON.stringify({ status: "completed" }) });
  const completed = (await completedRes.json()) as any;
  assert.equal(completedRes.status, 200);
  assert.equal(completed.status, "completed");

  const afterTerminalRes = await asSuperAdmin(`/admin/shop/returns/${reqRow.id}/status`, { method: "PUT", body: JSON.stringify({ status: "processing" }) });
  assert.equal(afterTerminalRes.status, 409, "no further changes once completed");

  const customerListRes = await asCustomer("/shop/returns");
  const customerList = (await customerListRes.json()) as any[];
  assert.ok(customerList.some((r) => r.id === reqRow.id && r.status === "completed"));
});

test("a regular Admin without shop.manage cannot manage return requests", async () => {
  await fabricateOrder("SHPTESTRET6", "delivered");
  const createRes = await asCustomer("/shop/returns", { method: "POST", body: JSON.stringify({ orderId: "SHPTESTRET6", type: "return" }) });
  const reqRow = (await createRes.json()) as any;
  const listRes = await asPlainAdmin("/admin/shop/returns");
  assert.equal(listRes.status, 403);
  const updateRes = await asPlainAdmin(`/admin/shop/returns/${reqRow.id}/status`, { method: "PUT", body: JSON.stringify({ status: "approved" }) });
  assert.equal(updateRes.status, 403);
});

// ==================== Order status timeline ====================

test("GET /shop/orders/:id includes a status timeline, appended to as the order progresses", async () => {
  await fabricateOrder("SHPTESTHIST1", "pending");
  await query(`INSERT INTO shop_order_status_history (order_id, status) VALUES ('SHPTESTHIST1','pending')`);

  const shipRes = await asSuperAdmin("/admin/shop/orders/SHPTESTHIST1/status", { method: "PUT", body: JSON.stringify({ status: "processing" }) });
  assert.equal(shipRes.status, 200);
  const shipRes2 = await asSuperAdmin("/admin/shop/orders/SHPTESTHIST1/status", { method: "PUT", body: JSON.stringify({ status: "shipped", trackingNote: "Left warehouse" }) });
  assert.equal(shipRes2.status, 200);

  const detail = (await (await asCustomer("/shop/orders/SHPTESTHIST1")).json()) as any;
  const statuses = (detail.statusHistory as any[]).map((h) => h.status);
  assert.deepEqual(statuses, ["pending", "processing", "shipped"]);
  assert.equal(detail.statusHistory[2].note, "Left warehouse");
});

test("confirming payment on a pending order appends a 'processing' timeline entry", async () => {
  await fabricateOrder("SHPTESTHIST2", "pending");
  await query(`INSERT INTO shop_order_status_history (order_id, status) VALUES ('SHPTESTHIST2','pending')`);
  const payRes = await asSuperAdmin("/admin/shop/orders/SHPTESTHIST2/payment-status", { method: "PUT", body: "{}" });
  assert.equal(payRes.status, 200);
  const detail = (await (await asCustomer("/shop/orders/SHPTESTHIST2")).json()) as any;
  assert.deepEqual((detail.statusHistory as any[]).map((h) => h.status), ["pending", "processing"]);
});

// ==================== Cancel Order ====================

test("a customer can cancel their own pending/processing order, restoring stock; a shipped order cannot be cancelled", async () => {
  await fabricateOrder("SHPTESTCANCEL1", "pending");
  await query(
    `INSERT INTO shop_order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal) VALUES ($1,'SHPTESTCANCEL1',$2,'Test Sneakers',25,1,25)`,
    [randomUUID(), productId]
  );
  await query(`UPDATE shop_products SET stock = stock - 1 WHERE id=$1`, [productId]);
  const before = (await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]))!.stock;

  const cancelRes = await asCustomer("/shop/orders/SHPTESTCANCEL1/cancel", { method: "POST" });
  const cancelled = (await cancelRes.json()) as any;
  assert.equal(cancelRes.status, 200, JSON.stringify(cancelled));
  assert.equal(cancelled.status, "cancelled");

  const after = (await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]))!.stock;
  assert.equal(after, before + 1, "cancelling must give the reserved stock back");

  await fabricateOrder("SHPTESTCANCEL2", "shipped");
  const tooLateRes = await asCustomer("/shop/orders/SHPTESTCANCEL2/cancel", { method: "POST" });
  assert.equal(tooLateRes.status, 409, "a shipped order can no longer be self-cancelled");
});

test("a customer cannot cancel someone else's order", async () => {
  const otherCustomerId = randomUUID();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,'617777666','Someone Else')`, [otherCustomerId]);
  await fabricateOrder("SHPTESTCANCEL3", "pending", otherCustomerId);
  const res = await asCustomer("/shop/orders/SHPTESTCANCEL3/cancel", { method: "POST" });
  assert.equal(res.status, 404);
  await query(`DELETE FROM shop_orders WHERE id='SHPTESTCANCEL3'`);
  await query(`DELETE FROM customers WHERE id=$1`, [otherCustomerId]);
});

// ==================== Delivery Addresses ====================

test("a customer can save, list, update, and delete delivery addresses; the first one saved becomes the default automatically", async () => {
  const listEmpty = (await (await asCustomer("/shop/addresses")).json()) as any[];
  assert.equal(listEmpty.length, 0);

  const firstRes = await asCustomer("/shop/addresses", {
    method: "POST",
    body: JSON.stringify({ label: "Home", recipientName: "Test Buyer", phone: "617000222", addressText: "Mogadishu" }),
  });
  const first = (await firstRes.json()) as any;
  assert.equal(firstRes.status, 201);
  assert.equal(first.isDefault, true, "the first saved address becomes the default automatically");

  const secondRes = await asCustomer("/shop/addresses", {
    method: "POST",
    body: JSON.stringify({ label: "Work", recipientName: "Test Buyer", phone: "617000222", addressText: "Hodan, Mogadishu" }),
  });
  const second = (await secondRes.json()) as any;
  assert.equal(second.isDefault, false, "a second address is not the default unless asked");

  const makeDefaultRes = await asCustomer(`/shop/addresses/${second.id}`, { method: "PUT", body: JSON.stringify({ isDefault: true }) });
  assert.equal(makeDefaultRes.status, 200);
  assert.equal((await makeDefaultRes.json() as any).isDefault, true);

  const list = (await (await asCustomer("/shop/addresses")).json()) as any[];
  assert.equal(list.length, 2);
  const firstNow = list.find((a) => a.id == first.id);
  assert.equal(firstNow.isDefault, false, "setting a new default must clear the old one");

  const deleteRes = await asCustomer(`/shop/addresses/${first.id}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
  const listAfterDelete = (await (await asCustomer("/shop/addresses")).json()) as any[];
  assert.equal(listAfterDelete.length, 1);
});

test("POST /shop/addresses requires recipientName, phone, and addressText", async () => {
  const res = await asCustomer("/shop/addresses", { method: "POST", body: JSON.stringify({ recipientName: "Only Name" }) });
  assert.equal(res.status, 400);
});

// ==================== Recently Viewed / Recommended ====================

test("viewing a product records it, GET recently-viewed lists it most-recent-first, and it's excluded from recommendations", async () => {
  const secondProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, price, stock, best_seller) VALUES ($1,$2,'Test Bestseller',15,10,true) RETURNING id`,
    [randomUUID(), categoryId]
  );

  const viewRes = await asCustomer(`/shop/products/${productId}/view`, { method: "POST" });
  assert.equal(viewRes.status, 200);

  const recentRes = await asCustomer("/shop/products/recently-viewed");
  const recent = (await recentRes.json()) as any[];
  assert.equal(recentRes.status, 200);
  assert.ok(recent.some((p) => p.id === productId));

  const recommendedForProduct = (await (await fetch(`${baseUrl}/shop/products/${productId}/recommended`)).json()) as any[];
  assert.ok(!recommendedForProduct.some((p) => p.id === productId), "a product never recommends itself");
  assert.ok(recommendedForProduct.some((p) => p.id === secondProduct!.id), "same-category products are recommended, best-seller first");

  const personalized = (await (await asCustomer("/shop/recommendations")).json()) as any[];
  assert.equal((personalized as any[]).some((p) => p.id === productId), false, "an already-viewed product is not recommended back to the same customer");
});

test("POST /shop/products/:id/view for a nonexistent product returns 404", async () => {
  const res = await asCustomer(`/shop/products/${randomUUID()}/view`, { method: "POST" });
  assert.equal(res.status, 404);
});

// ==================== Price Change Warning (cart validate) ====================

test("POST /shop/cart/validate reflects a live price change, out-of-stock, and a deactivated product", async () => {
  const outOfStockProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, price, stock) VALUES ($1,$2,'Test Out Of Stock',5,0) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const inactiveProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, price, stock, active) VALUES ($1,$2,'Test Inactive',5,10,false) RETURNING id`,
    [randomUUID(), categoryId]
  );

  const before = await fetch(`${baseUrl}/shop/cart/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ productId, quantity: 1 }] }),
  });
  const beforeBody = (await before.json()) as any;
  assert.equal(beforeBody.items[0].currentPrice, 25);

  await asSuperAdmin(`/admin/shop/products/${productId}`, { method: "PUT", body: JSON.stringify({ price: 30 }) });

  const res = await fetch(`${baseUrl}/shop/cart/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [
        { productId, quantity: 1 },
        { productId: outOfStockProduct!.id, quantity: 1 },
        { productId: inactiveProduct!.id, quantity: 1 },
      ],
    }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200);
  assert.equal(body.items[0].currentPrice, 30, "price change since the cart was built must be reflected");
  assert.equal(body.items[0].inStock, true);
  assert.equal(body.items[1].inStock, false, "0 stock must report inStock=false");
  assert.equal(body.items[2].available, false, "a deactivated product must report available=false");
});

test("POST /shop/cart/validate requires a non-empty items array with valid entries", async () => {
  const emptyRes = await fetch(`${baseUrl}/shop/cart/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [] }) });
  assert.equal(emptyRes.status, 400);
  const badRes = await fetch(`${baseUrl}/shop/cart/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ quantity: 0 }] }) });
  assert.equal(badRes.status, 400);
});

// ==================== Payment Retry ====================

test("retry-payment re-issues a dial string for a still-unpaid order, using the payment method's current template", async () => {
  await fabricateOrder("SHPTESTRETRY1", "pending");
  await query(`UPDATE shop_orders SET total_amount=50 WHERE id='SHPTESTRETRY1'`);

  const res = await asCustomer("/shop/orders/SHPTESTRETRY1/retry-payment", { method: "POST" });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.dialUssd, "*712*610338686*50#");
});

test("retry-payment is rejected once paid, once shipped, or for someone else's order", async () => {
  await fabricateOrder("SHPTESTRETRY2", "pending");
  await query(`UPDATE shop_orders SET payment_status='paid' WHERE id='SHPTESTRETRY2'`);
  const paidRes = await asCustomer("/shop/orders/SHPTESTRETRY2/retry-payment", { method: "POST" });
  assert.equal(paidRes.status, 409);

  await fabricateOrder("SHPTESTRETRY3", "shipped");
  const shippedRes = await asCustomer("/shop/orders/SHPTESTRETRY3/retry-payment", { method: "POST" });
  assert.equal(shippedRes.status, 409);

  const otherCustomerId = randomUUID();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,'617555444','Someone Else')`, [otherCustomerId]);
  await fabricateOrder("SHPTESTRETRY4", "pending", otherCustomerId);
  const wrongOwnerRes = await asCustomer("/shop/orders/SHPTESTRETRY4/retry-payment", { method: "POST" });
  assert.equal(wrongOwnerRes.status, 404);
  await query(`DELETE FROM shop_orders WHERE id='SHPTESTRETRY4'`);
  await query(`DELETE FROM customers WHERE id=$1`, [otherCustomerId]);
});

// ==================== Product Variants + Flash Sales + Bundle Deals ====================

test("GET /shop/products/:id embeds active variants; an inactive variant is hidden from the customer-facing read", async () => {
  const product = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Variant Read Product','',20.00,10) RETURNING id`,
    [randomUUID(), categoryId]
  );
  await query(`INSERT INTO shop_product_variants (id, product_id, label, stock, position) VALUES ($1,$2,'Small',5,0)`, [randomUUID(), product!.id]);
  const inactiveId = randomUUID();
  await query(`INSERT INTO shop_product_variants (id, product_id, label, stock, active, position) VALUES ($1,$2,'Discontinued',0,false,1)`, [inactiveId, product!.id]);

  const res = await fetch(`${baseUrl}/shop/products/${product!.id}`);
  const body = (await res.json()) as any;
  assert.equal(res.status, 200);
  assert.equal(body.variants.length, 1);
  assert.equal(body.variants[0].label, "Small");
});

test("admin can create, update, and delete a product's variants; a non-shop.manage admin is rejected", async () => {
  const createRes = await asSuperAdmin(`/admin/shop/products/${productId}/variants`, {
    method: "POST",
    body: JSON.stringify({ label: "Medium / Blue", attributes: { size: "Medium", color: "Blue" }, price: 27.5, stock: 4 }),
  });
  const variant = (await createRes.json()) as any;
  assert.equal(createRes.status, 201, JSON.stringify(variant));
  assert.equal(variant.label, "Medium / Blue");
  assert.equal(Number(variant.price), 27.5);

  const plainRes = await asPlainAdmin(`/admin/shop/products/${productId}/variants`, {
    method: "POST",
    body: JSON.stringify({ label: "X", stock: 1 }),
  });
  assert.equal(plainRes.status, 403);

  const updateRes = await asSuperAdmin(`/admin/shop/products/${productId}/variants/${variant.id}`, {
    method: "PUT",
    body: JSON.stringify({ stock: 9 }),
  });
  const updated = (await updateRes.json()) as any;
  assert.equal(updateRes.status, 200);
  assert.equal(updated.stock, 9);

  const listRes = await asSuperAdmin(`/admin/shop/products/${productId}/variants`);
  const list = (await listRes.json()) as any[];
  assert.equal(list.length, 1);

  const deleteRes = await asSuperAdmin(`/admin/shop/products/${productId}/variants/${variant.id}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
  const afterDelete = (await (await asSuperAdmin(`/admin/shop/products/${productId}/variants`)).json()) as any[];
  assert.equal(afterDelete.length, 0);
});

test("admin can schedule a flash sale, and GET /shop/products?discounted=true includes a flash-sale product with no independent oldPrice", async () => {
  const createRes = await asSuperAdmin("/admin/shop/flash-sales", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Weekend Flash Sale",
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      endsAt: new Date(Date.now() + 3600_000).toISOString(),
      items: [{ productId, salePrice: 18 }],
    }),
  });
  const created = (await createRes.json()) as any;
  assert.equal(createRes.status, 201, JSON.stringify(created));

  const productRes = await fetch(`${baseUrl}/shop/products/${productId}`);
  const product = (await productRes.json()) as any;
  assert.equal(Number(product.price), 18, "the flash sale price is shown as the product's price");
  assert.equal(Number(product.oldPrice), 25, "the pre-sale price is shown struck through");

  const discountedRes = await fetch(`${baseUrl}/shop/products?discounted=true`);
  const discounted = (await discountedRes.json()) as any[];
  assert.ok(discounted.some((p) => p.id === productId), "a flash-sale product is included in discounted=true even with no independent oldPrice");

  const deactivateRes = await asSuperAdmin(`/admin/shop/flash-sales/${created.id}`, { method: "PUT", body: JSON.stringify({ active: false }) });
  assert.equal(deactivateRes.status, 200);
  const afterDeactivate = (await (await fetch(`${baseUrl}/shop/products/${productId}`)).json()) as any;
  assert.equal(Number(afterDeactivate.price), 25, "price reverts once the flash sale is deactivated");

  const deleteRes = await asSuperAdmin(`/admin/shop/flash-sales/${created.id}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
});

test("admin can create a bundle deal, it's publicly listable, and a non-shop.manage admin is rejected", async () => {
  const secondProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Bundle Second Product','',12.00,5) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const createRes = await asSuperAdmin("/admin/shop/bundles", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Starter Bundle",
      description: "Two great products together",
      bundlePrice: 30,
      items: [
        { productId, quantity: 1 },
        { productId: secondProduct!.id, quantity: 1 },
      ],
    }),
  });
  const created = (await createRes.json()) as any;
  assert.equal(createRes.status, 201, JSON.stringify(created));

  const plainRes = await asPlainAdmin("/admin/shop/bundles", { method: "POST", body: JSON.stringify({ name: "X", bundlePrice: 1, items: [{ productId }] }) });
  assert.equal(plainRes.status, 403);

  const publicListRes = await fetch(`${baseUrl}/shop/bundles`);
  const publicList = (await publicListRes.json()) as any[];
  const found = publicList.find((b) => b.id === created.id);
  assert.ok(found, "the bundle is publicly listable");
  assert.equal(found.items.length, 2);

  const publicDetailRes = await fetch(`${baseUrl}/shop/bundles/${created.id}`);
  const publicDetail = (await publicDetailRes.json()) as any;
  assert.equal(publicDetail.name, "Test Starter Bundle");

  const updateRes = await asSuperAdmin(`/admin/shop/bundles/${created.id}`, { method: "PUT", body: JSON.stringify({ active: false }) });
  assert.equal(updateRes.status, 200);
  const afterDeactivateRes = await fetch(`${baseUrl}/shop/bundles`);
  const afterDeactivate = (await afterDeactivateRes.json()) as any[];
  assert.ok(!afterDeactivate.some((b) => b.id === created.id), "a deactivated bundle is no longer publicly listed");

  const deleteRes = await asSuperAdmin(`/admin/shop/bundles/${created.id}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
});

test("cancelling a fabricated order with a variant line and a bundle line restores both correctly", async () => {
  const variantProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Cancel Variant Product','',20.00,0) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const variant = await queryOne<{ id: string }>(
    `INSERT INTO shop_product_variants (id, product_id, label, stock) VALUES ($1,$2,'One Size',1) RETURNING id`,
    [randomUUID(), variantProduct!.id]
  );
  const bundleProduct = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Cancel Bundle Product','',5.00,2) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const bundle = await queryOne<{ id: string }>(`INSERT INTO shop_bundle_deals (id, name, bundle_price) VALUES ($1,'Test Cancel Bundle',5) RETURNING id`, [randomUUID()]);
  await query(`INSERT INTO shop_bundle_deal_items (bundle_id, product_id, quantity) VALUES ($1,$2,2)`, [bundle!.id, bundleProduct!.id]);

  await fabricateOrder("SHPTESTVARBUNDLE1", "pending");
  await query(
    `INSERT INTO shop_order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal, variant_id, variant_label)
     VALUES ($1,'SHPTESTVARBUNDLE1',$2,'Variant Product',20,1,20,$3,'One Size')`,
    [randomUUID(), variantProduct!.id, variant!.id]
  );
  await query(
    `INSERT INTO shop_order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal, bundle_id, bundle_name)
     VALUES ($1,'SHPTESTVARBUNDLE1',NULL,'Cancel Bundle',5,1,5,$2,'Test Cancel Bundle')`,
    [randomUUID(), bundle!.id]
  );
  // Simulate the stock already having been reserved at creation time.
  await query(`UPDATE shop_product_variants SET stock=0 WHERE id=$1`, [variant!.id]);
  await query(`UPDATE shop_products SET stock=0 WHERE id=$1`, [bundleProduct!.id]);

  const cancelRes = await asCustomer("/shop/orders/SHPTESTVARBUNDLE1/cancel", { method: "POST" });
  assert.equal(cancelRes.status, 200);
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_product_variants WHERE id=$1`, [variant!.id]))!.stock, 1);
  assert.equal((await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [bundleProduct!.id]))!.stock, 2, "bundle quantity 2 x order quantity 1 restored");
});

test("POST /shop/cart/validate reports a specific variant's live price and stock", async () => {
  const product = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Cart Validate Variant Product','',20.00,10) RETURNING id`,
    [randomUUID(), categoryId]
  );
  const variant = await queryOne<{ id: string }>(
    `INSERT INTO shop_product_variants (id, product_id, label, price, stock) VALUES ($1,$2,'Rare Size',45,1) RETURNING id`,
    [randomUUID(), product!.id]
  );
  const res = await fetch(`${baseUrl}/shop/cart/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ productId: product!.id, variantId: variant!.id, quantity: 2 }] }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(Number(body.items[0].currentPrice), 45);
  assert.equal(body.items[0].inStock, false, "only 1 in stock, 2 requested");
});

// ==================== Low-Stock Alerts / Back-in-Stock Notifications ====================

test("GET /admin/shop/products/low-stock lists only active products at or below their own threshold", async () => {
  await query(`UPDATE shop_products SET stock=2, low_stock_threshold=5 WHERE id=$1`, [productId]);
  const aboveThreshold = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock, low_stock_threshold) VALUES ($1,$2,'Test Well Stocked Product','',10,50,5) RETURNING id`,
    [randomUUID(), categoryId]
  );

  const res = await asSuperAdmin("/admin/shop/products/low-stock");
  const list = (await res.json()) as any[];
  assert.equal(res.status, 200);
  assert.ok(list.some((p) => p.id === productId), "a product at/under its threshold is listed");
  assert.ok(!list.some((p) => p.id === aboveThreshold!.id), "a well-stocked product is not listed");

  const plainRes = await asPlainAdmin("/admin/shop/products/low-stock");
  assert.equal(plainRes.status, 403);
});

test("a customer subscribes to back-in-stock, and restocking the product notifies and marks it notified", async () => {
  await query(`UPDATE shop_products SET stock=0 WHERE id=$1`, [productId]);

  const subscribeRes = await asCustomer(`/shop/products/${productId}/notify-me`, { method: "POST" });
  assert.equal(subscribeRes.status, 201);

  const doubleTapRes = await asCustomer(`/shop/products/${productId}/notify-me`, { method: "POST" });
  assert.equal(doubleTapRes.status, 201, "idempotent against a double-tap");

  const before = await queryOne<{ notified: boolean }>(`SELECT notified FROM shop_stock_notify_requests WHERE customer_id=$1 AND product_id=$2`, [customerId, productId]);
  assert.equal(before!.notified, false);

  const restockRes = await asSuperAdmin(`/admin/shop/products/${productId}`, { method: "PUT", body: JSON.stringify({ stock: 20 }) });
  assert.equal(restockRes.status, 200);

  const after = await queryOne<{ notified: boolean }>(`SELECT notified FROM shop_stock_notify_requests WHERE customer_id=$1 AND product_id=$2`, [customerId, productId]);
  assert.equal(after!.notified, true, "restocking marks the subscriber notified");

  const notification = await queryOne(`SELECT type, title FROM notifications WHERE customer_id=$1 AND type='shop_back_in_stock' ORDER BY sent_at DESC LIMIT 1`, [customerId]);
  assert.ok(notification, "a shop_back_in_stock notification row was written");
});

test("POST /shop/products/:id/notify-me is rejected while the product is still in stock", async () => {
  const res = await asCustomer(`/shop/products/${productId}/notify-me`, { method: "POST" });
  assert.equal(res.status, 409);
});

// ==================== Delivery Zones ====================

test("admin can create, list, and update delivery zones; they're publicly readable", async () => {
  const createRes = await asSuperAdmin("/admin/shop/delivery-zones", { method: "POST", body: JSON.stringify({ name: "Test Hodan Zone", fee: 3.5 }) });
  const created = (await createRes.json()) as any;
  assert.equal(createRes.status, 201, JSON.stringify(created));

  const plainRes = await asPlainAdmin("/admin/shop/delivery-zones", { method: "POST", body: JSON.stringify({ name: "X", fee: 1 }) });
  assert.equal(plainRes.status, 403);

  const dupRes = await asSuperAdmin("/admin/shop/delivery-zones", { method: "POST", body: JSON.stringify({ name: "Test Hodan Zone", fee: 5 }) });
  assert.equal(dupRes.status, 409);

  const publicRes = await fetch(`${baseUrl}/shop/delivery-zones`);
  const publicList = (await publicRes.json()) as any[];
  assert.ok(publicList.some((z) => z.id === created.id));

  const updateRes = await asSuperAdmin(`/admin/shop/delivery-zones/${created.id}`, { method: "PUT", body: JSON.stringify({ fee: 6 }) });
  const updated = (await updateRes.json()) as any;
  assert.equal(Number(updated.fee), 6);

  const deactivateRes = await asSuperAdmin(`/admin/shop/delivery-zones/${created.id}`, { method: "PUT", body: JSON.stringify({ active: false }) });
  assert.equal(deactivateRes.status, 200);
  const afterDeactivateRes = await fetch(`${baseUrl}/shop/delivery-zones`);
  const afterDeactivate = (await afterDeactivateRes.json()) as any[];
  assert.ok(!afterDeactivate.some((z) => z.id === created.id));

  const deleteRes = await asSuperAdmin(`/admin/shop/delivery-zones/${created.id}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
});

// ==================== Analytics ====================

test("GET /admin/shop/analytics summarizes paid revenue, order status counts, and top products; rejected without shop.manage", async () => {
  await fabricateOrder("SHPTESTANALYTICS1", "delivered");
  await query(`UPDATE shop_orders SET payment_status='paid', total_amount=99 WHERE id='SHPTESTANALYTICS1'`);
  await fabricateOrder("SHPTESTANALYTICS2", "pending");

  const res = await asSuperAdmin("/admin/shop/analytics");
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.orderCount >= 1);
  assert.ok(body.revenue >= 99);
  assert.ok(Array.isArray(body.ordersByStatus));
  assert.ok(Array.isArray(body.dailyRevenue));
  assert.ok(Array.isArray(body.topProducts));

  const plainRes = await asPlainAdmin("/admin/shop/analytics");
  assert.equal(plainRes.status, 403);
});

// ==================== Product Images (2-4 per product, no video) ====================

const TEST_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("admin can add up to 4 images to a product; a 5th is rejected", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await asSuperAdmin(`/admin/shop/products/${productId}/images`, {
      method: "POST",
      body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }),
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 201, JSON.stringify(body));
    ids.push(body.id);
  }

  const fifthRes = await asSuperAdmin(`/admin/shop/products/${productId}/images`, {
    method: "POST",
    body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }),
  });
  assert.equal(fifthRes.status, 400);
  const fifthBody = (await fifthRes.json()) as any;
  assert.match(fifthBody.error, /Maximum 4 images/);

  const listed = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM shop_product_images WHERE product_id=$1`, [productId]);
  assert.equal(Number(listed?.n), 4);
});

test("an image upload rejects a non-image mime type (no video)", async () => {
  const res = await asSuperAdmin(`/admin/shop/products/${productId}/images`, {
    method: "POST",
    body: JSON.stringify({ imageBase64: "data:video/mp4;base64,AAAA" }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.match(body.error, /Only image files are allowed/);
});

test("deleting an image is rejected once a product would drop below the 2-image minimum", async () => {
  const first = await asSuperAdmin(`/admin/shop/products/${productId}/images`, {
    method: "POST",
    body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }),
  });
  const firstBody = (await first.json()) as any;
  const second = await asSuperAdmin(`/admin/shop/products/${productId}/images`, {
    method: "POST",
    body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }),
  });
  const secondBody = (await second.json()) as any;

  // At exactly 2 images (the minimum), removing either one is rejected.
  const blockedRes = await asSuperAdmin(`/admin/shop/products/${productId}/images/${firstBody.id}`, { method: "DELETE" });
  assert.equal(blockedRes.status, 400);
  const blockedBody = (await blockedRes.json()) as any;
  assert.match(blockedBody.error, /at least 2 images/);

  // Add a 3rd so the product is now above the minimum -- deleting down to 2 is fine.
  const third = await asSuperAdmin(`/admin/shop/products/${productId}/images`, {
    method: "POST",
    body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }),
  });
  const thirdBody = (await third.json()) as any;
  const allowedRes = await asSuperAdmin(`/admin/shop/products/${productId}/images/${thirdBody.id}`, { method: "DELETE" });
  assert.equal(allowedRes.status, 200);

  const remaining = await query<{ id: string }>(`SELECT id FROM shop_product_images WHERE product_id=$1`, [productId]);
  assert.equal(remaining.length, 2);
  assert.deepEqual(remaining.map((r) => r.id).sort(), [firstBody.id, secondBody.id].sort());
});

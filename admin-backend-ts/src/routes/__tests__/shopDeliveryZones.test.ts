// Kept as its own file (its own process, its own in-memory rate-limit
// bucket) specifically so this can make a couple of real
// POST /shop/orders calls without competing with shop.test.ts's own
// tight customer-shop-order-create budget (20 per 15 min, already fully
// spent by that file's own coverage).
import { test, before, after } from "node:test";
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
let customerToken: string;
let customerId: string;
let categoryId: string;
let productId: string;

before(async () => {
  const CUSTOMER_PHONE = "617222333";
  const existingCustomer = await queryOne<{ id: string }>(`SELECT id FROM customers WHERE phone=$1`, [CUSTOMER_PHONE]);
  customerId = existingCustomer?.id ?? randomUUID();
  if (!existingCustomer) {
    await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Delivery Zone Test Customer')`, [customerId, CUSTOMER_PHONE]);
  }
  customerToken = signAccessToken(customerId, "customer");

  await query(`UPDATE shop_settings SET delivery_fee=0, working_days='{0,1,2,3,4,5,6}', opening_time='00:00', closing_time='23:59', manual_override=NULL WHERE id=true`);
  await query(`DELETE FROM shop_products WHERE name LIKE 'Test Zone %'`);
  await query(`DELETE FROM shop_categories WHERE name = 'Test Zone Category'`);
  await query(`DELETE FROM shop_delivery_zones WHERE name LIKE 'Test %'`);

  const cat = await queryOne<{ id: string }>(
    `INSERT INTO shop_categories (id, name, emoji, position) VALUES ($1,'Test Zone Category','👟',98) RETURNING id`,
    [randomUUID()]
  );
  categoryId = cat!.id;
  const product = await queryOne<{ id: string }>(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,'Test Zone Product','',10.00,5) RETURNING id`,
    [randomUUID(), categoryId]
  );
  productId = product!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await query(`DELETE FROM shop_order_items WHERE order_id IN (SELECT id FROM shop_orders WHERE customer_id=$1)`, [customerId]);
  await query(`DELETE FROM shop_orders WHERE customer_id=$1`, [customerId]);
  await query(`DELETE FROM shop_delivery_zones WHERE name LIKE 'Test %'`);
  await query(`DELETE FROM shop_products WHERE name LIKE 'Test Zone %'`);
  await query(`DELETE FROM shop_categories WHERE name = 'Test Zone Category'`);
  await query(`DELETE FROM customers WHERE id=$1`, [customerId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function asCustomer(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${customerToken}`, "Content-Type": "application/json" } });
}

test("a valid deliveryZoneId overrides the flat delivery fee with the zone's own fee, and is stored on the order", async () => {
  const zone = await queryOne<{ id: string }>(
    `INSERT INTO shop_delivery_zones (id, name, fee) VALUES ($1,'Test Hodan Zone',4.25) RETURNING id`,
    [randomUUID()]
  );

  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
      deliveryZoneId: zone!.id,
    }),
  });
  const order = (await res.json()) as any;
  assert.equal(res.status, 201, JSON.stringify(order));
  assert.equal(Number(order.deliveryFee), 4.25, "the zone's own fee, not the flat shop_settings fee (0)");
  assert.equal(Number(order.totalAmount), 10 + 4.25);
  assert.equal(order.deliveryZoneId, zone!.id);
});

test("an inactive or unknown deliveryZoneId is rejected before any stock is touched", async () => {
  const inactiveZone = await queryOne<{ id: string }>(
    `INSERT INTO shop_delivery_zones (id, name, fee, active) VALUES ($1,'Test Inactive Zone',9,false) RETURNING id`,
    [randomUUID()]
  );
  const before = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);

  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      // A different quantity than the earlier test's cart, so this can
      // never collide with its still-pending order via the dedup guard.
      items: [{ productId, quantity: 2 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
      deliveryZoneId: inactiveZone!.id,
    }),
  });
  assert.equal(res.status, 400);

  const madeUpRes = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId, quantity: 3 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
      deliveryZoneId: randomUUID(),
    }),
  });
  assert.equal(madeUpRes.status, 400);

  const after = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [productId]);
  assert.equal(after!.stock, before!.stock, "stock must not move for a rejected order");
});

test("omitting deliveryZoneId falls back to the flat shop_settings delivery fee, unchanged from before zones existed", async () => {
  await query(`UPDATE shop_settings SET delivery_fee=2 WHERE id=true`);
  const res = await asCustomer("/shop/orders", {
    method: "POST",
    body: JSON.stringify({
      // A different quantity than the earlier tests' carts, so this can
      // never collide with a still-pending order via the dedup guard.
      items: [{ productId, quantity: 4 }],
      paymentMethod: "evc",
      senderPhone: "617000111",
      deliveryName: "Test Buyer",
      deliveryPhone: "617000222",
      deliveryAddress: "Mogadishu, Somalia",
    }),
  });
  const order = (await res.json()) as any;
  assert.equal(res.status, 201, JSON.stringify(order));
  assert.equal(Number(order.deliveryFee), 2);
  assert.equal(order.deliveryZoneId, null);
});

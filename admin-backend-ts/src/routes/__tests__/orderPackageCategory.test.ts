// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers the Customer App's new Order
// History design: GET /orders and GET /orders/:id must include each
// order's package category (packages.category_id joined against
// service_categories) as packageCategory, so the "Service type" line
// (Data Bundle / Voice Bundle / ...) is real backend data, never guessed
// or fabricated client-side.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ordersRouter } from "../orders.routes.js";

const app = express();
app.use(express.json());
app.use(ordersRouter);

let server: http.Server;
let baseUrl: string;
let customerToken: string;

const CUSTOMER_ID = randomUUID();
const CUSTOMER_PHONE = "252611200777";
const COMPANY_ID = "test-order-category-co";
const CATEGORY_ID = "test-order-category-cat";
const PACKAGE_WITH_CATEGORY_ID = randomUUID();
const PACKAGE_WITHOUT_CATEGORY_ID = randomUUID();
const ORDER_WITH_CATEGORY_ID = randomUUID();
const ORDER_WITHOUT_CATEGORY_ID = randomUUID();

async function cleanup() {
  await query(`DELETE FROM orders WHERE id IN ($1,$2)`, [ORDER_WITH_CATEGORY_ID, ORDER_WITHOUT_CATEGORY_ID]);
  await query(`DELETE FROM packages WHERE id IN ($1,$2)`, [PACKAGE_WITH_CATEGORY_ID, PACKAGE_WITHOUT_CATEGORY_ID]);
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
}

before(async () => {
  await cleanup();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Order Category Test Customer')`, [CUSTOMER_ID, CUSTOMER_PHONE]);
  customerToken = signAccessToken(CUSTOMER_ID, "customer");

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Order Category Co',1,'#16A34A')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data Bundle')`, [randomUUID(), COMPANY_ID]);

  await query(
    `INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,'data','1GB Data',1.00)`,
    [PACKAGE_WITH_CATEGORY_ID, COMPANY_ID]
  );
  // No matching service_categories row for this slug -- proves a package
  // whose category was renamed/removed still returns the order, with
  // packageCategory simply null, never a crash or a dropped order.
  await query(
    `INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,'no-such-category','Mystery Package',2.00)`,
    [PACKAGE_WITHOUT_CATEGORY_ID, COMPANY_ID]
  );

  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status) VALUES ($1,$2,$3,$4,1.00,'completed')`,
    [ORDER_WITH_CATEGORY_ID, CUSTOMER_ID, COMPANY_ID, PACKAGE_WITH_CATEGORY_ID]
  );
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status) VALUES ($1,$2,$3,$4,2.00,'completed')`,
    [ORDER_WITHOUT_CATEGORY_ID, CUSTOMER_ID, COMPANY_ID, PACKAGE_WITHOUT_CATEGORY_ID]
  );

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("GET /orders includes the real packageCategory for a package with a matching category", async () => {
  const res = await fetch(`${baseUrl}/orders`, { headers: { Authorization: `Bearer ${customerToken}` } });
  assert.equal(res.status, 200);
  const orders = (await res.json()) as any[];
  const order = orders.find((o) => o.id === ORDER_WITH_CATEGORY_ID);
  assert.ok(order);
  assert.equal(order.packageCategory, "Data Bundle");
});

test("GET /orders reports packageCategory:null (never dropped) when the package's category no longer matches any real category", async () => {
  const res = await fetch(`${baseUrl}/orders`, { headers: { Authorization: `Bearer ${customerToken}` } });
  assert.equal(res.status, 200);
  const orders = (await res.json()) as any[];
  const order = orders.find((o) => o.id === ORDER_WITHOUT_CATEGORY_ID);
  assert.ok(order);
  assert.equal(order.packageCategory, null);
});

test("GET /orders/:id includes the same packageCategory as the list", async () => {
  const res = await fetch(`${baseUrl}/orders/${ORDER_WITH_CATEGORY_ID}`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  assert.equal(res.status, 200);
  const order = (await res.json()) as any;
  assert.equal(order.packageCategory, "Data Bundle");
});

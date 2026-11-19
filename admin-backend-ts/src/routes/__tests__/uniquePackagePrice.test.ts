// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/uniquePackagePrice.test.ts
//
// Every active service of a company has its own price, so a payment's amount
// always identifies one service (no agent has to pick between same-price
// services). A clash moves the later service one cent up at a time; what
// the customer pays includes the cent, while the amount sent to the carrier
// (provider amount) stays the price as entered.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { companiesRouter, packagesRouter } from "../companies.routes.js";
import { ordersRouter } from "../orders.routes.js";

const app = express();
app.use(express.json());
app.use(companiesRouter);
app.use(packagesRouter);
app.use(ordersRouter);

let server: http.Server;
let base: string;
const CO = "test-unique-price-co";
const CAT = "uniq-cat";
const admin = signAccessToken(randomUUID(), "super_admin");

function call(method: string, p: string, body?: unknown, token = admin) {
  return fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));
}
const create = (name: string, price: number, extra: Record<string, unknown> = {}) =>
  call("POST", "/admin/packages", { companyId: CO, categoryId: CAT, name, price, ...extra });
const row = (id: string) => queryOne<any>(`SELECT price, provider_amount, active FROM packages WHERE id=$1`, [id]);

before(async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, status) VALUES ($1,'Unique Co',1,'#123456','online')`, [CO]);
  await query(`INSERT INTO service_categories (company_id, slug, name) VALUES ($1,$2,'Uniq')`, [CO, CAT]);
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("a new service with a price already taken gets the next free cent; the carrier amount stays as entered", async () => {
  const wifi = await create("Wi-Fi", 5);
  assert.equal(wifi.status, 201, JSON.stringify(wifi.body));
  assert.equal(Number(wifi.body.price), 5);
  assert.equal(wifi.body.priceAdjustedFrom, undefined);

  const calls = await create("Calls", 5);
  assert.equal(Number(calls.body.price), 5.01);
  assert.equal(calls.body.priceAdjustedFrom, 5, "the admin is told the price was moved");
  assert.equal(Number((await row(calls.body.id)).provider_amount), 5, "carrier still gets $5.00");

  const wireless = await create("Wireless", 5, { providerAmount: 4.5 });
  assert.equal(Number(wireless.body.price), 5.02);
  assert.equal(Number((await row(wireless.body.id)).provider_amount), 4.5, "an own provider amount is kept");

  const other = await create("Other", 5);
  assert.equal(Number(other.body.price), 5.03);
});

test("editing a service onto a taken price moves it to the next free cent; its own price is never a clash", async () => {
  const a = await create("Edit A", 7);
  const b = await create("Edit B", 8);
  const same = await call("PUT", `/admin/packages/${a.body.id}`, { name: "Edit A renamed" });
  assert.equal(Number(same.body.price), 7, "unchanged price stays");
  const clash = await call("PUT", `/admin/packages/${b.body.id}`, { price: 7 });
  assert.equal(clash.status, 200, JSON.stringify(clash.body));
  assert.equal(Number(clash.body.price), 7.01);
  assert.equal(clash.body.priceAdjustedFrom, 7);
});

test("an inactive service may share a price; turning it on moves it", async () => {
  const off = await create("Off", 9, { active: false });
  await create("On", 9);
  assert.equal(Number((await row(off.body.id)).price), 9);
  const on = await call("PUT", `/admin/packages/${off.body.id}`, { active: true });
  assert.equal(Number(on.body.price), 9.01);
});

test("order amount = the final price; the USSD carrier amount = the price as entered", async () => {
  const pkg = await create("Order pkg", 3);
  const moved = await create("Order pkg 2", 3); // -> 3.01
  const cust = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'615550880')`, [cust]);
  const r = await call(
    "POST",
    "/orders",
    { companyId: CO, packageId: moved.body.id, senderPhone: "615550880", receiverPhone: "615550880", clientRequestId: randomUUID() },
    signAccessToken(cust, "customer")
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = await queryOne<any>(`SELECT amount, provider_amount FROM orders WHERE id=$1`, [r.body.id]);
  assert.equal(Number(o.amount), 3.01, "the customer pays the unique price");
  assert.equal(Number(o.provider_amount), 3, "the carrier is sent the original amount");
  assert.ok(pkg.body.id);
});

test("the one-time fix: the oldest keeps its price, later duplicates move one cent at a time, skipping taken prices", async () => {
  const CO2 = "test-unique-price-co2";
  await query(`INSERT INTO companies (id, name, group_number, color_hex, status) VALUES ($1,'Legacy Co',1,'#123456','online')`, [CO2]);
  const ins = async (name: string, price: number, ageMin: number, provider: number | null = null) => {
    const id = randomUUID();
    await query(
      `INSERT INTO packages (id, company_id, category_id, name, price, provider_amount, created_at) VALUES ($1,$2,'x',$3,$4,$5, now() - ($6 || ' minutes')::interval)`,
      [id, CO2, name, price, provider, String(ageMin)]
    );
    return id;
  };
  const first = await ins("First 5", 5, 50);
  const second = await ins("Second 5", 5, 40);
  const taken = await ins("Already 5.01", 5.01, 30);
  const third = await ins("Third 5", 5, 20, 4.8);
  const lone = await ins("Lone 2", 2, 10);

  const sql = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations", process.env.UNIQUE_PRICE_MIGRATION ?? "132_unique_package_prices.sql"), "utf8");
  await query(sql);

  assert.equal(Number((await row(first)).price), 5, "oldest keeps its price");
  assert.equal(Number((await row(taken)).price), 5.01, "a non-duplicate is never moved");
  assert.equal(Number((await row(second)).price), 5.02, "skips 5.01, which another service has");
  assert.equal(Number((await row(second)).provider_amount), 5, "carrier amount stays the original");
  assert.equal(Number((await row(third)).price), 5.03);
  assert.equal(Number((await row(third)).provider_amount), 4.8, "own provider amount kept");
  assert.equal(Number((await row(lone)).price), 2);
  const logs = await query(`SELECT 1 FROM admin_activity_log WHERE action='package_price_made_unique' AND entity_id = ANY($1)`, [[second, third]]);
  assert.equal(logs.length, 2, "each change is in the Activity Log");
  // Running it again changes nothing.
  await query(sql);
  assert.equal(Number((await row(second)).price), 5.02);
});

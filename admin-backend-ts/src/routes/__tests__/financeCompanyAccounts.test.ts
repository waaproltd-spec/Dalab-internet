// Run against a real local Postgres test database:
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/financeCompanyAccounts.test.ts
//
// Shirkadda Xisaab (GET /admin/finance/company-accounts): per-company money
// for a period -- company money (provider cost), sales, discount off the
// list price, commission and profit -- counting only completed,
// non-reversed orders, with a per-category breakdown and an order list.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { financeRouter } from "../finance.routes.js";

const app = express();
app.use(express.json());
app.use(financeRouter);
let server: http.Server;
let baseUrl: string;
let staffToken: string;

const HORMUUD = "test-acct-hormuud";
const SOMNET = "test-acct-somnet";
const CUSTOMER = randomUUID();
const PKG_INTERNET = randomUUID();
const PKG_VOICE = randomUUID();
const PKG_SOMNET = randomUUID();
let n = 0;

async function order(params: {
  company: string;
  pkg: string;
  amount: number;
  provider: number | null;
  list: number;
  status?: string;
  reversed?: boolean;
  createdAt?: string;
}) {
  const id = `ACCT${++n}`;
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, list_price, status, sender_phone, receiver_phone, created_at, reversed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'252610000001','252610000002',$9,$10)`,
    [
      id, CUSTOMER, params.company, params.pkg, params.amount, params.provider, params.list, params.status ?? "completed",
      params.createdAt ?? new Date().toISOString(), params.reversed ? new Date().toISOString() : null,
    ]
  );
  return id;
}

async function getJson(path: string, token = staffToken) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  await query(`DELETE FROM commission_records WHERE company_id IN ($1,$2)`, [HORMUUD, SOMNET]);
  await query(`DELETE FROM orders WHERE company_id IN ($1,$2)`, [HORMUUD, SOMNET]);
  await query(`DELETE FROM packages WHERE company_id IN ($1,$2)`, [HORMUUD, SOMNET]);
  await query(`DELETE FROM service_categories WHERE company_id IN ($1,$2)`, [HORMUUD, SOMNET]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2)`, [HORMUUD, SOMNET]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex, sort_order) VALUES ($1,'Hormuud',1,'#1BA14B',-2),($2,'Somnet',1,'#1E5BD8',-1)`, [HORMUUD, SOMNET]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252619990077') ON CONFLICT DO NOTHING`, [CUSTOMER]);
  await query(
    `INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$3,'internet','Internet'),($2,$3,'voice','Voice'),($4,$5,'internet','Internet')`,
    [randomUUID(), randomUUID(), HORMUUD, randomUUID(), SOMNET]
  );
  await query(
    `INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$4,'internet','Internet 1 Day 1GB',0.7,1024),($2,$4,'voice','Voice 1 Day',1.8,0),($3,$5,'internet','Somnet 1GB',1,1024)`,
    [PKG_INTERNET, PKG_VOICE, PKG_SOMNET, HORMUUD, SOMNET]
  );

  // Hormuud, today: two completed internet orders, one completed voice order,
  // plus a pending, a failed and a reversed order that must not count as money.
  const a = await order({ company: HORMUUD, pkg: PKG_INTERNET, amount: 0.7, provider: 1, list: 1 });
  await order({ company: HORMUUD, pkg: PKG_INTERNET, amount: 4.5, provider: 5, list: 5 });
  await order({ company: HORMUUD, pkg: PKG_VOICE, amount: 1.8, provider: null, list: 2 });
  await order({ company: HORMUUD, pkg: PKG_INTERNET, amount: 9, provider: 10, list: 10, status: "pending" });
  await order({ company: HORMUUD, pkg: PKG_INTERNET, amount: 9, provider: 10, list: 10, status: "failed" });
  await order({ company: HORMUUD, pkg: PKG_INTERNET, amount: 9, provider: 10, list: 10, reversed: true });
  // Last month: outside "today".
  await order({ company: HORMUUD, pkg: PKG_INTERNET, amount: 50, provider: 60, list: 60, createdAt: new Date(Date.now() - 40 * 86400_000).toISOString() });
  // Somnet, today.
  await order({ company: SOMNET, pkg: PKG_SOMNET, amount: 1, provider: 1, list: 1 });

  await query(
    `INSERT INTO commission_records (order_id, company_id, package_id, order_amount, rule_type, rule_value, commission_amount, kind)
     VALUES ($1,$2,$3,0.7,'fixed',0.05,0.05,'earned')`,
    [a, HORMUUD, PKG_INTERNET]
  );

  staffToken = signAccessToken(randomUUID(), "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function today() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`;
}

test("company money, sales, discount, commission and profit count only completed, non-reversed orders in the period", async () => {
  const { status, body } = await getJson(`/admin/finance/company-accounts?${today()}&companyId=${HORMUUD}`);
  assert.equal(status, 200);
  const h = body.company;
  assert.equal(h.id, HORMUUD);
  assert.equal(h.orders, 3);
  assert.equal(h.companyAmount, 7.8, "1 + 5 + 1.8 (no provider cost -> what the customer paid)");
  assert.equal(h.saleAmount, 7);
  assert.equal(h.discount, 1, "0.3 + 0.5 + 0.2 off the list price");
  assert.equal(h.commission, 0.05);
  assert.equal(h.profit, -0.75, "7 - 7.8 + 0.05");
  assert.equal(h.profitPercent, -9.62);

  const somnet = body.companies.find((c: any) => c.id === SOMNET);
  assert.equal(somnet.orders, 1);
  assert.equal(somnet.profit, 0);
});

test("the category breakdown adds up to the company totals", async () => {
  const { body } = await getJson(`/admin/finance/company-accounts?${today()}&companyId=${HORMUUD}`);
  const byName = Object.fromEntries(body.categories.map((c: any) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ["Internet", "Voice"]);
  assert.equal(byName.Internet.orders, 2);
  assert.equal(byName.Internet.companyAmount, 6);
  assert.equal(byName.Voice.saleAmount, 1.8);
  const sum = body.categories.reduce((s: number, c: any) => s + c.profit, 0);
  assert.equal(Number(sum.toFixed(2)), body.company.profit);
});

test("the order list shows every status, can be filtered and searched, and marks reversed orders", async () => {
  const all = await getJson(`/admin/finance/company-accounts?${today()}&companyId=${HORMUUD}`);
  assert.equal(all.body.totalOrders, 6);
  assert.ok(all.body.orders.some((o: any) => o.status === "reversed"));
  const first = all.body.orders.find((o: any) => o.saleAmount === 0.7);
  assert.equal(first.commission, 0.05);
  assert.equal(first.profit, -0.25);
  assert.equal(first.category, "Internet");

  const completed = await getJson(`/admin/finance/company-accounts?${today()}&companyId=${HORMUUD}&status=completed`);
  assert.equal(completed.body.totalOrders, 4, "includes the reversed one, which is still status completed");

  const search = await getJson(`/admin/finance/company-accounts?${today()}&companyId=${HORMUUD}&q=voice`);
  assert.equal(search.body.totalOrders, 1);
  assert.equal(search.body.orders[0].packageName, "Voice 1 Day");
});

test("a wider period includes older orders; no period means all time", async () => {
  const start = new Date(Date.now() - 60 * 86400_000).toISOString();
  const { body } = await getJson(`/admin/finance/company-accounts?from=${encodeURIComponent(start)}&companyId=${HORMUUD}`);
  assert.equal(body.company.orders, 4);
  assert.equal(body.company.saleAmount, 57);
  const allTime = await getJson(`/admin/finance/company-accounts?companyId=${HORMUUD}`);
  assert.equal(allTime.body.company.orders, 4);
});

test("only staff can see the accounts", async () => {
  const res = await getJson(`/admin/finance/company-accounts`, signAccessToken(randomUUID(), "agent"));
  assert.equal(res.status, 403);
});

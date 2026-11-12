// Run against a dedicated, freshly migrated local Postgres test database
// (stats are global, so other suites' rows would change the totals):
//   DATABASE_URL=postgres://dalab:dalab@127.0.0.1:5432/<db> PGSSL=false JWT_SECRET=... \
//     npx tsx --test src/routes/__tests__/dashboardStats.test.ts
//
// Overview's cards and charts come from real orders (completed, never
// reversed, Somalia time), and deleting a company leaves an activity-log
// entry with what it was before, so a mistaken delete can be undone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ordersRouter } from "../orders.routes.js";
import { companiesRouter } from "../companies.routes.js";

const app = express();
app.use(express.json());
app.use(ordersRouter);
app.use(companiesRouter);
let server: http.Server;
let baseUrl: string;
let token: string;
const ADMIN_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const CO_A = "dash-co-a";
const CO_B = "dash-co-b";
let pkgA: string;
let pkgB: string;
let n = 0;

async function order(companyId: string, packageId: string, amount: number, status: string, opts: { daysAgo?: number; provider?: number; reversed?: boolean } = {}) {
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, created_at, reversed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' days')::interval, $9)`,
    [`DLBDASH${++n}`, CUSTOMER_ID, companyId, packageId, amount, opts.provider ?? null, status, String(opts.daysAgo ?? 0), opts.reversed ? new Date() : null]
  );
}

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'dash-stats@example.com','x','super_admin')`, [ADMIN_ID]);
  token = signAccessToken(ADMIN_ID, "super_admin");
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252699000555')`, [CUSTOMER_ID]);
  for (const [id, name, sort] of [[CO_A, "Dash A", 1], [CO_B, "Dash B", 2]] as const) {
    await query(`INSERT INTO companies (id, name, group_number, color_hex, sort_order, status, visible_customer_app, visible_agent_app) VALUES ($1,$2,2,'#123456',$3,'online',true,false)`, [id, name, sort]);
  }
  const catA = randomUUID();
  const catB = randomUUID();
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data'),($3,$4,'data','Data')`, [catA, CO_A, catB, CO_B]);
  pkgA = (await queryOne<{ id: string }>(`INSERT INTO packages (company_id, category_id, name, price) VALUES ($1,$2,'A pkg',1) RETURNING id`, [CO_A, catA]))!.id;
  pkgB = (await queryOne<{ id: string }>(`INSERT INTO packages (company_id, category_id, name, price) VALUES ($1,$2,'B pkg',1) RETURNING id`, [CO_B, catB]))!.id;

  await order(CO_A, pkgA, 2, "completed", { provider: 1.5 });              // today
  await order(CO_A, pkgA, 3, "completed", { daysAgo: 3, provider: 2.5 });  // this week
  await order(CO_B, pkgB, 10, "completed", { daysAgo: 40 });               // older than a month
  await order(CO_B, pkgB, 7, "completed", { reversed: true });             // reversed: never counts
  await order(CO_B, pkgB, 4, "failed");
  await order(CO_A, pkgA, 5, "pending");
  await query(`INSERT INTO finance_expenses (amount, category, note) VALUES (0.75, 'other', 'test expense')`);

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

const get = (p: string) => fetch(`${baseUrl}${p}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json() as any);

test("dashboard stats are real: completed, non-reversed orders by period, profit, last 7 days and per company", async () => {
  const s = await get("/admin/dashboard/stats");
  assert.equal(s.totalSales, 15, "2 + 3 + 10; the reversed 7 never counts");
  assert.equal(s.dailySales, 2);
  assert.equal(s.weeklySales, 5);
  // 3-days-ago may fall in last month at the start of a month; 40 days ago never does.
  assert.ok(s.monthlySales === 5 || s.monthlySales === 2, `monthly ${s.monthlySales}`);
  assert.ok(s.yearlySales >= 2 && s.yearlySales <= 15);
  assert.equal(Number(s.profit.toFixed(2)), Number((15 - 4 - 0.75).toFixed(2)), "received - data cost - expenses");
  assert.equal(s.successfulOrders, 4);
  assert.equal(s.failedOrders, 1);
  assert.equal(s.pendingOrders, 1);
  assert.equal(s.salesLast7Days.length, 7);
  assert.equal(s.salesLast7Days[6].sales, 2, "today is last");
  assert.equal(s.salesLast7Days.reduce((t: number, d: any) => t + d.sales, 0), 5);
  const byCo = Object.fromEntries(s.completedOrdersByCompany.map((c: any) => [c.companyId, c.orders]));
  assert.equal(byCo[CO_A], 2);
  assert.equal(byCo[CO_B], 1, "the reversed order isn't counted");
});

test("deleting a company is recorded with who did it and what it was, and it leaves the per-company chart", async () => {
  const res = await fetch(`${baseUrl}/admin/companies/${CO_B}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const log = await queryOne<{ admin_id: string; old_value: any }>(
    `SELECT admin_id, old_value FROM admin_activity_log WHERE action='delete_company' AND entity_id=$1`,
    [CO_B]
  );
  assert.equal(log?.admin_id, ADMIN_ID);
  assert.equal(log?.old_value?.name, "Dash B");
  assert.equal(log?.old_value?.status, "online", "soft delete keeps the old status for restoring");
  assert.equal(log?.old_value?.visibleCustomerApp, true);
  const s = await get("/admin/dashboard/stats");
  assert.ok(!s.completedOrdersByCompany.some((c: any) => c.companyId === CO_B));
});

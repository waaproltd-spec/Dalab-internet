// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test --test-force-exit src/routes/__tests__/agentReportsDashboard.test.ts
//
// The Agent App Reports dashboard: every total, percentage, per-company
// figure, discount and profit is computed from real orders -- this agent's
// only, each company from its own orders, and the money model
// (cost x send count, list price saved on the order) checked by hand.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { reportsRouter } from "../reports.routes.js";

const AGENT_ID = randomUUID();
const OTHER_AGENT_ID = randomUUID();
let CUSTOMER_ID: string;
let agentToken: string;
let server: http.Server;
let baseUrl: string;
const pkgs: Record<string, string> = {};

const app = express();
app.use(express.json());
app.use(reportsRouter);

async function order(pkg: string, company: string, amount: number, status: string, opts: { agent?: string; ageDays?: number; reversed?: boolean } = {}) {
  const id = "TESTRPT" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, agent_id, created_at, reversed_at)
     VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(provider_amount, price) FROM packages WHERE id=$4),$6,$7, now() - ($8 || ' days')::interval, $9)`,
    [id, CUSTOMER_ID, company, pkgs[pkg], amount, status, opts.agent ?? AGENT_ID, String(opts.ageDays ?? 0), opts.reversed ? new Date() : null]
  );
}

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${agentToken}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as any;
}

before(async () => {
  for (const [id, name, sort] of [["rpt-hormuud", "Hormuud", 1], ["rpt-somtel", "Somtel", 2], ["rpt-amtel", "Amtel", 3]] as const) {
    await query(`INSERT INTO companies (id, name, group_number, color_hex, sort_order) VALUES ($1,$2,1,'#000000',$3)`, [id, name, sort]);
  }
  const addPkg = async (key: string, company: string, price: number, oldPrice: number | null, provider: number | null, sendCount = 1) => {
    pkgs[key] = (await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, old_price, provider_amount, send_count)
       VALUES (gen_random_uuid(),$1,'data',$2,$3,$4,$5,$6) RETURNING id`,
      [company, key, price, oldPrice, provider, sendCount]
    ))!.id;
  };
  // The user's worked example: cost 100, selling 117, final 107.
  await addPkg("home5g", "rpt-hormuud", 107, 117, 100);
  await addPkg("daily", "rpt-hormuud", 1, null, 0.8); // no old price: no discount
  await addPkg("extra", "rpt-somtel", 2, 2.5, 0.5, 3); // Extra Package: 3 sends
  CUSTOMER_ID = (await queryOne<{ id: string }>(`INSERT INTO customers (id, phone) VALUES (gen_random_uuid(),'252619990001') RETURNING id`))!.id;
  for (const id of [AGENT_ID, OTHER_AGENT_ID]) {
    await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Agent','x')`, [id, `25269900${Math.floor(1000 + Math.random() * 8999)}`]);
  }

  // This agent, today.
  await order("home5g", "rpt-hormuud", 107, "completed");
  await order("home5g", "rpt-hormuud", 107, "completed");
  await order("daily", "rpt-hormuud", 1, "completed");
  await order("daily", "rpt-hormuud", 1, "failed");
  await order("extra", "rpt-somtel", 2, "completed");
  await order("extra", "rpt-somtel", 2, "cancelled");
  await order("extra", "rpt-somtel", 2, "in_progress"); // in flight: not counted
  await order("home5g", "rpt-hormuud", 107, "cancelled", { reversed: true }); // reversed: cancelled, no money
  // This agent, 20 days ago (only in 30days / all).
  await order("daily", "rpt-hormuud", 1, "completed", { ageDays: 20 });
  // Another agent: never in this agent's report.
  await order("home5g", "rpt-hormuud", 107, "completed", { agent: OTHER_AGENT_ID });

  agentToken = signAccessToken(AGENT_ID, "agent");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("orders remember their package's original price when created", async () => {
  const row = await queryOne<{ list_price: string }>(`SELECT list_price FROM orders WHERE package_id=$1 LIMIT 1`, [pkgs.home5g]);
  assert.equal(Number(row?.list_price), 117);
  const daily = await queryOne<{ list_price: string }>(`SELECT list_price FROM orders WHERE package_id=$1 LIMIT 1`, [pkgs.daily]);
  assert.equal(Number(daily?.list_price), 1, "no old price: list price is the price");
});

test("today's summary, status split and profit breakdown are exact", async () => {
  const r = await get("/agent/reports/dashboard?range=today");
  // Sent: 107 + 107 + 1 + 2 = 4 orders; failed 1; cancelled 2 (incl. reversed).
  assert.equal(r.status.sent, 4);
  assert.equal(r.status.failed, 1);
  assert.equal(r.status.cancelled, 2);
  assert.equal(r.totalOrders, 7);
  assert.equal(r.status.sentPercent, 57.1);
  assert.equal(r.status.failedPercent, 14.3);
  assert.equal(r.status.cancelledPercent, 28.6);
  assert.equal(r.successfulValue, 217);
  // Cost: 100 + 100 + 0.8 + (0.5 x 3) = 202.3
  assert.equal(r.profitBreakdown.companyCost, 202.3);
  // Selling: 117 + 117 + 1 + 2.5 = 237.5; discount 10 + 10 + 0 + 0.5 = 20.5
  assert.equal(r.profitBreakdown.sellingPrice, 237.5);
  assert.equal(r.totalDiscount, 20.5);
  assert.equal(r.profitBreakdown.markup, 35.2);
  assert.equal(r.profitBreakdown.finalPrice, 217);
  assert.equal(r.totalProfit, 14.7);
  assert.equal(r.profitBreakdown.actualProfit, 14.7);
});

test("each company is calculated from its own orders only", async () => {
  const r = await get("/agent/reports/dashboard?range=today");
  const by = Object.fromEntries(r.companies.map((c: any) => [c.companyId, c]));
  assert.deepEqual(
    [by["rpt-hormuud"].totalOrders, by["rpt-hormuud"].successfulValue, by["rpt-hormuud"].totalProfit, by["rpt-hormuud"].totalDiscount],
    [5, 215, 14.2, 20]
  );
  assert.deepEqual(
    [by["rpt-somtel"].totalOrders, by["rpt-somtel"].successfulValue, by["rpt-somtel"].totalProfit, by["rpt-somtel"].totalDiscount],
    [2, 2, 0.5, 0.5]
  );
  assert.equal(by["rpt-amtel"].totalOrders, 0, "a company with no orders still appears");
  assert.equal(by["rpt-hormuud"].sharePercent, 71.4);
});

test("the date filter includes older orders only in longer ranges", async () => {
  assert.equal((await get("/agent/reports/dashboard?range=7days")).status.sent, 4);
  assert.equal((await get("/agent/reports/dashboard?range=30days")).status.sent, 5);
  assert.equal((await get("/agent/reports/dashboard?range=all")).status.sent, 5);
  assert.equal((await get("/agent/reports/dashboard?range=bogus")).range, "all");
});

test("a company report lists its packages and a worked price example", async () => {
  const r = await get("/agent/reports/dashboard/companies/rpt-hormuud?range=today");
  assert.equal(r.company.companyName, "Hormuud");
  assert.equal(r.totalOrders, 5);
  const home = r.packages.find((p: any) => p.name === "home5g");
  assert.deepEqual([home.totalOrders, home.successfulValue, home.totalProfit, home.totalDiscount], [3, 214, 14, 20]);
  assert.deepEqual(r.priceExample, {
    packageName: "home5g",
    validity: null,
    companyCost: 100,
    markup: 17,
    sellingPrice: 117,
    discount: 10,
    finalPrice: 107,
    actualProfit: 7,
  });
});

// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/companyProfit.test.ts
//
// Company Commission & Profit (Agent App only): per network Commission %
// and Discount %; Profit % = Commission % - Discount %; only completed
// orders count; agents need the Owner-granted "profit" service; orders and
// payments are only read, never changed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { agentServiceGate } from "../../auth/access.js";
import { companyProfitRouter } from "../companyProfit.routes.js";

const AGENT = randomUUID();
const PLAIN = randomUUID();
const app = express();
app.use(express.json());
app.use(agentServiceGate);
app.use(companyProfitRouter);
let server: http.Server;
let base: string;
const agent = signAccessToken(AGENT, "agent");
const plain = signAccessToken(PLAIN, "agent");
let company = "";
let pkg = "";
let customer = "";

const call = (method: string, path: string, body?: unknown, token = agent) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));
const put = (b: Record<string, unknown>) => call("PUT", `/agent/company-profit/${company}`, b);
async function overview(period = "month") {
  const r = await call("GET", `/agent/company-profit?period=${period}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const row = async (period = "month") => (await overview(period)).companies.find((c: any) => c.companyId === company);
async function order(amount: number, status: string) {
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ["CP" + randomUUID().slice(0, 10), customer, company, pkg, amount, status, status === "completed" ? new Date() : null]
  );
}
const r2 = (n: number) => Math.round(n * 100) / 100;

before(async () => {
  let p = await queryOne<any>(`SELECT id, company_id FROM packages ORDER BY id LIMIT 1`);
  if (!p) {
    // An empty test database: a network and a package of its own.
    const co = "profit-test-" + randomUUID().slice(0, 8);
    await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Profit Test Co',1,'#123456')`, [co]);
    p = await queryOne<any>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,'test','Profit Test Package',1.00) RETURNING id, company_id`,
      [randomUUID(), co]
    );
  }
  pkg = p.id;
  company = p.company_id;
  customer = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252619990777')`, [customer]);
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, services) VALUES ($1,'252699000977','Profit Agent','x',ARRAY['profit']),($2,'252699000978','Plain Agent','x',ARRAY[]::text[])`,
    [AGENT, PLAIN]
  );
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test("Hormuud 15% - 10% = 5%: a $1 order gives $0.15 commission, $0.10 discount, $0.05 profit", async () => {
  const saved = await put({ commissionPct: 15, discountPct: 10 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.commissionPct, saved.body.discountPct, saved.body.profitPct], [15, 10, 5]);

  const before0 = await row();
  await order(1, "completed");
  const one = await row();
  assert.equal(one.orders - before0.orders, 1);
  assert.equal(r2(one.commission - before0.commission), 0.15);
  assert.equal(r2(one.discount - before0.discount), 0.1);
  assert.equal(r2(one.profit - before0.profit), 0.05);
  assert.equal(one.profit, r2(one.commission - one.discount));
});

test("only successful orders count: pending, failed and cancelled are left out", async () => {
  const before0 = await row();
  await order(100, "completed");
  await order(50, "failed");
  await order(20, "pending");
  await order(30, "cancelled");
  const after = await row();
  assert.equal(after.orders - before0.orders, 1);
  assert.equal(r2(after.sales - before0.sales), 100);
  assert.equal(r2(after.commission - before0.commission), 15);
  assert.equal(r2(after.discount - before0.discount), 10);
  assert.equal(r2(after.profit - before0.profit), 5);
  // The report totals add up across networks.
  const all = await overview();
  const sum = (k: string) => r2(all.companies.reduce((a: number, c: any) => a + c[k], 0));
  assert.deepEqual(
    [all.totals.orders, all.totals.commission, all.totals.discount, all.totals.profit],
    [all.companies.reduce((a: number, c: any) => a + c.orders, 0), sum("commission"), sum("discount"), sum("profit")]
  );
});

test("profit follows the rule: setting Profit works out the Discount, and a mismatch is refused", async () => {
  const byProfit = await put({ commissionPct: 20, profitPct: 5 });
  assert.equal(byProfit.status, 200, JSON.stringify(byProfit.body));
  assert.deepEqual([byProfit.body.commissionPct, byProfit.body.discountPct, byProfit.body.profitPct], [20, 15, 5]);
  assert.equal((await put({ commissionPct: 20, discountPct: 10, profitPct: 5 })).body.code, "profit_mismatch");
  assert.equal((await put({ commissionPct: 5, discountPct: 10 })).body.code, "discount_exceeds_commission");
  assert.equal((await put({ commissionPct: 120 })).body.code, "invalid_percent");
  assert.equal((await put({ commissionPct: "abc" })).body.code, "invalid_percent");
  assert.equal((await put({ discountPct: 10 })).body.code, "commission_required");
  assert.equal((await call("PUT", `/agent/company-profit/no-such-network`, { commissionPct: 5 })).status, 404);
  const commas = await put({ commissionPct: "16", discountPct: "10,5" });
  assert.deepEqual([commas.body.commissionPct, commas.body.discountPct, commas.body.profitPct], [16, 10.5, 5.5]);
  const cleared = await put({ commissionPct: "" });
  assert.equal(cleared.body.configured, false);
  assert.equal(cleared.body.profit, 0);
});

test("only agents the Owner gave the service may see or change it; changes are recorded", async () => {
  const denied = await call("GET", `/agent/company-profit`, undefined, plain);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "service_not_allowed");
  assert.equal((await call("PUT", `/agent/company-profit/${company}`, { commissionPct: 15 }, plain)).status, 403);
  assert.equal((await put({ commissionPct: 15, discountPct: 10 })).status, 200);
  const audit = await queryOne<any>(`SELECT updated_by_id, updated_by_role FROM company_profit_terms WHERE company_id=$1`, [company]);
  assert.deepEqual([audit.updated_by_id, audit.updated_by_role], [AGENT, "agent"]);
});

test("orders are only read: no order or payment changes", async () => {
  const snap = async () => queryOne<any>(`SELECT count(*)::int AS n, coalesce(sum(amount),0)::float AS s, max(status) AS m FROM orders`);
  const pay = async () => queryOne<any>(`SELECT count(*)::int AS n FROM payment_transactions`);
  const [o1, p1] = [await snap(), await pay()];
  await overview("all");
  await put({ commissionPct: 15, discountPct: 10 });
  assert.deepEqual(await snap(), o1);
  assert.deepEqual(await pay(), p1);
});

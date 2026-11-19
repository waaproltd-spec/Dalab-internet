// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/companyProfit.test.ts
//
// Company Commission & Profit: per network Commission %, Discount % and
// Profit %; only completed orders count; net commission = price x
// (commission - discount), profit = price x profit; agents need the
// Owner-granted "profit" service.
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
const app = express();
app.use(express.json());
app.use(agentServiceGate);
app.use(companyProfitRouter);
let server: http.Server;
let base: string;
const owner = signAccessToken(randomUUID(), "super_admin");
const agent = signAccessToken(AGENT, "agent");
let company = "";
let pkg = "";
let customer = "";

const call = (method: string, path: string, body?: unknown, token = owner) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));
const row = async (period = "month", token = owner) => {
  const r = await call("GET", `/${token === owner ? "admin" : "agent"}/company-profit?period=${period}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.companies.find((c: any) => c.companyId === company);
};
async function order(amount: number, status: string) {
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ["CP" + randomUUID().slice(0, 10), customer, company, pkg, amount, status, status === "completed" ? new Date() : null]
  );
}

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
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699000977','Profit Agent','x')`, [AGENT]);
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test("only successful orders count: $1 at 15% / 10% / 5% earns $0.05 + $0.05", async () => {
  const before = await row();
  assert.equal(before.configured, false);
  const saved = await call("PUT", `/admin/company-profit/${company}`, { commissionPct: 15, discountPct: 10, profitPct: 5 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.commissionPct, saved.body.discountPct, saved.body.profitPct, saved.body.netCommissionPct], [15, 10, 5, 5]);

  const base0 = await row();
  await order(1, "completed");
  await order(100, "completed");
  await order(50, "failed");
  await order(20, "pending");
  const after = await row();
  assert.equal(after.orders - base0.orders, 2, "failed and pending orders are not counted");
  const sales = after.sales - base0.sales;
  assert.equal(Math.round(sales * 100) / 100, 101);
  // 5% net commission and 5% profit of the completed sales.
  assert.equal(after.netCommission, Math.round(after.sales * 5) / 100);
  assert.equal(after.profit, Math.round(after.sales * 5) / 100);
  assert.equal(after.total, Math.round((after.netCommission + after.profit) * 100) / 100);
});

test("percentages are checked; discount can't exceed commission; empty clears", async () => {
  assert.equal((await call("PUT", `/admin/company-profit/${company}`, { commissionPct: 120 })).body.code, "invalid_percent");
  assert.equal((await call("PUT", `/admin/company-profit/${company}`, { commissionPct: "abc" })).body.code, "invalid_percent");
  assert.equal((await call("PUT", `/admin/company-profit/${company}`, { commissionPct: 5, discountPct: 10 })).body.code, "discount_exceeds_commission");
  assert.equal((await call("PUT", `/admin/company-profit/no-such-network`, { commissionPct: 5 })).status, 404);
  const ok = await call("PUT", `/admin/company-profit/${company}`, { commissionPct: "16", discountPct: "", profitPct: "2.5" });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.commissionPct, ok.body.discountPct, ok.body.profitPct, ok.body.netCommissionPct], [16, null, 2.5, 16]);
  const cleared = await call("PUT", `/admin/company-profit/${company}`, { commissionPct: "", discountPct: "", profitPct: "" });
  assert.equal(cleared.body.configured, false);
  assert.equal(cleared.body.total, 0);
});

test("agents need the Owner-granted service", async () => {
  const denied = await call("GET", `/agent/company-profit`, undefined, agent);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "service_not_allowed");
  assert.equal((await call("PUT", `/agent/company-profit/${company}`, { commissionPct: 15 }, agent)).status, 403);
  await query(`UPDATE agents SET services = ARRAY['profit'] WHERE id=$1`, [AGENT]);
  const put = await call("PUT", `/agent/company-profit/${company}`, { commissionPct: 20, discountPct: 10, profitPct: 5 }, agent);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await row("today", agent)).netCommissionPct, 10);
  const audit = await queryOne<any>(`SELECT updated_by_role FROM company_profit_terms WHERE company_id=$1`, [company]);
  assert.equal(audit.updated_by_role, "agent");
});

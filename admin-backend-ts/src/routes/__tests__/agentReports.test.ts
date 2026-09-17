// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers GET /agent/reports -- the Agent App's
// "My Reports" screen: period-scoped totals (sales/orders/customers),
// per-company ranking (always the 4 fixed companies, ascending by sales,
// #1 = highest), and the top-5-customers leaderboard, all scoped to
// completed orders this specific agent fulfilled.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { reportsRouter } from "../reports.routes.js";

const app = express();
app.use(express.json());
app.use(reportsRouter);

let server: http.Server;
let baseUrl: string;
let agentToken: string;

const AGENT_ID = randomUUID();
const AGENT_PHONE = "617400501";
const OTHER_AGENT_ID = randomUUID();
const OTHER_AGENT_PHONE = "617400502";
const CUSTOMER_A_ID = randomUUID();
const CUSTOMER_A_PHONE = "617400601";
const CUSTOMER_B_ID = randomUUID();
const CUSTOMER_B_PHONE = "617400602";
const COMPANY_IDS = ["hormuud", "somnet", "somtel", "amtel"];
const PACKAGE_IDS: Record<string, string> = {};

async function cleanupOrders() {
  await query(`DELETE FROM orders WHERE agent_id IN ($1,$2)`, [AGENT_ID, OTHER_AGENT_ID]);
}

before(async () => {
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Agent Reports Test Agent','x')`, [AGENT_ID, AGENT_PHONE]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Agent Reports Other Agent','x')`, [OTHER_AGENT_ID, OTHER_AGENT_PHONE]);
  agentToken = signAccessToken(AGENT_ID, "agent");

  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Agent Reports Customer A')`, [CUSTOMER_A_ID, CUSTOMER_A_PHONE]);
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Agent Reports Customer B')`, [CUSTOMER_B_ID, CUSTOMER_B_PHONE]);

  for (const companyId of COMPANY_IDS) {
    await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,$1,1,'#000000') ON CONFLICT (id) DO NOTHING`, [companyId]);
    const pkg = await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,'test','Agent Reports Test Package',1.00) RETURNING id`,
      [randomUUID(), companyId]
    );
    PACKAGE_IDS[companyId] = pkg!.id;
  }

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanupOrders();
  await query(`DELETE FROM packages WHERE id = ANY($1::uuid[])`, [Object.values(PACKAGE_IDS)]);
  await query(`DELETE FROM customers WHERE id IN ($1,$2)`, [CUSTOMER_A_ID, CUSTOMER_B_ID]);
  await query(`DELETE FROM agents WHERE id IN ($1,$2)`, [AGENT_ID, OTHER_AGENT_ID]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(async () => {
  await cleanupOrders();
});

function authed(path: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${agentToken}` } });
}

async function asJson(res: Response): Promise<any> {
  return res.json();
}

async function insertOrder(opts: {
  agentId: string;
  companyId: string;
  customerId: string;
  amount: number;
  status?: string;
  completedAt?: string; // SQL expression, e.g. "now()" or "now() - interval '2 days'"
}) {
  const id = `TEST-${randomUUID()}`;
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, agent_id, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,${opts.completedAt ?? "NULL"})`,
    [id, opts.customerId, opts.companyId, PACKAGE_IDS[opts.companyId], opts.amount, opts.status ?? "completed", opts.agentId]
  );
  return id;
}

test("requires agent auth -- an unauthenticated request is rejected", async () => {
  const res = await fetch(`${baseUrl}/agent/reports`);
  assert.equal(res.status, 401);
});

test("with no completed orders in range, still returns all 4 fixed companies at $0/0 orders and an empty topCustomers list", async () => {
  const res = await authed("/agent/reports?range=today");
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(body.range, "today");
  assert.equal(body.periodTotals.totalSales, 0);
  assert.equal(body.periodTotals.totalOrders, 0);
  assert.equal(body.periodTotals.totalCustomers, 0);
  assert.deepEqual(
    body.companies.map((c: any) => c.companyId).sort(),
    [...COMPANY_IDS].sort()
  );
  assert.equal(body.companies.length, 4);
  assert.deepEqual(body.topCustomers, []);
});

test("defaults to range=today when no range query param is given", async () => {
  const res = await authed("/agent/reports");
  const body = await asJson(res);
  assert.equal(body.range, "today");
});

test("falls back to today for an unrecognized range value instead of erroring", async () => {
  const res = await authed("/agent/reports?range=not-a-real-range");
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(body.range, "today");
});

test("ranks the 4 companies ascending by completed sales, with rank 1 always the highest seller", async () => {
  await insertOrder({ agentId: AGENT_ID, companyId: "amtel", customerId: CUSTOMER_A_ID, amount: 3.12, completedAt: "now()" });
  await insertOrder({ agentId: AGENT_ID, companyId: "somtel", customerId: CUSTOMER_A_ID, amount: 12.50, completedAt: "now()" });
  await insertOrder({ agentId: AGENT_ID, companyId: "somnet", customerId: CUSTOMER_A_ID, amount: 18.30, completedAt: "now()" });
  await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 28.49, completedAt: "now()" });

  const res = await authed("/agent/reports?range=today");
  const body = await asJson(res);
  assert.deepEqual(
    body.companies.map((c: any) => ({ id: c.companyId, sales: c.totalSales, rank: c.rank })),
    [
      { id: "amtel", sales: 3.12, rank: 4 },
      { id: "somtel", sales: 12.5, rank: 3 },
      { id: "somnet", sales: 18.3, rank: 2 },
      { id: "hormuud", sales: 28.49, rank: 1 },
    ]
  );
});

test("ranking changes automatically when the underlying data changes -- never a fixed order", async () => {
  // Same 4 companies as the previous test, but amtel and hormuud swap places
  // (amtel now out-sells hormuud) -- the ranking must follow, not stay fixed.
  await insertOrder({ agentId: AGENT_ID, companyId: "amtel", customerId: CUSTOMER_A_ID, amount: 50, completedAt: "now()" });
  await insertOrder({ agentId: AGENT_ID, companyId: "somtel", customerId: CUSTOMER_A_ID, amount: 12.5, completedAt: "now()" });
  await insertOrder({ agentId: AGENT_ID, companyId: "somnet", customerId: CUSTOMER_A_ID, amount: 18.3, completedAt: "now()" });
  await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 5, completedAt: "now()" });

  const res = await authed("/agent/reports?range=today");
  const body = await asJson(res);
  const amtel = body.companies.find((c: any) => c.companyId === "amtel");
  const hormuud = body.companies.find((c: any) => c.companyId === "hormuud");
  assert.equal(amtel.rank, 1, "amtel out-sold everyone this time, so it must rank #1");
  assert.equal(hormuud.rank, 4, "hormuud sold the least this time, so it must rank #4");
});

test("top 5 customers are sorted by completed order count, capped at 5, with real name/phone/amount", async () => {
  for (let i = 0; i < 3; i++) {
    await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 10, completedAt: "now()" });
  }
  await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_B_ID, amount: 7, completedAt: "now()" });

  const res = await authed("/agent/reports?range=today");
  const body = await asJson(res);
  assert.equal(body.topCustomers.length, 2);
  assert.deepEqual(body.topCustomers[0], {
    rank: 1,
    customerId: CUSTOMER_A_ID,
    name: "Agent Reports Customer A",
    phone: CUSTOMER_A_PHONE,
    completedOrders: 3,
    totalSpent: 30,
  });
  assert.deepEqual(body.topCustomers[1], {
    rank: 2,
    customerId: CUSTOMER_B_ID,
    name: "Agent Reports Customer B",
    phone: CUSTOMER_B_PHONE,
    completedOrders: 1,
    totalSpent: 7,
  });
  assert.equal(body.periodTotals.totalCustomers, 2);
});

test("yesterday's orders never leak into today's totals, and vice versa", async () => {
  await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 9, completedAt: "now() - interval '1 day' - interval '1 hour'" });
  await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 4, completedAt: "now()" });

  const today = await asJson(await authed("/agent/reports?range=today"));
  const yesterday = await asJson(await authed("/agent/reports?range=yesterday"));
  assert.equal(today.periodTotals.totalSales, 4);
  assert.equal(today.periodTotals.totalOrders, 1);
  assert.equal(yesterday.periodTotals.totalSales, 9);
  assert.equal(yesterday.periodTotals.totalOrders, 1);
});

test("a completed order from 8 days ago is excluded from range=week but included in range=1month", async () => {
  await insertOrder({ agentId: AGENT_ID, companyId: "somnet", customerId: CUSTOMER_A_ID, amount: 6, completedAt: "now() - interval '8 days'" });

  const week = await asJson(await authed("/agent/reports?range=week"));
  const month = await asJson(await authed("/agent/reports?range=1month"));
  assert.equal(week.periodTotals.totalOrders, 0);
  assert.equal(month.periodTotals.totalOrders, 1);
  assert.equal(month.periodTotals.totalSales, 6);
});

test("only status='completed' orders count -- a pending order in range is excluded", async () => {
  await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 99, status: "pending", completedAt: "now()" });

  const res = await authed("/agent/reports?range=today");
  const body = await asJson(res);
  assert.equal(body.periodTotals.totalOrders, 0);
  assert.equal(body.companies.find((c: any) => c.companyId === "hormuud").totalSales, 0);
});

test("only this agent's own completed orders count -- another agent's order in range is excluded", async () => {
  await insertOrder({ agentId: OTHER_AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 40, completedAt: "now()" });
  await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 5, completedAt: "now()" });

  const res = await authed("/agent/reports?range=today");
  const body = await asJson(res);
  assert.equal(body.periodTotals.totalSales, 5);
  assert.equal(body.companies.find((c: any) => c.companyId === "hormuud").totalSales, 5);
});

test("all-time totals stay accurate even when the selected period has no completed orders", async () => {
  await insertOrder({ agentId: AGENT_ID, companyId: "hormuud", customerId: CUSTOMER_A_ID, amount: 15, completedAt: "now() - interval '2 years'" });

  const res = await authed("/agent/reports?range=today");
  const body = await asJson(res);
  assert.equal(body.periodTotals.totalOrders, 0, "nothing completed today");
  assert.equal(Number(body.totals.totalSales), 15, "all-time totals still reflect the 2-year-old order");
  assert.equal(Number(body.totals.totalOrders), 1);
});

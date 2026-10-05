// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test --test-force-exit src/routes/__tests__/agentTransactionHistory.test.ts
//
// Agent App Transaction History: this agent's orders only, Payment Number
// and Internet Destination kept separate, and the date range, company and
// search filters all applied together.
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

const AGENT_ID = randomUUID();
const OTHER_AGENT_ID = randomUUID();
let token: string;
let server: http.Server;
let baseUrl: string;
const pkgs: Record<string, string> = {};
const customers: Record<string, string> = {};

const app = express();
app.use(express.json());
app.use(ordersRouter);

async function order(id: string, o: { customer: string; company: string; sender: string; receiver: string; amount: number; status: string; agent?: string; age?: string }) {
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone, agent_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - $10::interval)`,
    [id, customers[o.customer], o.company, pkgs[o.company], o.amount, o.status, o.sender, o.receiver, o.agent ?? AGENT_ID, o.age ?? "0 seconds"]
  );
}

async function get(qs: string) {
  const res = await fetch(`${baseUrl}/agent/transactions/history?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return ((await res.json()) as any[]).map((r) => r.orderId).sort();
}

before(async () => {
  for (const [id, name] of [["txh-hormuud", "Hormuud"], ["txh-somtel", "Somtel"]]) {
    await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,$2,1,'#16A34A')`, [id, name]);
    pkgs[id] = (await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, validity) VALUES (gen_random_uuid(),$1,'data','Anfac',1,'30 maalin') RETURNING id`,
      [id]
    ))!.id;
  }
  for (const [key, name, phone] of [["yaasin", "Yaasin Maxamed Adan", "252619000001"], ["sheeq", "Maxamed Sheeq Cumar", "252619000002"]]) {
    customers[key] = (await queryOne<{ id: string }>(`INSERT INTO customers (id, name, phone) VALUES (gen_random_uuid(),$1,$2) RETURNING id`, [name, phone]))!.id;
  }
  for (const id of [AGENT_ID, OTHER_AGENT_ID]) {
    await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Agent','x')`, [id, `25269800${Math.floor(1000 + Math.random() * 8999)}`]);
  }
  await order("DLBTXH0001", { customer: "yaasin", company: "txh-hormuud", sender: "252612345678", receiver: "+252619876543", amount: 1.5, status: "completed" });
  await order("DLBTXH0002", { customer: "sheeq", company: "txh-somtel", sender: "0621112233", receiver: "0624455667", amount: 0.18, status: "failed" });
  await order("DLBTXH0003", { customer: "yaasin", company: "txh-hormuud", sender: "252617778888", receiver: "252619990000", amount: 0.45, status: "completed", age: "30 hours" });
  await order("DLBTXH0004", { customer: "yaasin", company: "txh-somtel", sender: "252612233445", receiver: "252615566778", amount: 0.09, status: "completed", age: "20 days" });
  await order("DLBTXH0005", { customer: "yaasin", company: "txh-hormuud", sender: "252612345678", receiver: "252619876543", amount: 1.5, status: "completed", agent: OTHER_AGENT_ID });

  token = signAccessToken(AGENT_ID, "agent");
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

test("each row keeps the payment number and the internet destination separate", async () => {
  const res = await fetch(`${baseUrl}/agent/transactions/history?range=today&companyId=txh-hormuud`, { headers: { Authorization: `Bearer ${token}` } });
  const [row] = (await res.json()) as any[];
  assert.equal(row.orderId, "DLBTXH0001");
  assert.equal(row.customerName, "Yaasin Maxamed Adan");
  assert.equal(row.paymentNumber, "252612345678");
  assert.equal(row.destinationNumber, "+252619876543");
  assert.equal(row.companyName, "Hormuud");
  assert.equal(row.packageName, "Anfac");
  assert.equal(row.status, "completed");
  assert.equal(Number(row.amount), 1.5);
});

test("date ranges filter, and only this agent's orders are listed", async () => {
  assert.deepEqual(await get("range=today"), ["DLBTXH0001", "DLBTXH0002"]);
  assert.deepEqual(await get("range=1week"), ["DLBTXH0001", "DLBTXH0002", "DLBTXH0003"]);
  assert.deepEqual(await get("range=1month"), ["DLBTXH0001", "DLBTXH0002", "DLBTXH0003", "DLBTXH0004"]);
  assert.deepEqual(await get("range=1year"), ["DLBTXH0001", "DLBTXH0002", "DLBTXH0003", "DLBTXH0004"]);
});

test("one calendar day can be picked", async () => {
  const day = (await queryOne<{ d: string }>(`SELECT to_char(created_at, 'YYYY-MM-DD') AS d FROM orders WHERE id='DLBTXH0004'`))!.d;
  assert.deepEqual(await get(`date=${day}`), ["DLBTXH0004"]);
});

test("the company filter works with the date range", async () => {
  assert.deepEqual(await get("range=1month&companyId=txh-somtel"), ["DLBTXH0002", "DLBTXH0004"]);
  assert.deepEqual(await get("range=today&companyId=txh-somtel"), ["DLBTXH0002"]);
  assert.deepEqual(await get("range=1month&companyId=all"), ["DLBTXH0001", "DLBTXH0002", "DLBTXH0003", "DLBTXH0004"]);
});

test("search finds by name, either number in any format, or reference -- within the filters", async () => {
  assert.deepEqual(await get("range=1month&search=sheeq"), ["DLBTXH0002"]);
  assert.deepEqual(await get("range=1month&search=0612345678"), ["DLBTXH0001"], "payment number, local format");
  assert.deepEqual(await get("range=1month&search=%2B252619876543"), ["DLBTXH0001"], "destination number, +252 format");
  assert.deepEqual(await get("range=1month&search=621112233"), ["DLBTXH0002"]);
  assert.deepEqual(await get("range=1month&search=dlbtxh0003"), ["DLBTXH0003"], "reference");
  assert.deepEqual(await get("range=1month&search=yaasin&companyId=txh-somtel"), ["DLBTXH0004"], "search + company");
  assert.deepEqual(await get("range=today&search=0619990000"), [], "search + date range");
});

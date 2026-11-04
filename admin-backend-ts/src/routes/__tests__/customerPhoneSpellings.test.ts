// Run against a freshly migrated local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false JWT_SECRET=... \
//     npx tsx --test --test-force-exit src/routes/__tests__/customerPhoneSpellings.test.ts
//
// One customer per phone number whatever spelling a client sends
// (lib/customerPhone.ts). Production had 8 numbers with two accounts each:
// a "252..." row from the Customer App and a 9-digit row made when the
// Agent App (which sends 9 digits) created an order or customer for the
// same number.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { customersRouter } from "../customers.routes.js";
import { canonicalCustomerPhone, findCustomerByPhone, findOrCreateCustomerByPhone } from "../../lib/customerPhone.js";

const app = express();
app.use(express.json());
app.use(customersRouter);
let server: http.Server;
let base: string;
const AGENT = randomUUID();
const ADMIN = randomUUID();
let agentToken: string;
let adminToken: string;

before(async () => {
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699112233','Spelling Agent','x')`, [AGENT]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'spelling-sa@test.local','x','super_admin')`, [ADMIN]);
  agentToken = signAccessToken(AGENT, "agent");
  adminToken = signAccessToken(ADMIN, "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

async function call(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const count = (local: string) =>
  queryOne<{ n: string }>(`SELECT count(*) AS n FROM customers WHERE phone IN ($1, '252' || $1, '+252' || $1)`, [local]).then((r) => Number(r!.n));

test("canonical spelling is 252 + 9 digits", () => {
  for (const raw of ["615000101", "252615000101", "+252615000101", "+252 61 500 0101"]) assert.equal(canonicalCustomerPhone(raw), "252615000101");
  assert.equal(canonicalCustomerPhone("12345"), "12345", "anything else is kept as given");
});

test("a 9-digit number finds the customer stored as 252..., and nothing new is created", async () => {
  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252615000102')`, [id]);
  assert.equal((await findCustomerByPhone<{ id: string }>("615000102", "id"))!.id, id);
  const r = await findOrCreateCustomerByPhone<{ id: string }>("615000102", {}, "id");
  assert.equal(r.created, false);
  assert.equal(r.customer.id, id);
  assert.equal(await count("615000102"), 1);
});

test("a new number from the Agent App (9 digits) is stored as 252...", async () => {
  const r = await findOrCreateCustomerByPhone<{ phone: string }>("615000103", { name: "Walk-in" }, "phone, name");
  assert.equal(r.created, true);
  assert.equal(r.customer.phone, "252615000103");
  // ...so the Customer App's own spelling finds the same account.
  assert.equal((await findCustomerByPhone<{ phone: string }>("252615000103", "phone"))!.phone, "252615000103");
});

test("concurrent creates of one number in different spellings make one customer", async () => {
  const spellings = ["615000104", "252615000104", "+252615000104", "615000104", "252615000104"];
  const results = await Promise.all(spellings.map((s) => findOrCreateCustomerByPhone<{ id: string }>(s, {}, "id")));
  assert.equal(new Set(results.map((r) => r.customer.id)).size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(await count("615000104"), 1);
});

test("agent 'add customer' with 9 digits for an existing 252... customer: 409, no duplicate", async () => {
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1, '252615000105', 'Already Here')`, [randomUUID()]);
  const r = await call("POST", "/agent/customers", agentToken, { phone: "615000105", name: "Again" });
  assert.equal(r.status, 409);
  assert.equal(await count("615000105"), 1);
  const fresh = await call("POST", "/agent/customers", agentToken, { phone: "615000106", name: "New One" });
  assert.equal(fresh.status, 201);
  assert.equal(fresh.body.phone, "252615000106");
});

test("changing a customer's number can't take another customer's number in another spelling", async () => {
  const a = randomUUID();
  const b = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252615000107'), ($2, '252615000108')`, [a, b]);
  const clash = await call("PUT", `/admin/customers/${a}`, adminToken, { phone: "615000108" });
  assert.equal(clash.status, 409);
  const same = await call("PUT", `/admin/customers/${a}`, adminToken, { phone: "615000107", name: "Renamed" });
  assert.equal(same.status, 200, "its own number in another spelling isn't a change");
  assert.equal(same.body.phone, "252615000107");
  const moved = await call("PUT", `/agent/customers/${a}`, agentToken, { phone: "615000109" });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.phone, "252615000109", "a new number is stored as 252...");
});

// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test --test-force-exit src/routes/__tests__/agentNotificationsInbox.test.ts
//
// The Agent App's Notifications inbox (GET /agent/notifications) showed one
// customer broadcast once per recipient -- same title, body and time --
// because it listed every customer's own copy. It lists only notices sent
// to everyone; each customer still gets exactly their own copy.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { notificationsRouter } from "../notifications.routes.js";

const app = express();
app.use(express.json());
app.use(notificationsRouter);
let server: http.Server;
let baseUrl: string;
let agentToken: string;
let adminToken: string;
const customerIds: string[] = [];

function call(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  const agentId = randomUUID();
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699777001','Agent','x')`, [agentId]);
  const adminId = randomUUID();
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'inbox-admin@example.com','x','super_admin')`, [adminId]);
  for (let i = 0; i < 7; i++) {
    customerIds.push((await queryOne<{ id: string }>(
      `INSERT INTO customers (id, phone) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [`2526199900${10 + i}`]
    ))!.id);
  }
  agentToken = signAccessToken(agentId, "agent");
  adminToken = signAccessToken(adminId, "super_admin");
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

test("a broadcast to 7 customers is not shown 7 times in the agent's inbox", async () => {
  const res = await call("POST", "/notifications/broadcast", agentToken, {
    targetType: "multiple",
    customerIds,
    serviceFilter: "all",
    title: "Dalab app",
    body: "macamil shaqan wey socata",
  });
  assert.equal(res.status, 201);
  // Each customer got their own copy...
  const copies = await query(`SELECT customer_id FROM notifications WHERE body='macamil shaqan wey socata'`);
  assert.equal(copies.length, 7);
  // ...but none of them are the agent's.
  const inbox = (await (await call("GET", "/agent/notifications", agentToken)).json()) as any[];
  assert.equal(inbox.filter((n) => n.body === "macamil shaqan wey socata").length, 0);
});

test("a notice sent to everyone appears once, and two with the same text both stay", async () => {
  for (let i = 0; i < 2; i++) {
    assert.equal((await call("POST", "/admin/notifications/send", adminToken, { type: "push", title: "Dalab app", body: "Same text" })).status, 201);
  }
  const inbox = (await (await call("GET", "/agent/notifications", agentToken)).json()) as any[];
  const same = inbox.filter((n) => n.body === "Same text");
  assert.equal(same.length, 2, "two separate notices with identical text are both kept");
  assert.notEqual(same[0].id, same[1].id);
  assert.equal(new Set(inbox.map((n) => n.id)).size, inbox.length, "no id appears twice");
  for (const n of inbox) assert.ok(n.id && n.title !== undefined && n.sentAt, "fields the Agent App reads");
});

test("customers' private notifications never reach the agent; each customer sees their own once", async () => {
  await query(`INSERT INTO notifications (id, type, title, body, customer_id) VALUES (gen_random_uuid(),'order_update','Order','Private to one customer',$1)`, [customerIds[0]]);
  const inbox = (await (await call("GET", "/agent/notifications", agentToken)).json()) as any[];
  assert.equal(inbox.filter((n) => n.body === "Private to one customer").length, 0);

  const customerToken = signAccessToken(customerIds[0], "customer");
  const mine = (await (await call("GET", "/notifications", customerToken)).json()) as any[];
  assert.equal(mine.filter((n) => n.body === "macamil shaqan wey socata").length, 1, "the broadcast once for this customer");
  assert.equal(mine.filter((n) => n.body === "Private to one customer").length, 1);
  assert.equal(mine.filter((n) => n.body === "Same text").length, 2);
});

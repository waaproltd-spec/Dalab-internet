// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/agentOperations.test.ts
//
// Agent operations (WAAPRO LTD AGENT app): approve / reject a payment,
// cancel, retry and reverse an order -- each only with operational access,
// each once (no double approvals or refunds), never while a dial may have
// sent the data, and each recorded in the Activity Log with the agent.
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
import { agentsRouter } from "../agents.routes.js";

const app = express();
app.use(express.json());
app.use(ordersRouter);
app.use(agentsRouter);

let server: http.Server;
let base: string;
const AGENT = randomUUID();
const ADMIN = randomUUID();
const CUSTOMER = randomUUID();
const PACKAGE = randomUUID();
let agentToken: string;
let adminToken: string;

async function call(method: string, path: string, body: unknown, token: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const post = (path: string, body: unknown = {}) => call("POST", path, body, agentToken);

let orderCount = 0;
async function newOrder(status = "pending"): Promise<string> {
  const id = randomUUID();
  // A different amount each time: only one identical pending order per customer is allowed.
  const amount = 1 + ++orderCount / 100;
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone)
     VALUES ($1,$2,'hormuud',$3,$4,$5,'615550500','615550500')`,
    [id, CUSTOMER, PACKAGE, amount, status]
  );
  return id;
}
const statusOf = async (id: string) => (await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [id]))!.status;
// The agent's own Activity Log rows for an order (the system also logs e.g. USSD generation).
const logsFor = (id: string) => query<{ action: string; agent_id: string; new_value: any }>(`SELECT action, agent_id, new_value FROM admin_activity_log WHERE entity_id=$1 AND agent_id IS NOT NULL ORDER BY created_at`, [id]);

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'ops-test-admin@example.com','x','super_admin')`, [ADMIN]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'615550501','Ops Agent','x')`, [AGENT]);
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,'615550500','Ops Customer')`, [CUSTOMER]);
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,'hormuud','internet','Ops Test 1GB',1.5)`, [PACKAGE]);
  agentToken = signAccessToken(AGENT, "agent");
  adminToken = signAccessToken(ADMIN, "super_admin");
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("approve: with a matched SMS no reason is needed; without one a reason is required and flagged; never twice", async () => {
  const withSms = await newOrder();
  await query(`INSERT INTO sms_logs (id, sender, body, matched_order_id) VALUES ($1,'192','paid',$2)`, [randomUUID(), withSms]);
  const ok = await post(`/agent/orders/${withSms}/approve-payment`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await statusOf(withSms), "in_progress");
  const again = await post(`/agent/orders/${withSms}/approve-payment`);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "ALREADY_HANDLED");
  assert.equal((await query(`SELECT 1 FROM payment_transactions WHERE order_id=$1`, [withSms])).length, 1, "one payment record");
  assert.deepEqual((await logsFor(withSms)).map((l) => [l.action, l.agent_id]), [["agent_payment_approved", AGENT]]);

  const noSms = await newOrder();
  const refused = await post(`/agent/orders/${noSms}/approve-payment`);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "REASON_REQUIRED");
  assert.equal(await statusOf(noSms), "pending");
  const withReason = await post(`/agent/orders/${noSms}/approve-payment`, { reason: "EVC ref 12345 checked" });
  assert.equal(withReason.status, 200);
  const [log] = await logsFor(noSms);
  assert.equal(log.action, "agent_payment_approved_without_sms");
  assert.equal(log.new_value.reason, "EVC ref 12345 checked");
});

test("approving the same order twice at once approves it once", async () => {
  const id = await newOrder();
  const results = await Promise.all([1, 2, 3].map(() => post(`/agent/orders/${id}/approve-payment`, { reason: "checked twice" })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal((await logsFor(id)).length, 1);
});

test("reject and cancel need a reason, end the order once, and are refused once the data may have been sent", async () => {
  const id = await newOrder();
  assert.equal((await post(`/agent/orders/${id}/reject-payment`)).body.code, "REASON_REQUIRED");
  const rejected = await post(`/agent/orders/${id}/reject-payment`, { reason: "no money received" });
  assert.equal(rejected.status, 200);
  assert.equal(await statusOf(id), "failed");
  assert.equal((await post(`/agent/orders/${id}/reject-payment`, { reason: "again" })).status, 409, "a failed order can't be rejected again");
  const cancelled = await post(`/agent/orders/${id}/cancel`, { reason: "customer asked" });
  assert.equal(cancelled.status, 200, "a failed order can still be cancelled");
  assert.equal(await statusOf(id), "cancelled");
  assert.deepEqual((await logsFor(id)).map((l) => l.action), ["agent_payment_rejected", "agent_order_cancelled"]);

  const sent = await newOrder("in_progress");
  await query(`INSERT INTO ussd_dial_attempts (id, order_id, ussd_string, status) VALUES ($1,$2,'*1#','success')`, [randomUUID(), sent]);
  const blocked = await post(`/agent/orders/${sent}/cancel`, { reason: "too late" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "ALREADY_SENT");

  const unknown = await newOrder("in_progress");
  await query(`INSERT INTO ussd_dial_attempts (id, order_id, ussd_string, status) VALUES ($1,$2,'*1#','ambiguous')`, [randomUUID(), unknown]);
  assert.equal((await post(`/agent/orders/${unknown}/reject-payment`, { reason: "unsure" })).body.code, "DIAL_UNCONFIRMED");
  assert.equal(await statusOf(unknown), "in_progress");
});

test("retry puts a failed order with a verified payment back to processing, ready to dial", async () => {
  const id = await newOrder();
  await post(`/agent/orders/${id}/approve-payment`, { reason: "checked" });
  await query(`UPDATE orders SET status='failed' WHERE id=$1`, [id]);
  await query(`UPDATE payment_transactions SET status='failed' WHERE order_id=$1`, [id]);
  const retried = await post(`/agent/orders/${id}/retry`);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(await statusOf(id), "in_progress");
  assert.equal((await queryOne<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1`, [id]))!.status, "pending");
  assert.equal((await post(`/agent/orders/${id}/retry`)).status, 200, "a stuck processing order can be retried too");

  const unpaid = await newOrder();
  await query(`UPDATE orders SET status='failed' WHERE id=$1`, [unpaid]);
  assert.equal((await post(`/agent/orders/${unpaid}/retry`)).body.code, "NO_PAYMENT");
});

test("reverse only a completed order, once, with a reason", async () => {
  const id = await newOrder("completed");
  assert.equal((await post(`/agent/orders/${id}/reverse`)).body.code, "REASON_REQUIRED");
  assert.equal((await post(`/agent/orders/${id}/reverse`, { reason: "wrong number" })).status, 200);
  assert.equal(await statusOf(id), "cancelled");
  assert.equal((await post(`/agent/orders/${id}/reverse`, { reason: "again" })).status, 409);
  const pending = await newOrder();
  assert.equal((await post(`/agent/orders/${pending}/reverse`, { reason: "x y z" })).body.code, "NOT_COMPLETED");
});

test("an admin switches an agent's operational access off and on; off refuses every manual action", async () => {
  const off = await call("PUT", `/admin/agents/${AGENT}/operations`, { enabled: false }, adminToken);
  assert.equal(off.status, 200);
  const list = await fetch(`${base}/admin/agents`, { headers: { Authorization: `Bearer ${adminToken}` } }).then((r) => r.json() as any);
  assert.equal(list.find((a: any) => a.id === AGENT).operationsEnabled, false);
  const id = await newOrder();
  for (const path of ["approve-payment", "reject-payment", "cancel", "retry", "reverse"]) {
    const r = await post(`/agent/orders/${id}/${path}`, { reason: "should be refused" });
    assert.equal(r.status, 403, path);
    assert.equal(r.body.code, "AGENT_OPERATIONS_DISABLED");
  }
  assert.equal(await statusOf(id), "pending");
  assert.equal((await call("PUT", `/admin/agents/${AGENT}/operations`, { enabled: true }, adminToken)).status, 200);
  assert.equal((await post(`/agent/orders/${id}/approve-payment`, { reason: "back on" })).status, 200);
  assert.equal((await call("PUT", `/admin/agents/${AGENT}/operations`, { enabled: false }, agentToken)).status, 403, "agents can't change it");
  const audit = await query(`SELECT action FROM admin_activity_log WHERE entity_type='agent' AND entity_id=$1 ORDER BY created_at`, [AGENT]);
  assert.deepEqual(audit.map((a: any) => a.action), ["agent_operations_disabled", "agent_operations_enabled"]);
});

// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/app_test PGSSL=false \
//     npx tsx --test --test-force-exit src/routes/__tests__/agentDaily.test.ts
//
// Agent App "Today" (orders created today, this agent's daily performance,
// daily revenue and commission) and admin Maintenance Notices. Every figure
// is checked by hand against rows inserted here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { agentDailyRouter, noticePhase, validateNotice } from "../agentDaily.routes.js";

const AGENT_ID = randomUUID();
const OTHER_AGENT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const COMPANY = "daily-co-" + Math.floor(Math.random() * 1e6);
let CUSTOMER_ID: string;
let PKG: string;
let agentToken: string;
let adminToken: string;
let server: http.Server;
let baseUrl: string;
const created: string[] = [];
const noticeIds: string[] = [];

const app = express();
app.use(express.json());
app.use(agentDailyRouter);

async function order(amount: number, status: string, opts: { agent?: string | null; ageDays?: number; reversed?: boolean } = {}) {
  const id = "TESTDAY" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, agent_id, created_at, reversed_at)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7, now() - ($8 || ' days')::interval, $9)`,
    [id, CUSTOMER_ID, COMPANY, PKG, amount, status, opts.agent === undefined ? AGENT_ID : opts.agent, String(opts.ageDays ?? 0), opts.reversed ? new Date() : null]
  );
  created.push(id);
  return id;
}

async function dial(orderId: string, agentId: string, status: string) {
  await query(
    `INSERT INTO ussd_dial_attempts (order_id, agent_id, ussd_string, attempt_number, status) VALUES ($1,$2,'*1#',1,$3)`,
    [orderId, agentId, status]
  );
}

async function commission(orderId: string, amount: number, kind: "earned" | "reversed") {
  await query(
    `INSERT INTO commission_records (order_id, company_id, order_amount, rule_type, rule_value, commission_amount, kind)
     VALUES ($1,$2,10,'percentage',10,$3,$4)`,
    [orderId, COMPANY, amount, kind]
  );
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// Today's figures for the whole system, BEFORE this test's rows: the test
// database may hold other rows, so every check is a difference.
let baseline: any;

before(async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'DailyCo',1,'#000000')`, [COMPANY]);
  PKG = (await queryOne<{ id: string }>(
    `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,'data','Daily pkg',10) RETURNING id`,
    [COMPANY]
  ))!.id;
  CUSTOMER_ID = (await queryOne<{ id: string }>(
    `INSERT INTO customers (id, phone) VALUES (gen_random_uuid(), $1) RETURNING id`,
    ["25261" + Math.floor(1000000 + Math.random() * 8999999)]
  ))!.id;
  for (const id of [AGENT_ID, OTHER_AGENT_ID]) {
    await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Agent','x')`, [id, "25269" + Math.floor(1000000 + Math.random() * 8999999)]);
  }
  agentToken = signAccessToken(AGENT_ID, "agent");
  adminToken = signAccessToken(ADMIN_ID, "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  baseline = (await call("GET", "/agent/today", agentToken)).body;

  // This agent's own orders today.
  const c1 = await order(10, "completed");
  const c2 = await order(20, "completed");
  await order(5, "pending");
  await order(7, "in_progress");
  await order(3, "failed");
  await order(4, "cancelled");
  await order(30, "cancelled", { reversed: true }); // reversed: no money, counted as cancelled
  // A customer-app order (no agent) that THIS agent dialed: theirs too.
  const dialed = await order(15, "completed", { agent: null });
  await dial(dialed, AGENT_ID, "success");
  await dial(c2, AGENT_ID, "failed");
  // Another agent's order today: in the system totals, not in "mine".
  const other = await order(50, "completed", { agent: OTHER_AGENT_ID });
  await dial(other, OTHER_AGENT_ID, "success");
  // Yesterday: never in today's figures.
  const old = await order(99, "completed", { ageDays: 2 });
  await commission(old, 9.9, "earned");

  await commission(c1, 1, "earned");
  await commission(c2, 2, "earned");
  await commission(dialed, 1.5, "earned");
  await commission(other, 5, "earned");
  // c1 earned then reversed: nets to 0.
  await commission(c1, -1, "reversed");
});

after(async () => {
  await query(`DELETE FROM commission_records WHERE order_id = ANY($1)`, [created]);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id = ANY($1)`, [created]);
  await query(`DELETE FROM orders WHERE id = ANY($1)`, [created]);
  if (noticeIds.length) await query(`DELETE FROM agent_notices WHERE id = ANY($1)`, [noticeIds]);
  await query(`DELETE FROM agents WHERE id = ANY($1)`, [[AGENT_ID, OTHER_AGENT_ID]]);
  await query(`DELETE FROM packages WHERE id=$1`, [PKG]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY]);
  server.close();
  await pool.end();
});

test("orders created today: totals for the whole system, and the buckets add up", async () => {
  const { status, body } = await call("GET", "/agent/today", agentToken);
  assert.equal(status, 200);
  const d = (k: string) => body.ordersToday[k] - baseline.ordersToday[k];
  assert.equal(d("created"), 9);
  assert.equal(d("completed"), 4); // 10, 20, dialed 15, other 50
  assert.equal(d("pending"), 2); // pending + in_progress
  assert.equal(d("failed"), 1);
  assert.equal(d("cancelled"), 2); // cancelled + reversed
  const o = body.ordersToday;
  assert.equal(o.completed + o.pending + o.failed + o.cancelled, o.created);
  assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.timezone, "Africa/Mogadishu");
});

test("daily performance: only orders this agent created or dialed", async () => {
  const { body } = await call("GET", "/agent/today", agentToken);
  const m = body.myPerformance;
  assert.equal(m.created, 8); // 7 own + 1 dialed customer order
  assert.equal(m.completed, 3);
  assert.equal(m.pending, 2);
  assert.equal(m.failed, 1);
  assert.equal(m.cancelled, 2);
  assert.equal(m.dialAttempts, 2);
  assert.equal(m.dialSuccess, 1);
  assert.equal(m.dialFailed, 1);
  assert.equal(m.dialPending, 0);

  const other = await call("GET", "/agent/today", signAccessToken(OTHER_AGENT_ID, "agent"));
  assert.equal(other.body.myPerformance.created, 1);
  assert.equal(other.body.myPerformance.completed, 1);
});

test("daily revenue: completed volume and commission, shown separately", async () => {
  const { body } = await call("GET", "/agent/today", agentToken);
  const r = body.revenueToday;
  const b = baseline.revenueToday;
  // Completed, never-reversed orders created today: 10 + 20 + 15 + 50.
  assert.equal(Math.round((r.completedVolume - b.completedVolume) * 100) / 100, 95);
  // Commission: 1 - 1 (reversed) + 2 + 1.5 + 5; yesterday's 9.9 excluded.
  assert.equal(Math.round((r.commission - b.commission) * 100) / 100, 8.5);
  assert.equal(r.myCompletedVolume, 45);
  assert.equal(r.myCommission, 3.5);
});

test("/agent/today needs an agent token", async () => {
  const res = await fetch(`${baseUrl}/agent/today`);
  assert.equal(res.status, 401);
});

test("notice validation", () => {
  assert.ok("error" in validateNotice({ title: "", message: "x" }));
  assert.ok("error" in validateNotice({ title: "t", message: "" }));
  assert.ok("error" in validateNotice({ title: "t", message: "m", kind: "party" }));
  assert.ok("error" in validateNotice({ title: "t", message: "m", startsAt: "not a date" }));
  assert.ok("error" in validateNotice({ title: "t", message: "m", startsAt: "2030-01-02T10:00:00Z", endsAt: "2030-01-02T09:00:00Z" }));
  const ok = validateNotice({ title: " Maintenance ", message: "Down 2-3pm", startsAt: "2030-01-02T10:00:00Z" });
  assert.ok(!("error" in ok));
  if (!("error" in ok)) {
    assert.equal(ok.title, "Maintenance");
    assert.equal(ok.kind, "maintenance");
    assert.equal(ok.enabled, true);
  }
});

test("notice phase: scheduled, active, ended, disabled", () => {
  const now = new Date("2030-01-01T12:00:00Z");
  const at = (h: number) => new Date(`2030-01-01T${String(h).padStart(2, "0")}:00:00Z`);
  assert.equal(noticePhase({ enabled: true, starts_at: at(14), ends_at: at(16) }, now), "scheduled");
  assert.equal(noticePhase({ enabled: true, starts_at: at(10), ends_at: at(16) }, now), "active");
  assert.equal(noticePhase({ enabled: true, starts_at: null, ends_at: null }, now), "active");
  assert.equal(noticePhase({ enabled: true, starts_at: at(8), ends_at: at(10) }, now), "ended");
  assert.equal(noticePhase({ enabled: false, starts_at: null, ends_at: null }, now), "disabled");
});

test("maintenance notices: admin creates, agents see live and scheduled ones only", async () => {
  const hour = 3600_000;
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  const active = await call("POST", "/admin/agent-notices", adminToken, { title: "Maintenance now", message: "USSD may be slow", kind: "maintenance", endsAt: iso(2 * hour) });
  assert.equal(active.status, 201);
  assert.equal(active.body.phase, "active");
  const scheduled = await call("POST", "/admin/agent-notices", adminToken, { title: "Tonight", message: "System update 22:00-23:00", startsAt: iso(5 * hour), endsAt: iso(6 * hour) });
  assert.equal(scheduled.body.phase, "scheduled");
  const ended = await call("POST", "/admin/agent-notices", adminToken, { title: "Old", message: "Finished", startsAt: iso(-3 * hour), endsAt: iso(-1 * hour) });
  const off = await call("POST", "/admin/agent-notices", adminToken, { title: "Draft", message: "Not yet", enabled: false });
  noticeIds.push(active.body.id, scheduled.body.id, ended.body.id, off.body.id);

  const bad = await call("POST", "/admin/agent-notices", adminToken, { title: "x", message: "" });
  assert.equal(bad.status, 400);

  const seen = await call("GET", "/agent/notices", agentToken);
  assert.equal(seen.status, 200);
  const ids = seen.body.map((n: any) => n.id);
  assert.ok(ids.includes(active.body.id));
  assert.ok(ids.includes(scheduled.body.id));
  assert.ok(!ids.includes(ended.body.id));
  assert.ok(!ids.includes(off.body.id));
  // Active notices come before upcoming scheduled ones.
  assert.ok(ids.indexOf(active.body.id) < ids.indexOf(scheduled.body.id));

  // Admin turns the draft on: agents now see it. Then deletes it.
  const on = await call("PUT", `/admin/agent-notices/${off.body.id}`, adminToken, { title: "Draft", message: "Now live", enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.phase, "active");
  assert.ok((await call("GET", "/agent/notices", agentToken)).body.some((n: any) => n.id === off.body.id));
  assert.equal((await call("DELETE", `/admin/agent-notices/${off.body.id}`, adminToken)).status, 200);
  assert.equal((await call("DELETE", `/admin/agent-notices/${off.body.id}`, adminToken)).status, 404);

  const list = await call("GET", "/admin/agent-notices", adminToken);
  assert.ok(list.body.some((n: any) => n.id === ended.body.id && n.phase === "ended"));
});

test("agents cannot create or change notices", async () => {
  const res = await call("POST", "/admin/agent-notices", agentToken, { title: "Hack", message: "no" });
  assert.ok(res.status === 401 || res.status === 403);
  const list = await call("GET", "/admin/agent-notices", agentToken);
  assert.ok(list.status === 401 || list.status === 403);
});

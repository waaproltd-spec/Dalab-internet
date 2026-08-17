// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/notificationBroadcast.test.ts
//
// Covers POST /notifications/broadcast's target resolution (single/
// multiple/all/recent, each combined with the service filter) and
// GET /notifications/campaigns' history — both routes are reachable
// identically by super_admin/admin/agent, so a single agentToken exercises
// the exact same code an Admin-dashboard request would. FIREBASE_* env
// vars are intentionally left unset here, so every send in this file goes
// through push.ts's "not configured" no-op path — that's fine for what
// this file verifies (targeting + counts + history), not actual FCM
// delivery, which has no meaningful way to test without live credentials.
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

const COMPANY_ID = "test-broadcast-company";
const CATEGORY_ID = randomUUID();
const PACKAGE_ID = randomUUID();
const AGENT_ID = randomUUID();

const app = express();
app.use(express.json());
app.use(notificationsRouter);
let server: http.Server;
let baseUrl: string;
let agentToken: string;

// Four customers covering every targeting axis this suite checks: a
// recently-joined one (for 'recent'), an old one with a real order (for
// 'internet'), an old one with none (excluded by 'internet'), and a
// blocked one (must never be a recipient of anything, regardless of
// targetType/serviceFilter).
let recentCustomerId: string;
let internetCustomerId: string;
let plainCustomerId: string;
let blockedCustomerId: string;

before(async () => {
  await query(`DELETE FROM notification_campaign_recipients`);
  await query(`DELETE FROM notification_campaigns`);
  await query(`DELETE FROM notifications`);
  await query(`DELETE FROM customer_device_tokens`);
  await query(`DELETE FROM macaash_transactions`);
  await query(`DELETE FROM payment_transactions`);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM packages`);
  await query(`DELETE FROM service_categories`);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers`);
  await query(`DELETE FROM agents WHERE phone=$1`, ["252699100000"]);

  recentCustomerId = randomUUID();
  internetCustomerId = randomUUID();
  plainCustomerId = randomUUID();
  blockedCustomerId = randomUUID();

  await query(`INSERT INTO customers (id, phone, created_at) VALUES ($1,'252677100001', now())`, [recentCustomerId]);
  await query(
    `INSERT INTO customers (id, phone, created_at) VALUES ($1,'252677100002', now() - interval '30 days')`,
    [internetCustomerId]
  );
  await query(
    `INSERT INTO customers (id, phone, created_at) VALUES ($1,'252677100003', now() - interval '30 days')`,
    [plainCustomerId]
  );
  await query(
    `INSERT INTO customers (id, phone, created_at, status) VALUES ($1,'252677100004', now(), 'blocked')`,
    [blockedCustomerId]
  );

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Telco',1,'#000000')`, [
    COMPANY_ID,
  ]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [
    CATEGORY_ID,
    COMPANY_ID,
  ]);
  await query(`INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,$3,'1GB',5,1024)`, [
    PACKAGE_ID,
    COMPANY_ID,
    CATEGORY_ID,
  ]);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status) VALUES ($1,$2,$3,$4,5,'completed')`,
    ["DLB-BROADCAST-TEST", internetCustomerId, COMPANY_ID, PACKAGE_ID]
  );

  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699100000','Test Agent','x')`, [
    AGENT_ID,
  ]);
  agentToken = signAccessToken(AGENT_ID, "agent");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

function authed(token: string, body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  };
}

interface BroadcastResult {
  id: string;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
}
interface CampaignRow {
  createdByName: string;
  createdByRole: string;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
}

test("targetType 'multiple' sends only to the exact customerIds given, recording an in-app row and a failed campaign_recipients row (no FCM configured in this test env)", async () => {
  const res = await fetch(`${baseUrl}/notifications/broadcast`, authed(agentToken, {
    targetType: "multiple",
    customerIds: [recentCustomerId, plainCustomerId],
    serviceFilter: "all",
    title: "Scheduled maintenance",
    body: "DALAB will be briefly unavailable tonight.",
  }));
  assert.equal(res.status, 201);
  const campaign = (await res.json()) as BroadcastResult;
  assert.equal(campaign.recipientCount, 2);
  assert.equal(campaign.sentCount, 2);
  assert.equal(campaign.deliveredCount, 0);
  assert.equal(campaign.failedCount, 2);

  const recipients = await query<{ customer_id: string; status: string }>(
    `SELECT customer_id, status FROM notification_campaign_recipients WHERE campaign_id=$1`,
    [campaign.id]
  );
  assert.equal(recipients.length, 2);
  assert.deepEqual(
    recipients.map((r) => r.customer_id).sort(),
    [recentCustomerId, plainCustomerId].sort()
  );
  assert.ok(recipients.every((r) => r.status === "failed"));

  const inAppRow = await queryOne<{ title: string; type: string }>(
    `SELECT title, type FROM notifications WHERE customer_id=$1 ORDER BY sent_at DESC LIMIT 1`,
    [recentCustomerId]
  );
  assert.equal(inAppRow?.title, "Scheduled maintenance");
  assert.equal(inAppRow?.type, "campaign");
});

test("targetType 'recent' includes only customers who joined within the last 7 days", async () => {
  const res = await fetch(`${baseUrl}/notifications/broadcast`, authed(agentToken, {
    targetType: "recent",
    serviceFilter: "all",
    title: "Welcome",
    body: "Thanks for joining DALAB!",
  }));
  const campaign = (await res.json()) as BroadcastResult;
  const recipients = await query<{ customer_id: string }>(
    `SELECT customer_id FROM notification_campaign_recipients WHERE campaign_id=$1`,
    [campaign.id]
  );
  const ids = recipients.map((r) => r.customer_id);
  assert.ok(ids.includes(recentCustomerId));
  assert.ok(!ids.includes(internetCustomerId), "a 30-day-old customer must not be picked up by 'recent'");
  assert.ok(!ids.includes(blockedCustomerId), "a blocked customer must never receive a broadcast");
});

test("targetType 'all' reaches every active customer and excludes blocked ones", async () => {
  const res = await fetch(`${baseUrl}/notifications/broadcast`, authed(agentToken, {
    targetType: "all",
    serviceFilter: "all",
    title: "App update available",
    body: "Update to the latest version for the new design.",
  }));
  const campaign = (await res.json()) as BroadcastResult;
  const recipients = await query<{ customer_id: string }>(
    `SELECT customer_id FROM notification_campaign_recipients WHERE campaign_id=$1`,
    [campaign.id]
  );
  const ids = recipients.map((r) => r.customer_id);
  assert.deepEqual(ids.sort(), [recentCustomerId, internetCustomerId, plainCustomerId].sort());
});

test("serviceFilter 'internet' matches only customers with a Store order", async () => {
  const res = await fetch(`${baseUrl}/notifications/broadcast`, authed(agentToken, {
    targetType: "all",
    serviceFilter: "internet",
    title: "New Internet packages",
    body: "Check out our new data bundles.",
  }));
  const campaign = (await res.json()) as BroadcastResult;
  const recipients = await query<{ customer_id: string }>(
    `SELECT customer_id FROM notification_campaign_recipients WHERE campaign_id=$1`,
    [campaign.id]
  );
  assert.deepEqual(recipients.map((r) => r.customer_id), [internetCustomerId]);
});

test("serviceFilter 'reseller' matches nobody yet (no Reseller data model exists)", async () => {
  const res = await fetch(`${baseUrl}/notifications/broadcast`, authed(agentToken, {
    targetType: "all",
    serviceFilter: "reseller",
    title: "Reseller launch",
    body: "Reselling is coming soon.",
  }));
  const campaign = (await res.json()) as BroadcastResult;
  assert.equal(campaign.recipientCount, 0);
});

test("targetType 'single'/'multiple' without customerIds is rejected", async () => {
  const res = await fetch(`${baseUrl}/notifications/broadcast`, authed(agentToken, {
    targetType: "single",
    serviceFilter: "all",
    title: "x",
    body: "y",
  }));
  assert.equal(res.status, 400);
});

test("GET /notifications/campaigns lists history newest-first with the sender's name resolved for an agent", async () => {
  const res = await fetch(`${baseUrl}/notifications/campaigns`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert.equal(res.status, 200);
  const rows = (await res.json()) as CampaignRow[];
  assert.ok(rows.length >= 5);
  assert.equal(rows[0].createdByName, "Test Agent");
  assert.equal(rows[0].createdByRole, "agent");
  assert.ok("sentCount" in rows[0] && "deliveredCount" in rows[0] && "failedCount" in rows[0]);
});

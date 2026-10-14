// 24/7 reliability fixes: paid orders can't be redirected, a payment SMS is
// never re-pointed, a matched payment never waits on a lost phone, unmatched
// payments stay visible, and the heartbeat reports what stops a phone from
// working on its own.
//
// Run: DATABASE_URL=... PGSSL=false JWT_SECRET=... npx tsx --test --test-force-exit src/routes/__tests__/reliabilityFixes.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { encrypt, signAccessToken } from "../../auth/crypto.js";
import { ordersRouter } from "../orders.routes.js";
import { ussdRouter } from "../ussd.routes.js";
import { smsLogsRouter, autoVerifyMatchedPendingOrders } from "../smsLogs.routes.js";
import { createPaymentTransaction } from "../../utils/paymentTransactions.js";
import { deviceHealthIssues } from "../../utils/deviceHealth.js";

const app = express();
app.use(express.json());
app.use(ordersRouter);
app.use(ussdRouter);
app.use(smsLogsRouter);
let server: http.Server;
let baseUrl: string;

const COMPANY = "rel-somtel";
const MANUAL_COMPANY = "rel-manual";
const PKG = randomUUID();
const MANUAL_PKG = randomUUID();
const AGENT_ID = randomUUID();
const SUPER_ID = randomUUID();
const DEVICE_ID = randomUUID();
let agentToken: string;
let superToken: string;
let phoneSeq = 0;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

function nextPhone() {
  return `62${String(7100000 + ++phoneSeq)}`;
}

async function guestOrder(customerPhone: string, receiverPhone: string, senderPhone: string, packageId = PKG, companyId = COMPANY) {
  return call("POST", "/guest/orders", undefined, { companyId, packageId, customerPhone, receiverPhone, senderPhone, paymentMethod: "eDahab" });
}

before(async () => {
  for (const [id, name] of [[COMPANY, "Rel Somtel"], [MANUAL_COMPANY, "Rel Manual"]]) {
    await query(`INSERT INTO companies (id, name, group_number, color_hex, status) VALUES ($1,$2,2,'#F2C200','online') ON CONFLICT (id) DO NOTHING`, [id, name]);
  }
  await query(`UPDATE companies SET pin_encrypted=$1, auto_process_enabled=true WHERE id=$2`, [encrypt("1234"), COMPANY]);
  await query(`UPDATE companies SET auto_process_enabled=false WHERE id=$1`, [MANUAL_COMPANY]);
  for (const [cid, slug] of [[COMPANY, "rel-data"], [MANUAL_COMPANY, "rel-data-m"]]) {
    await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,$3,'Data')`, [randomUUID(), cid, slug]);
  }
  await query(`INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,'rel-data','Rel 1GB',0.5,1024)`, [PKG, COMPANY]);
  await query(`INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,'rel-data-m','Rel M 1GB',0.5,1024)`, [MANUAL_PKG, MANUAL_COMPANY]);
  await query(`INSERT INTO agent_devices (id, name, enabled) VALUES ($1,'Rel Device',true)`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,$2,'Rel Agent','x',$3)`, [AGENT_ID, `25261${String(Date.now()).slice(-7)}`, DEVICE_ID]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,'x','super_admin')`, [SUPER_ID, `rel-${SUPER_ID}@example.com`]);
  agentToken = signAccessToken(AGENT_ID, "agent");
  superToken = signAccessToken(SUPER_ID, "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("a re-checkout may update an unpaid order's numbers (audited), but never a paid one's", async () => {
  const customer = nextPhone();
  const first = await guestOrder(customer, customer, customer);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const orderId = first.body.id;

  const otherReceiver = nextPhone();
  const edit = await guestOrder(customer, otherReceiver, customer);
  assert.equal(edit.status, 200);
  assert.equal(edit.body.id, orderId, "same pending order reused");
  const edited = await queryOne<any>(`SELECT receiver_phone FROM orders WHERE id=$1`, [orderId]);
  assert.match(edited.receiver_phone, new RegExp(otherReceiver.slice(-7)));
  const audit = await queryOne<any>(`SELECT old_value, new_value FROM admin_activity_log WHERE entity_id=$1 AND action='order_contact_edited'`, [orderId]);
  assert.ok(audit, "the change is recorded");

  // The payment SMS arrives and is linked to the order...
  await createPaymentTransaction({ smsLogId: null, orderId, transactionRef: null, customerPhone: customer, amount: 0.5, paymentTimestamp: new Date().toISOString(), status: "pending" });
  const before = await queryOne<any>(`SELECT sender_phone, receiver_phone FROM orders WHERE id=$1`, [orderId]);
  // ...now nobody (no login needed on this route) can redirect it.
  const attacker = nextPhone();
  const hijack = await guestOrder(customer, attacker, attacker);
  assert.equal(hijack.body.id, orderId);
  const after = await queryOne<any>(`SELECT sender_phone, receiver_phone FROM orders WHERE id=$1`, [orderId]);
  assert.deepEqual(after, before, "a paid order keeps the numbers it was paid for");
});

test("verify-payment never re-points a payment SMS that already belongs to another order", async () => {
  const a = await guestOrder(nextPhone(), nextPhone(), nextPhone());
  const b = await guestOrder(nextPhone(), nextPhone(), nextPhone());
  const smsId = randomUUID();
  await query(`INSERT INTO sms_logs (id, agent_id, sender, body, parsed_amount, matched_order_id, received_at) VALUES ($1,$2,'eDahab','paid 0.5',0.5,$3,now())`, [smsId, AGENT_ID, a.body.id]);
  await call("POST", `/agent/orders/${b.body.id}/verify-payment`, agentToken, { smsLogId: smsId });
  const sms = await queryOne<any>(`SELECT matched_order_id FROM sms_logs WHERE id=$1`, [smsId]);
  assert.equal(sms.matched_order_id, a.body.id);
});

test("a matched payment is verified by the server when no agent phone did it within the grace period (automation on only)", async () => {
  const auto = await guestOrder(nextPhone(), nextPhone(), nextPhone());
  const manual = await guestOrder(nextPhone(), nextPhone(), nextPhone(), MANUAL_PKG, MANUAL_COMPANY);
  const unpaid = await guestOrder(nextPhone(), nextPhone(), nextPhone());
  for (const id of [auto.body.id, manual.body.id]) {
    await createPaymentTransaction({ smsLogId: null, orderId: id, transactionRef: null, customerPhone: null, amount: 0.5, paymentTimestamp: new Date().toISOString(), status: "pending" });
  }
  // Fresh payments are left for the agent phone (its own call lands in seconds).
  assert.equal(await autoVerifyMatchedPendingOrders(3), 0);
  await query(`UPDATE payment_transactions SET created_at = now() - interval '5 minutes' WHERE order_id = ANY($1)`, [[auto.body.id, manual.body.id]]);
  assert.ok((await autoVerifyMatchedPendingOrders(3)) >= 1);
  assert.equal((await queryOne<any>(`SELECT status FROM orders WHERE id=$1`, [auto.body.id])).status, "in_progress");
  assert.equal((await queryOne<any>(`SELECT status FROM orders WHERE id=$1`, [manual.body.id])).status, "pending", "automation off: left for a person");
  assert.equal((await queryOne<any>(`SELECT status FROM orders WHERE id=$1`, [unpaid.body.id])).status, "pending", "never without a payment");
  assert.ok(await queryOne(`SELECT 1 FROM admin_activity_log WHERE entity_id=$1 AND action='payment_auto_verified'`, [auto.body.id]));
  // Runs again safely: nothing is verified twice.
  await autoVerifyMatchedPendingOrders(3);
  assert.equal((await queryOne<any>(`SELECT COUNT(*)::int AS n FROM admin_activity_log WHERE entity_id=$1 AND action='payment_auto_verified'`, [auto.body.id])).n, 1);
});

test("an unmatched payment SMS stays counted (and the 'unmatched' filter ignores SMS matched to other order types)", async () => {
  const unmatched = randomUUID();
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await query(`INSERT INTO sms_logs (id, agent_id, sender, body, parsed_amount, received_at) VALUES ($1,$2,'192','unmatched 0.75',0.75,$3)`, [unmatched, AGENT_ID, old]);
  await query(`INSERT INTO sms_logs (id, agent_id, sender, body, received_at) VALUES ($1,$2,'192','no amount',$3)`, [randomUUID(), AGENT_ID, old]);
  const res = await call("GET", "/admin/sms-logs/unmatched-payment-count", superToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.count >= 1, "still visible after the 24h re-match window");
  const list = await call("GET", "/admin/sms-logs?matched=false", superToken);
  assert.ok(list.body.some((r: any) => r.id === unmatched));
});

test("the heartbeat stores automation health; an older app's heartbeat never wipes it; problems are listed", async () => {
  const hb = await call("POST", `/agent/devices/${DEVICE_ID}/heartbeat`, agentToken, {
    batteryPercent: 80, networkOnline: true, sim1Present: true, sim2Present: true,
    smsPermission: false, pendingSmsCount: 2, oldestPendingSmsAgeSec: 1800, pendingActionCount: 3,
    lastSmsUploadAt: Date.now() - 3600_000, accessibilityResellerEnabled: false, batteryOptimizationIgnored: false,
    notificationsEnabled: true, phonePermission: true, serviceStartedAt: Date.now() - 60_000, appVersion: "1.1.0 (2)",
  });
  assert.equal(hb.status, 200);
  const row = await queryOne<any>(`SELECT * FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  assert.equal(row.sms_permission, false);
  assert.equal(row.pending_sms_count, 2);
  assert.equal(row.app_version, "1.1.0 (2)");
  // An older app sends only the original fields.
  await call("POST", `/agent/devices/${DEVICE_ID}/heartbeat`, agentToken, { batteryPercent: 79, networkOnline: true, sim1Present: true, sim2Present: true });
  assert.equal((await queryOne<any>(`SELECT sms_permission FROM agent_devices WHERE id=$1`, [DEVICE_ID])).sms_permission, false);

  const issues = await call("GET", "/admin/agent-devices/health-issues", superToken);
  const mine = issues.body.devices.find((d: any) => d.id === DEVICE_ID);
  const codes = mine.issues.map((i: any) => i.code).sort();
  assert.deepEqual(codes, ["accessibility", "battery_optimization", "sms_not_uploaded", "sms_permission"]);
});

test("device health rules: offline, unknown values never count as healthy or broken, disabled phones ignored", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  assert.deepEqual(deviceHealthIssues({ enabled: true, last_heartbeat_at: null }, now).map((i) => i.code), ["offline"]);
  assert.deepEqual(deviceHealthIssues({ enabled: true, last_heartbeat_at: new Date(now.getTime() - 6 * 60_000) }, now).map((i) => i.code), ["offline"]);
  assert.deepEqual(deviceHealthIssues({ enabled: true, last_heartbeat_at: new Date(now.getTime() - 60_000) }, now), [], "older app: nothing unknown is flagged");
  assert.deepEqual(deviceHealthIssues({ enabled: false, last_heartbeat_at: null }, now), []);
  const fresh = new Date(now.getTime() - 60_000);
  assert.deepEqual(deviceHealthIssues({ enabled: true, last_heartbeat_at: fresh, pending_sms_count: 3, oldest_pending_sms_age_sec: 60 }, now), [], "a just-saved SMS isn't a problem yet");
  assert.deepEqual(deviceHealthIssues({ enabled: true, last_heartbeat_at: fresh, network_online: false, phone_permission: false }, now).map((i) => i.code), ["no_internet", "phone_permission"]);
});

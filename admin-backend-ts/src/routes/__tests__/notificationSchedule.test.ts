// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/notificationSchedule.test.ts
//
// Customer broadcasts: a large audience is sent in the background (the
// answer comes at once), a small one before answering (final counts, as
// before); a scheduled message waits for its time, can be cancelled until
// then, and is sent by the scheduler; one "Send" tap is one campaign; an
// interrupted send resumes without notifying anyone twice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { notificationsRouter, runDueCampaigns } from "../notifications.routes.js";

const AGENT = randomUUID();
const OTHER = randomUUID();
const CUSTOMERS: string[] = [];
const app = express();
app.use(express.json());
app.use(notificationsRouter);
let server: http.Server;
let base: string;
const agent = signAccessToken(AGENT, "agent");
const other = signAccessToken(OTHER, "agent");

const call = (method: string, path: string, body?: unknown, token = agent) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));
const broadcast = (b: Record<string, unknown>, token = agent) =>
  call("POST", "/notifications/broadcast", { targetType: "all", serviceFilter: "all", title: "Sched test", body: "Hello", ...b }, token);
const campaign = (id: string) => queryOne<any>(`SELECT * FROM notification_campaigns WHERE id=$1`, [id]);
const recipients = async (id: string) => Number((await queryOne<any>(`SELECT count(*) AS n FROM notification_campaign_recipients WHERE campaign_id=$1`, [id]))!.n);
const activeCustomers = async () => Number((await queryOne<any>(`SELECT count(*) AS n FROM customers WHERE status='active'`))!.n);
async function waitSent(id: string) {
  for (let i = 0; i < 100; i++) {
    const c = await campaign(id);
    if (c.status === "sent") return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("campaign never finished");
}
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

before(async () => {
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699000801','Sched Agent','x'),($2,'252699000802','Other Agent','x')`, [AGENT, OTHER]);
  for (let i = 0; i < 30; i++) {
    const id = randomUUID();
    CUSTOMERS.push(id);
    await query(`INSERT INTO customers (id, phone) VALUES ($1,$2)`, [id, `25261${String(7000000 + i).padStart(7, "0")}`]);
  }
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("a large audience is answered at once and sent in the background; the counts fill in", async () => {
  const total = await activeCustomers();
  assert.ok(total > 25);
  const r = await broadcast({});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.recipientCount, total);
  assert.ok(["sending", "sent"].includes(r.body.status));
  const done = await waitSent(r.body.id);
  assert.equal(done.sent_count, total);
  assert.equal(await recipients(r.body.id), total, "each customer once");
  assert.ok(done.sent_at);
});

test("a small audience is sent before answering, with the final counts", async () => {
  const r = await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 2) });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.status, r.body.recipientCount, r.body.sentCount], ["sent", 2, 2]);
});

test("a scheduled message waits for its time, then the scheduler sends it", async () => {
  const r = await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 3), scheduledAt: inMinutes(5) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, "scheduled");
  assert.ok(r.body.scheduledAt);
  assert.equal(r.body.sentCount, 0);
  assert.equal(await runDueCampaigns(), 0, "not due yet");
  assert.equal(await recipients(r.body.id), 0, "nobody notified before its time");
  await query(`UPDATE notification_campaigns SET scheduled_at = now() - interval '1 second' WHERE id=$1`, [r.body.id]);
  assert.equal(await runDueCampaigns(), 1);
  const c = await campaign(r.body.id);
  assert.deepEqual([c.status, c.sent_count], ["sent", 3]);
  assert.equal(await runDueCampaigns(), 0, "sent once");
  assert.equal(await recipients(r.body.id), 3);
  const listed = (await call("GET", "/notifications/campaigns")).body.find((x: any) => x.id === r.body.id);
  assert.equal(listed.status, "sent");
});

test("the time must be from 1 minute to 90 days ahead", async () => {
  assert.equal((await broadcast({ scheduledAt: inMinutes(-5) })).body.code, "schedule_in_past");
  assert.equal((await broadcast({ scheduledAt: inMinutes(91 * 24 * 60) })).body.code, "schedule_too_far");
  assert.equal((await broadcast({ scheduledAt: "not a date" })).body.code, "invalid_schedule");
});

test("a scheduled message can be cancelled until it goes out -- by its sender, not by another agent", async () => {
  const r = await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 2), scheduledAt: inMinutes(10) });
  assert.equal((await call("POST", `/notifications/campaigns/${r.body.id}/cancel`, {}, other)).status, 409);
  const c = await call("POST", `/notifications/campaigns/${r.body.id}/cancel`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.status, "cancelled");
  await query(`UPDATE notification_campaigns SET scheduled_at = now() - interval '1 second' WHERE id=$1`, [r.body.id]);
  await runDueCampaigns();
  assert.equal(await recipients(r.body.id), 0, "a cancelled message is never sent");
  assert.equal((await call("POST", `/notifications/campaigns/${r.body.id}/cancel`, {})).status, 409, "only once");
  const sent = (await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 1) })).body;
  assert.equal((await call("POST", `/notifications/campaigns/${sent.id}/cancel`, {})).status, 409, "a sent message can't be cancelled");
});

test("one Send tap is one campaign, even if the request arrives twice", async () => {
  const requestId = randomUUID();
  const a = await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 2), requestId });
  const b = await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 2), requestId });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(Number((await queryOne<any>(`SELECT count(*) AS n FROM notification_campaigns WHERE request_id=$1`, [requestId]))!.n), 1);
});

test("a send a restart interrupted resumes without notifying anyone twice", async () => {
  const id = randomUUID();
  const ids = CUSTOMERS.slice(0, 5);
  await query(
    `INSERT INTO notification_campaigns (id, title, body, target_type, service_filter, recipient_count, created_by_id, created_by_role, status, customer_ids, claimed_at)
     VALUES ($1,'Interrupted','Hello','multiple','all',5,$2,'agent','sending',$3, now() - interval '20 minutes')`,
    [id, AGENT, ids]
  );
  for (const c of ids.slice(0, 2)) {
    await query(`INSERT INTO notification_campaign_recipients (id, campaign_id, customer_id, status) VALUES ($1,$2,$3,'failed')`, [randomUUID(), id, c]);
  }
  assert.equal(await runDueCampaigns(), 1);
  const c = await campaign(id);
  assert.deepEqual([c.status, c.sent_count], ["sent", 5]);
  assert.equal(await recipients(id), 5, "the 2 already notified were not notified again");
});

test("a daily message is sent every day at its time until cancelled", async () => {
  assert.equal((await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 2), repeat: "daily" })).body.code, "repeat_needs_time");
  const r = await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 2), scheduledAt: inMinutes(5), repeat: "daily" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.repeat], ["scheduled", "daily"]);
  const firstAt = new Date(r.body.scheduledAt).getTime();

  // Day 1 is due: it is sent, and day 2 is scheduled 24 hours later.
  await query(`UPDATE notification_campaigns SET scheduled_at = scheduled_at - interval '5 minutes' WHERE id=$1`, [r.body.id]);
  assert.equal(await runDueCampaigns(), 1);
  assert.equal((await campaign(r.body.id)).status, "sent");
  const next = await queryOne<any>(`SELECT * FROM notification_campaigns WHERE series_id=$1 AND status='scheduled'`, [r.body.id]);
  assert.ok(next, "tomorrow's copy is waiting");
  assert.equal(new Date(next.scheduled_at).getTime() - (firstAt - 5 * 60_000), 24 * 3600_000);
  assert.equal(next.repeat, "daily");
  assert.equal(await recipients(next.id), 0, "not sent before its day");

  // Day 2 is due: sent once, day 3 waiting -- never two waiting copies.
  await query(`UPDATE notification_campaigns SET scheduled_at = now() - interval '1 second' WHERE id=$1`, [next.id]);
  assert.equal(await runDueCampaigns(), 1);
  assert.equal(await recipients(next.id), 2);
  const waiting = await query<any>(`SELECT id FROM notification_campaigns WHERE series_id=$1 AND status='scheduled'`, [r.body.id]);
  assert.equal(waiting.length, 1);

  // Cancelling the waiting copy stops the series.
  assert.equal((await call("POST", `/notifications/campaigns/${waiting[0].id}/cancel`, {})).status, 200);
  await query(`UPDATE notification_campaigns SET scheduled_at = now() - interval '1 second' WHERE id=$1`, [waiting[0].id]);
  assert.equal(await runDueCampaigns(), 0);
  assert.equal((await query(`SELECT 1 FROM notification_campaigns WHERE series_id=$1 AND status='scheduled'`, [r.body.id])).length, 0, "no more days");
});

test("days the server missed are skipped, not sent late in a burst", async () => {
  const r = await broadcast({ targetType: "multiple", customerIds: CUSTOMERS.slice(0, 1), scheduledAt: inMinutes(5), repeat: "daily" });
  // Its time passed 3 days and 1 hour ago (the server was down).
  await query(`UPDATE notification_campaigns SET scheduled_at = now() - interval '3 days 1 hour' WHERE id=$1`, [r.body.id]);
  assert.equal(await runDueCampaigns(), 1);
  const next = await queryOne<any>(`SELECT scheduled_at FROM notification_campaigns WHERE series_id=$1 AND status='scheduled'`, [r.body.id]);
  const inMs = new Date(next.scheduled_at).getTime() - Date.now();
  assert.ok(inMs > 0 && inMs <= 24 * 3600_000, "the next copy is within the coming day, at the same time of day");
});

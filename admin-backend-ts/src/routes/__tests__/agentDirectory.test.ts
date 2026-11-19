// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/app_test PGSSL=false \
//     npx tsx --test --test-force-exit src/routes/__tests__/agentDirectory.test.ts
//
// "Other Agents": authentication, system isolation, excluding the caller,
// ONLINE/OFFLINE from the last-seen time, presence updates from agent
// requests / the live order connection / the device heartbeat, search, and
// the phone-number visibility setting.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import jwt from "jsonwebtoken";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { agentDirectoryRouter, agentPresenceMiddleware, setPresenceThrottleForTest, PHONE_SETTING_KEY } from "../agentDirectory.routes.js";
import { ordersRouter } from "../orders.routes.js";
import { ussdRouter } from "../ussd.routes.js";
import { settingsRouter } from "../settings.routes.js";

const ME = randomUUID();
const ONLINE = randomUUID();
const RECENT_EDGE = randomUUID();
const OFFLINE = randomUUID();
const NEVER = randomUUID();
const SUSPENDED = randomUUID();
const ADMIN = randomUUID();
const DEVICE = "dev-dir-" + Math.floor(Math.random() * 1e6);
const tag = "Dir" + Math.floor(Math.random() * 1e6); // unique name part for this run
const phones: Record<string, string> = {};
let server: http.Server;
let baseUrl: string;
let hadSetting: { value: string } | null;

const app = express();
app.use(express.json());
app.use(agentPresenceMiddleware);
app.use(agentDirectoryRouter);
app.use(ordersRouter);
app.use(ussdRouter);
app.use(settingsRouter);

const token = (id: string) => signAccessToken(id, "agent");

async function get(path: string, tok: string | null = token(ME)) {
  const res = await fetch(`${baseUrl}${path}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
}

async function seen(id: string) {
  return (await queryOne<{ last_seen_at: Date | null }>(`SELECT last_seen_at FROM agents WHERE id=$1`, [id]))!.last_seen_at;
}

async function setPhoneVisible(v: string | null) {
  if (v === null) await query(`DELETE FROM system_settings WHERE key=$1`, [PHONE_SETTING_KEY]);
  else await query(`INSERT INTO system_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [PHONE_SETTING_KEY, v]);
}

/** Only this run's agents (the test DB may hold others). */
const mine = (list: any[]) => list.filter((a) => String(a.name).includes(tag));

before(async () => {
  hadSetting = await queryOne<{ value: string }>(`SELECT value FROM system_settings WHERE key=$1`, [PHONE_SETTING_KEY]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,$2)`, [DEVICE, DEVICE]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,'x','super_admin')`, [ADMIN, `dir-${ADMIN}@example.com`]);
  const add = async (id: string, name: string, seenSql: string, status = "active") => {
    phones[id] = "25261" + Math.floor(1000000 + Math.random() * 8999999);
    await query(`INSERT INTO agents (id, phone, name, password_hash, status, last_seen_at) VALUES ($1,$2,$3,'x',$4, ${seenSql})`, [id, phones[id], name, status]);
  };
  await add(ME, `Me ${tag}`, "now()");
  await add(ONLINE, `Amina ${tag}`, "now() - interval '30 seconds'");
  await add(RECENT_EDGE, `Bashir ${tag}`, "now() - interval '170 seconds'");
  await add(OFFLINE, `Cali ${tag}`, "now() - interval '10 minutes'");
  await add(NEVER, `Deeqa ${tag}`, "NULL");
  await add(SUSPENDED, `Suspended ${tag}`, "now()", "suspended");
  await query(`UPDATE agents SET device_id=$1 WHERE id=$2`, [DEVICE, OFFLINE]);
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  setPresenceThrottleForTest(0);
  await setPhoneVisible(null);
});

after(async () => {
  await query(`DELETE FROM agents WHERE id = ANY($1)`, [[ME, ONLINE, RECENT_EDGE, OFFLINE, NEVER, SUSPENDED]]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE]);
  await query(`DELETE FROM admin_activity_log WHERE admin_id=$1`, [ADMIN]).catch(() => {});
  await query(`DELETE FROM admin_users WHERE id=$1`, [ADMIN]);
  if (hadSetting) await setPhoneVisible(hadSetting.value);
  else await setPhoneVisible(null);
  server.close();
  await pool.end();
});

test("authentication: only an agent token of THIS system can read the list", async () => {
  assert.equal((await get("/agent/agents", null)).status, 401);
  assert.equal((await get("/agent/agents", "not-a-token")).status, 401);
  // A token signed by another system (different secret) is refused.
  const foreign = jwt.sign({ sub: ME, role: "agent" }, "another-systems-secret", { expiresIn: 600 });
  assert.equal((await get("/agent/agents", foreign)).status, 401);
  // Customers and admins are not agents.
  assert.equal((await get("/agent/agents", signAccessToken(randomUUID(), "customer"))).status, 403);
  assert.equal((await get("/agent/agents", signAccessToken(randomUUID(), "super_admin"))).status, 403);
});

test("lists other active agents only: never the caller, never suspended agents", async () => {
  const { status, body } = await get("/agent/agents");
  assert.equal(status, 200);
  const ids = mine(body.agents).map((a: any) => a.id);
  assert.ok(!ids.includes(ME), "the caller is excluded");
  assert.ok(!ids.includes(SUSPENDED), "suspended agents are excluded");
  assert.deepEqual(new Set(ids), new Set([ONLINE, RECENT_EDGE, OFFLINE, NEVER]));
  // Another agent sees ME but not themselves.
  const other = await get("/agent/agents", token(ONLINE));
  const otherIds = mine(other.body.agents).map((a: any) => a.id);
  assert.ok(otherIds.includes(ME));
  assert.ok(!otherIds.includes(ONLINE));
});

test("ONLINE within the window, OFFLINE after it or never seen; online agents first", async () => {
  const { body } = await get("/agent/agents");
  const by = Object.fromEntries(mine(body.agents).map((a: any) => [a.id, a]));
  assert.equal(by[ONLINE].status, "ONLINE");
  assert.equal(by[ONLINE].online, true);
  assert.equal(by[RECENT_EDGE].status, "ONLINE"); // 170s < 180s window
  assert.equal(by[OFFLINE].status, "OFFLINE");
  assert.equal(by[NEVER].status, "OFFLINE");
  assert.equal(by[NEVER].lastSeenAt, null);
  assert.equal(body.onlineWindowSeconds, 180);
  const order = mine(body.agents).map((a: any) => a.status);
  assert.deepEqual(order, [...order].sort((a, b) => (a === b ? 0 : a === "ONLINE" ? -1 : 1)));
});

test("presence: any agent request marks that agent seen (and only that agent)", async () => {
  await query(`UPDATE agents SET last_seen_at = now() - interval '1 hour' WHERE id = ANY($1)`, [[NEVER, OFFLINE]]);
  await get("/agent/agents", token(NEVER));
  await new Promise((r) => setTimeout(r, 100));
  const neverSeen = await seen(NEVER);
  assert.ok(neverSeen && Date.now() - neverSeen.getTime() < 10_000, "the caller is now seen");
  const offSeen = await seen(OFFLINE);
  assert.ok(offSeen && Date.now() - offSeen.getTime() > 3_000_000, "others are untouched");
  const list = await get("/agent/agents");
  assert.equal(mine(list.body.agents).find((a: any) => a.id === NEVER).status, "ONLINE");
  await query(`UPDATE agents SET last_seen_at = NULL WHERE id=$1`, [NEVER]);
});

test("presence: the device heartbeat keeps an agent online", async () => {
  await query(`UPDATE agents SET last_seen_at = now() - interval '1 hour' WHERE id=$1`, [OFFLINE]);
  const res = await fetch(`${baseUrl}/agent/devices/${DEVICE}/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token(OFFLINE)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ batteryPercent: 80, networkOnline: true }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  const s = await seen(OFFLINE);
  assert.ok(s && Date.now() - s.getTime() < 10_000);
  await query(`UPDATE agents SET last_seen_at = now() - interval '10 minutes' WHERE id=$1`, [OFFLINE]);
});

test("presence: opening the live order connection marks the agent seen", async () => {
  await query(`UPDATE agents SET last_seen_at = NULL WHERE id=$1`, [NEVER]);
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/agent/orders/stream`, { headers: { Authorization: `Bearer ${token(NEVER)}` }, signal: controller.signal });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  controller.abort();
  const s = await seen(NEVER);
  assert.ok(s && Date.now() - s.getTime() < 10_000);
  await query(`UPDATE agents SET last_seen_at = NULL WHERE id=$1`, [NEVER]);
});

test("presence writes are throttled per agent", async () => {
  setPresenceThrottleForTest(60_000);
  await get("/agent/agents", token(ME));
  await new Promise((r) => setTimeout(r, 100));
  const first = await seen(ME);
  await query(`UPDATE agents SET last_seen_at = now() - interval '5 minutes' WHERE id=$1`, [ME]);
  await get("/agent/agents", token(ME)); // within the throttle: not written again
  await new Promise((r) => setTimeout(r, 100));
  const second = await seen(ME);
  assert.ok(first && second && second.getTime() < first.getTime());
});

test("search by name (any case) and by work phone digits", async () => {
  const byName = await get(`/agent/agents?search=${encodeURIComponent("amina " + tag.toLowerCase())}`);
  assert.deepEqual(mine(byName.body.agents).map((a: any) => a.id), [ONLINE]);
  const digits = phones[OFFLINE].slice(-6);
  const byPhone = await get(`/agent/agents?search=${encodeURIComponent(digits.slice(0, 3) + " " + digits.slice(3))}`);
  assert.ok(byPhone.body.agents.some((a: any) => a.id === OFFLINE));
  // The caller can't find themselves.
  const self = await get(`/agent/agents?search=${encodeURIComponent("Me " + tag)}`);
  assert.equal(mine(self.body.agents).length, 0);
  // Wildcards are literal.
  const pct = await get(`/agent/agents?search=${encodeURIComponent("%")}`);
  assert.equal(mine(pct.body.agents).length, 0);
});

test("phone numbers: shown by default, hidden (and not searchable) when the system turns them off", async () => {
  const shown = await get("/agent/agents");
  assert.equal(shown.body.phoneVisible, true);
  assert.equal(mine(shown.body.agents).find((a: any) => a.id === ONLINE).phone, phones[ONLINE]);

  await setPhoneVisible("false");
  const hidden = await get("/agent/agents");
  assert.equal(hidden.body.phoneVisible, false);
  assert.ok(hidden.body.agents.every((a: any) => a.phone === null));
  const byPhone = await get(`/agent/agents?search=${phones[ONLINE].slice(-7)}`);
  assert.ok(!byPhone.body.agents.some((a: any) => a.id === ONLINE), "a hidden number can't be used to find someone");
});

test("admins switch phone numbers on/off in the dashboard setting; agents can't", async () => {
  const put = (tok: string, value: string) =>
    fetch(`${baseUrl}/admin/settings/${PHONE_SETTING_KEY}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  const admin = signAccessToken(ADMIN, "super_admin");
  assert.equal((await put(admin, "maybe")).status, 400);
  assert.equal((await put(token(ME), "false")).status, 403);
  assert.equal((await put(admin, "false")).status, 200);
  assert.equal((await get("/agent/agents")).body.phoneVisible, false);
  assert.equal((await put(admin, "true")).status, 200);
  assert.equal((await get("/agent/agents")).body.phoneVisible, true);
});

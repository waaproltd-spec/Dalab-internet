// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/selectedBalanceSim.test.ts
//
// The Super Admin chooses ONE SIM per balance (EVC Plus, eDahab, Hormuud,
// ...) on the Balance Dashboard. From then on only that phone + SIM slot's
// balance is read and shown: not the other SIM in the same phone, not
// another phone or agent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { simBalancesRouter } from "../simBalances.routes.js";
import { agentSimBalancesRouter } from "../agentSimBalances.routes.js";
import { applyBalanceUpdate, getProviderBalanceTotals } from "../../utils/simBalances.js";

const A = "dev-sel-a-" + Math.floor(Math.random() * 1e6); // the agent's phone
const B = "dev-sel-b-" + Math.floor(Math.random() * 1e6); // another phone/agent
const ADMIN = randomUUID();
const admin = signAccessToken(ADMIN, "super_admin");
const agent = signAccessToken(randomUUID(), "agent");
let server: http.Server;
let base: string;

const app = express();
app.use(express.json());
app.use(simBalancesRouter);
app.use(agentSimBalancesRouter);

function call(method: string, p: string, body?: unknown, token = admin) {
  return fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));
}
const sms = (deviceId: string, simSlot: number, newBalance: number, providerKey = "evc_plus") =>
  applyBalanceUpdate({ deviceId, simSlot, newBalance, providerKey, source: "sms" });
const bal = async (deviceId: string, simSlot: number, key = "evc_plus") =>
  (await queryOne<{ balance: string }>(`SELECT balance FROM sim_balances WHERE device_id=$1 AND sim_slot=$2 AND provider_key=$3`, [deviceId, simSlot, key]))?.balance;
const dash = async (key = "evc_plus") =>
  (await call("GET", "/admin/sim-balances")).body.filter((r: any) => (r.deviceId === A || r.deviceId === B) && r.providerKey === key);
const agentList = async (key = "evc_plus") =>
  (await call("GET", "/agent/sim-balances", undefined, agent)).body.sims.filter((s: any) => (s.deviceId === A || s.deviceId === B) && s.providerKey === key);
const total = async (key = "evc_plus") => Number((await getProviderBalanceTotals()).find((t: any) => t.provider_key === key)?.total ?? 0);

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,'x','super_admin')`, [ADMIN, `sel-${ADMIN}@example.com`]);
  await query(`INSERT INTO agent_devices (id, name, last_heartbeat_at, sim1_present, sim2_present) VALUES ($1,'Sel Mobile A', now(), true, true)`, [A]);
  await query(`INSERT INTO agent_devices (id, name, last_heartbeat_at, sim1_present, sim2_present) VALUES ($1,'Sel Mobile B', now(), true, true)`, [B]);
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await query(`DELETE FROM balance_selected_sims WHERE device_id = ANY($1)`, [[A, B]]);
  await query(`DELETE FROM sim_balance_history WHERE sim_balance_id IN (SELECT id FROM sim_balances WHERE device_id = ANY($1))`, [[A, B]]);
  await query(`DELETE FROM sim_balances WHERE device_id = ANY($1)`, [[A, B]]);
  await query(`DELETE FROM agent_devices WHERE id = ANY($1)`, [[A, B]]);
  await query(`DELETE FROM admin_activity_log WHERE admin_id=$1`, [ADMIN]).catch(() => {});
  await query(`DELETE FROM admin_users WHERE id=$1`, [ADMIN]).catch(() => {});
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("before the admin chooses a SIM, every SIM's balance is read, as today", async () => {
  const before = await total();
  assert.equal(await sms(A, 1, 10), true);
  assert.equal(await sms(A, 2, 20), true);
  assert.equal(await sms(B, 1, 30), true);
  assert.equal((await dash()).length, 3);
  assert.equal((await agentList()).length, 3);
  assert.equal(Number(((await total()) - before).toFixed(2)), 60);
});

test("the admin chooses Mobile A SIM 1: only that SIM is read; SIM 2 and the other phone are ignored", async () => {
  const r = await call("PUT", "/admin/sim-balances/selected-sims/evc_plus", { deviceId: A, simSlot: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await sms(A, 2, 99), false, "same phone, other SIM: not read");
  assert.equal(await sms(B, 1, 99), false, "other phone/agent: not read");
  assert.equal(Number(await bal(A, 2)), 20);
  assert.equal(Number(await bal(B, 1)), 30);
  assert.equal(await sms(A, 1, 11.5), true);
  assert.equal(Number(await bal(A, 1)), 11.5);
  assert.equal(await sms(B, 2, 7, "edahab"), true, "other balances follow their own choice (none yet)");
});

test("the Balance Dashboard, its totals and the AGENT APP show only the chosen SIM", async () => {
  const rows = await dash();
  assert.deepEqual(rows.map((r: any) => [r.deviceId, r.simSlot, Number(r.balance)]), [[A, 1, 11.5]]);
  assert.equal(await total(), 11.5, "only the chosen SIM counts (no other EVC Plus SIMs in this test DB)");
  const app = await agentList();
  assert.deepEqual(app.map((s: any) => [s.deviceId, s.simSlot, s.balance]), [[A, 1, 11.5]]);
  assert.equal((await dash("edahab")).length, 1, "eDahab still listed");
});

test("a manual balance for a SIM that isn't the chosen one is refused", async () => {
  const r = await call("PUT", `/admin/sim-balances/${B}/1`, { balance: 5, providerKey: "evc_plus" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "not_selected_sim");
  const ok = await call("PUT", `/admin/sim-balances/${A}/1`, { balance: 12, providerKey: "evc_plus" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(Number(await bal(A, 1)), 12);
});

test("switching to SIM 2 follows SIM 2 only; clearing goes back to every SIM", async () => {
  await call("PUT", "/admin/sim-balances/selected-sims/evc_plus", { deviceId: A, simSlot: 2 });
  assert.equal(await sms(A, 1, 1), false);
  assert.equal(await sms(A, 2, 21), true);
  assert.deepEqual((await agentList()).map((s: any) => [s.deviceId, s.simSlot]), [[A, 2]]);
  const cleared = await call("DELETE", "/admin/sim-balances/selected-sims/evc_plus");
  assert.equal(cleared.body.cleared, true);
  assert.equal(await sms(B, 1, 31), true);
  assert.equal((await agentList()).length, 3);
});

test("each balance has its own choice; a chosen SIM is listed in the AGENT APP before its first message", async () => {
  await call("PUT", "/admin/sim-balances/selected-sims/hormuud", { deviceId: B, simSlot: 2 });
  assert.equal(await sms(A, 1, 40, "hormuud"), false);
  assert.equal(await sms(B, 1, 41, "hormuud"), false);
  const app = await agentList("hormuud");
  assert.deepEqual(app.map((s: any) => [s.deviceId, s.simSlot, s.balance, s.status]), [[B, 2, null, "no_balance_yet"]]);
  assert.equal(await sms(B, 2, 42, "hormuud"), true);
  assert.deepEqual((await dash("hormuud")).map((r: any) => [r.deviceId, r.simSlot, Number(r.balance)]), [[B, 2, 42]]);
  assert.equal(await sms(A, 2, 8, "edahab"), true, "eDahab has no choice: still every SIM");
  await call("DELETE", "/admin/sim-balances/selected-sims/hormuud");
});

test("only a Super Admin can choose; bad input is refused", async () => {
  assert.equal((await call("PUT", "/admin/sim-balances/selected-sims/evc_plus", { deviceId: A, simSlot: 1 }, agent)).status, 403);
  assert.equal((await call("PUT", "/admin/sim-balances/selected-sims/evc_plus", { deviceId: A, simSlot: 3 })).status, 400);
  assert.equal((await call("PUT", "/admin/sim-balances/selected-sims/nope", { deviceId: A, simSlot: 1 })).status, 400);
  assert.equal((await call("PUT", "/admin/sim-balances/selected-sims/evc_plus", { deviceId: "missing", simSlot: 1 })).status, 404);
});

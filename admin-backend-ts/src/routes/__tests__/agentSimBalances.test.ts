// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported).
//
// AGENT APP per-SIM balances: only admin-configured SIMs, each separately
// (network, phone number, phone, slot), the real balance or the real reason
// there isn't one -- never a made-up $0.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { agentSimBalancesRouter, simBalanceStatus } from "../agentSimBalances.routes.js";

const D1 = "dev-simbal-a-" + Math.floor(Math.random() * 1e6);
const D2 = "dev-simbal-b-" + Math.floor(Math.random() * 1e6);
const CO = "simbal-co-" + Math.floor(Math.random() * 1e6);
let server: http.Server;
let base: string;

const app = express();
app.use(express.json());
app.use(agentSimBalancesRouter);

async function list(token: string | null = signAccessToken(randomUUID(), "agent")) {
  const res = await fetch(`${base}/agent/sim-balances`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
}
const mine = (b: any) => b.sims.filter((s: any) => s.deviceId === D1 || s.deviceId === D2);

before(async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, payment_number) VALUES ($1,'SimBalCo',1,'#000000','615000111')`, [CO]);
  // D1 online, both SIMs in; D2 offline with SIM 2 missing.
  await query(`INSERT INTO agent_devices (id, name, last_heartbeat_at, sim1_present, sim2_present) VALUES ($1,'Mobile A', now(), true, true)`, [D1]);
  await query(`INSERT INTO agent_devices (id, name, last_heartbeat_at, sim1_present, sim2_present) VALUES ($1,'Mobile B', now() - interval '2 hours', true, false)`, [D2]);
  // D1 SIM1: EVC Plus confirmed just now + Hormuud data confirmed 2 days ago.
  await query(`INSERT INTO sim_balances (device_id, sim_slot, provider_key, phone_number, balance, last_source, updated_at) VALUES ($1,1,'evc_plus','615111111',120.5,'sms',now())`, [D1]);
  await query(`INSERT INTO sim_balances (device_id, sim_slot, provider_key, phone_number, balance, last_source, updated_at) VALUES ($1,1,'hormuud','615111111',33,'ussd_dial',now() - interval '2 days')`, [D1]);
  // D1 SIM2: configured by the admin (metadata only), no balance yet.
  await query(`INSERT INTO sim_balances (device_id, sim_slot, provider_key, phone_number, balance) VALUES ($1,2,'somtel','625222222',NULL)`, [D1]);
  // D2 SIM1: eDahab balance (phone offline); D2 SIM2: Amtel row but SIM missing.
  await query(`INSERT INTO sim_balances (device_id, sim_slot, provider_key, phone_number, balance, last_source, updated_at) VALUES ($1,1,'edahab','655333333',9.75,'sms',now())`, [D2]);
  await query(`INSERT INTO sim_balances (device_id, sim_slot, provider_key, phone_number, balance, last_source, updated_at) VALUES ($1,2,'amtel','688444444',4,'manual',now())`, [D2]);
  // SIM Routing only (no balance row): a configured network on D2 SIM1.
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES ($1,$2,1)`, [CO, D2]);
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await query(`DELETE FROM sim_routing WHERE company_id=$1`, [CO]);
  await query(`DELETE FROM sim_balances WHERE device_id = ANY($1)`, [[D1, D2]]);
  await query(`DELETE FROM agent_devices WHERE id = ANY($1)`, [[D1, D2]]);
  await query(`DELETE FROM companies WHERE id=$1`, [CO]);
  server.close();
  await pool.end();
});

test("each configured SIM is listed separately with its network, number, phone and slot", async () => {
  const { status, body } = await list();
  assert.equal(status, 200);
  const sims = mine(body);
  assert.equal(sims.length, 6);
  const evc = sims.find((s: any) => s.providerKey === "evc_plus");
  assert.deepEqual(
    { label: evc.label, network: evc.network, phone: evc.phoneNumber, device: evc.deviceName, slot: evc.simSlot, balance: evc.balance, status: evc.status, source: evc.source },
    { label: "EVC Plus", network: "Hormuud", phone: "615111111", device: "Mobile A", slot: 1, balance: 120.5, status: "ok", source: "sms" }
  );
  assert.equal(evc.message, null);
  const edahab = sims.find((s: any) => s.providerKey === "edahab");
  assert.equal(edahab.network, "Somnet");
});

test("no balance is shown as unknown with the reason -- never as $0", async () => {
  const somtel = mine((await list()).body).find((s: any) => s.providerKey === "somtel");
  assert.equal(somtel.balance, null);
  assert.equal(somtel.status, "no_balance_yet");
  assert.match(somtel.message, /No balance received yet/);
  const routedOnly = mine((await list()).body).find((s: any) => s.providerKey === CO);
  assert.equal(routedOnly.balance, null);
  assert.equal(routedOnly.status, "no_balance_yet");
  assert.equal(routedOnly.phoneNumber, "615000111");
});

test("real errors: SIM missing, phone offline, old balance", async () => {
  const sims = mine((await list()).body);
  const amtel = sims.find((s: any) => s.providerKey === "amtel");
  assert.equal(amtel.status, "sim_missing");
  assert.match(amtel.message, /SIM 2 is not detected in Mobile B/);
  const edahab = sims.find((s: any) => s.providerKey === "edahab");
  assert.equal(edahab.status, "device_offline");
  assert.equal(edahab.balance, 9.75, "the last real balance is still shown, flagged");
  const data = sims.find((s: any) => s.providerKey === "hormuud");
  assert.equal(data.status, "stale");
  assert.match(data.message, /Last update \d+ h ago/);
});

test("SIMs nobody configured are never listed", async () => {
  // D1 has no row/routing for amtel: it must not appear for D1.
  const sims = mine((await list()).body);
  assert.ok(!sims.some((s: any) => s.deviceId === D1 && s.providerKey === "amtel"));
  assert.ok(!sims.some((s: any) => s.deviceId === D1 && s.providerKey === "edahab"));
});

test("needs an agent sign-in", async () => {
  assert.equal((await list(null)).status, 401);
  assert.equal((await list(signAccessToken(randomUUID(), "customer"))).status, 403);
});

test("status rules", () => {
  const now = new Date("2026-01-02T12:00:00Z");
  const base = { sim_slot: 1, device_name: "M", sim_present: true, last_heartbeat_at: now, updated_at: now, balance: "5" };
  assert.equal(simBalanceStatus(base, now).status, "ok");
  assert.equal(simBalanceStatus({ ...base, balance: null }, now).status, "no_balance_yet");
  assert.equal(simBalanceStatus({ ...base, sim_present: false }, now).status, "sim_missing");
  assert.equal(simBalanceStatus({ ...base, last_heartbeat_at: new Date(now.getTime() - 11 * 60_000) }, now).status, "device_offline");
  assert.equal(simBalanceStatus({ ...base, updated_at: new Date(now.getTime() - 25 * 3_600_000) }, now).status, "stale");
});

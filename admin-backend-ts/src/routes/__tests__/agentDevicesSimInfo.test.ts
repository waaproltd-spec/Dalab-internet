// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers GET /agent/devices -- the Agent
// App's "Which device is this?" picker, which now needs each device's own
// SIM 1/SIM 2 provider + phone number (not just id/name/description) so the
// screen can show real routing info instead of a bare device list.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { ussdRouter } from "../ussd.routes.js";

const app = express();
app.use(express.json());
app.use(ussdRouter);

let server: http.Server;
let baseUrl: string;

const DEVICE_A = "test-device-sim-info-a";
const DEVICE_B = "test-device-sim-info-b";
const COMPANY_HORMUUD = "test-device-sim-info-hormuud";
const COMPANY_SOMTEL = "test-device-sim-info-somtel";

async function cleanup() {
  await query(`DELETE FROM sim_balances WHERE device_id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await query(`DELETE FROM sim_routing WHERE device_id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await query(`DELETE FROM agent_devices WHERE id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2)`, [COMPANY_HORMUUD, COMPANY_SOMTEL]);
}

before(async () => {
  await cleanup();
  await query(`INSERT INTO companies (id, name, group_number, color_hex, payment_number) VALUES ($1,'Test Hormuud',1,'#16A34A','610000001')`, [
    COMPANY_HORMUUD,
  ]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex, payment_number) VALUES ($1,'Test Somtel',2,'#F2C200','620000002')`, [
    COMPANY_SOMTEL,
  ]);
  await query(`INSERT INTO agent_devices (id, name, description) VALUES ($1,'Test Mobile 1','Primary phone')`, [DEVICE_A]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Test Mobile 2')`, [DEVICE_B]);

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(async () => {
  await query(`DELETE FROM sim_balances WHERE device_id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await query(`DELETE FROM sim_routing WHERE device_id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
});

async function asJson(res: Response): Promise<any> {
  return res.json();
}

function byId(devices: any[], id: string) {
  return devices.find((d) => d.id === id);
}

test("is public -- no auth required, since the app hasn't logged in yet at this screen", async () => {
  const res = await fetch(`${baseUrl}/agent/devices`);
  assert.equal(res.status, 200);
});

test("a device with no sim_routing rows returns sim1/sim2 both null, never fake data", async () => {
  const body = await asJson(await fetch(`${baseUrl}/agent/devices`));
  const deviceB = byId(body, DEVICE_B);
  assert.ok(deviceB);
  assert.equal(deviceB.sim1, null);
  assert.equal(deviceB.sim2, null);
});

test("resolves each SIM slot's real company and phone number from sim_routing + companies", async () => {
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES ($1,$2,1)`, [COMPANY_HORMUUD, DEVICE_A]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES ($1,$2,2)`, [COMPANY_SOMTEL, DEVICE_A]);

  const body = await asJson(await fetch(`${baseUrl}/agent/devices`));
  const deviceA = byId(body, DEVICE_A);
  assert.equal(deviceA.name, "Test Mobile 1");
  assert.equal(deviceA.description, "Primary phone");
  assert.deepEqual(deviceA.sim1, { companyId: COMPANY_HORMUUD, companyName: "Test Hormuud", companyColorHex: "#16A34A", phoneNumber: "610000001" });
  assert.deepEqual(deviceA.sim2, { companyId: COMPANY_SOMTEL, companyName: "Test Somtel", companyColorHex: "#F2C200", phoneNumber: "620000002" });
});

test("a confirmed per-SIM phone number (sim_balances) overrides the company's shared payment_number", async () => {
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES ($1,$2,1)`, [COMPANY_HORMUUD, DEVICE_A]);
  await query(`INSERT INTO sim_balances (id, device_id, sim_slot, company_id, phone_number, balance) VALUES ($1,$2,1,$3,'610999888',25)`, [
    randomUUID(),
    DEVICE_A,
    COMPANY_HORMUUD,
  ]);

  const body = await asJson(await fetch(`${baseUrl}/agent/devices`));
  const deviceA = byId(body, DEVICE_A);
  assert.equal(deviceA.sim1.phoneNumber, "610999888");
});

// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers GET /agent/balances -- the Agent
// Home screen's Agent Balance section: always exactly 6 rows (EVC Plus,
// eDahab, Hormuud, Somnet, Somtel, Amtel), in that fixed order, each
// company-wide (summed across every device), never scoped to just the
// calling agent's own device -- a single device only ever has 1-2 SIM
// slots, so a per-device view could never show all 6 the way the reference
// design does.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { getProviderBalanceTotals } from "../../utils/simBalances.js";
import { simBalancesRouter } from "../simBalances.routes.js";

const app = express();
app.use(express.json());
app.use(simBalancesRouter);

let server: http.Server;
let baseUrl: string;
let agentToken: string;

const AGENT_ID = randomUUID();
const AGENT_PHONE = "617300401";
const DEVICE_A = "test-agent-balances-device-a";
const DEVICE_B = "test-agent-balances-device-b";
const COMPANY_ID = "test-agent-balances-co";

async function cleanup() {
  await query(`DELETE FROM sim_balances WHERE device_id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await query(`DELETE FROM agent_devices WHERE id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
}

before(async () => {
  await cleanup();
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Agent Balances Test Co',1,'#123123')`, [COMPANY_ID]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Agent Balances Device A'),($2,'Agent Balances Device B')`, [DEVICE_A, DEVICE_B]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'Agent Balances Test Agent','x')`, [AGENT_ID, AGENT_PHONE]);
  agentToken = signAccessToken(AGENT_ID, "agent");

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
});

function authed(path: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${agentToken}` } });
}

async function asJson(res: Response): Promise<any> {
  return res.json();
}

test("with no sim_balances rows at all, still returns exactly the 6 fixed cards, each defaulting to a $0.00 placeholder", async () => {
  const res = await authed("/agent/balances");
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.deepEqual(
    body.map((r: any) => r.providerKey),
    ["evc_plus", "edahab", "hormuud", "somnet", "somtel", "amtel"]
  );
  for (const row of body) assert.equal(Number(row.balance), 0, `${row.providerKey} should default to 0`);
  assert.deepEqual(
    body.map((r: any) => r.category),
    ["method", "method", "company", "company", "company", "company"]
  );
  assert.deepEqual(
    body.map((r: any) => r.providerName),
    ["EVC Plus", "eDahab", "Hormuud", "Somnet", "Somtel", "Amtel"]
  );
});

test("sums a provider's balance across multiple devices, not just one", async () => {
  await query(
    `INSERT INTO sim_balances (id, device_id, sim_slot, provider_key, balance) VALUES
       ($1,$2,1,'hormuud',30.00),
       ($3,$4,1,'hormuud',26.80)`,
    [randomUUID(), DEVICE_A, randomUUID(), DEVICE_B]
  );
  const res = await authed("/agent/balances");
  const body = await asJson(res);
  const hormuud = body.find((r: any) => r.providerKey === "hormuud");
  assert.equal(Number(hormuud.balance), 56.8);
});

test("evc_plus and hormuud's own Send Data balance never bleed into each other, even on the same physical SIM", async () => {
  await query(
    `INSERT INTO sim_balances (id, device_id, sim_slot, provider_key, balance) VALUES
       ($1,$2,1,'hormuud',56.80),
       ($3,$2,1,'evc_plus',125.50)`,
    [randomUUID(), DEVICE_A, randomUUID()]
  );
  const res = await authed("/agent/balances");
  const body = await asJson(res);
  assert.equal(Number(body.find((r: any) => r.providerKey === "hormuud").balance), 56.8);
  assert.equal(Number(body.find((r: any) => r.providerKey === "evc_plus").balance), 125.5);
});

test("hormuud_evoucher is excluded entirely -- this is the original 6-card set, not every Balance Dashboard bucket", async () => {
  await query(`INSERT INTO sim_balances (id, device_id, sim_slot, provider_key, balance) VALUES ($1,$2,1,'hormuud_evoucher',12.00)`, [
    randomUUID(),
    DEVICE_A,
  ]);
  const res = await authed("/agent/balances");
  const body = await asJson(res);
  assert.equal(body.length, 6);
  assert.ok(!body.some((r: any) => r.providerKey === "hormuud_evoucher"));
});

test("a row with an unconfirmed (NULL) balance shows the same $0.00 placeholder as no row at all, matching the Admin dashboard's own providerTotal() fallback", async () => {
  await query(`INSERT INTO sim_balances (id, device_id, sim_slot, provider_key, balance) VALUES ($1,$2,1,'somtel',NULL)`, [
    randomUUID(),
    DEVICE_A,
  ]);
  const res = await authed("/agent/balances");
  const body = await asJson(res);
  assert.equal(Number(body.find((r: any) => r.providerKey === "somtel").balance), 0);
});

test("matches the Admin Balance Dashboard's own getProviderBalanceTotals() value exactly for a real confirmed balance", async () => {
  await query(`INSERT INTO sim_balances (id, device_id, sim_slot, provider_key, balance) VALUES ($1,$2,1,'evc_plus',125.19)`, [
    randomUUID(),
    DEVICE_A,
  ]);
  const [agentRes, totals] = await Promise.all([authed("/agent/balances"), getProviderBalanceTotals()]);
  const agentBody = await asJson(agentRes);
  const adminTotal = Number(totals.find((t) => t.provider_key === "evc_plus")?.total ?? 0);
  const agentTotal = Number(agentBody.find((r: any) => r.providerKey === "evc_plus").balance);
  assert.equal(agentTotal, 125.19);
  assert.equal(agentTotal, adminTotal, "Agent and Admin must report the exact same number for the same provider");
});

test("requires agent auth -- an unauthenticated request is rejected", async () => {
  const res = await fetch(`${baseUrl}/agent/balances`);
  assert.equal(res.status, 401);
});

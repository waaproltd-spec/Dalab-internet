// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/simBalanceCheck.test.ts
//
// Insufficient SIM Balance alert: the pure decision (sufficient /
// insufficient / unknown / outdated, exact missing amount and message), the
// Agent App's GET .../sim-balance-check, and the backend enforcement in
// POST .../dial-attempts that no client can bypass.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ussdRouter } from "../ussd.routes.js";
import { evaluateSimBalance } from "../../utils/simBalanceCheck.js";

// The default policy: unknown/outdated balances need the agent's confirmation.
delete process.env.SIM_BALANCE_UNVERIFIED_POLICY;

const COMPANY_ID = "test-simbal-hormuud";
const CATEGORY_ID = randomUUID();
const DEVICE_ID = "test-simbal-device";
const AGENT_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const USSD = "*737*1*770001234*20#";

let packageId: string;
let agentToken: string;

const app = express();
app.use(express.json());
app.use(ussdRouter);
let server: http.Server;
let baseUrl: string;

// ---------------- Pure decision ----------------

test("insufficient: the spec's example -- $20 requested, $12 available, $8 missing, exact message", () => {
  const r = evaluateSimBalance({ requestedAmount: 20, availableBalance: 12, balanceUpdatedAt: new Date(), companyName: "Hormuud" });
  assert.equal(r.status, "insufficient");
  assert.equal(r.ok, false);
  assert.equal(r.requestedAmount, 20);
  assert.equal(r.availableBalance, 12);
  assert.equal(r.missingAmount, 8);
  assert.equal(
    r.message,
    "Insufficient SIM Balance — Hormuud. The customer requested $20.00, but the available SIM balance is only $12.00. The remaining amount needed is $8.00. Please recharge the Hormuud SIM and try again."
  );
});

test("sufficient: balance equal to or above the request passes with no warning", () => {
  for (const balance of [20, 20.01, 500]) {
    const r = evaluateSimBalance({ requestedAmount: 20, availableBalance: balance, balanceUpdatedAt: new Date(), companyName: "Hormuud" });
    assert.equal(r.status, "sufficient");
    assert.equal(r.ok, true);
    assert.equal(r.missingAmount, 0);
    assert.equal(r.message, null);
  }
});

test("missing amount is exact to the cent (no float noise)", () => {
  const r = evaluateSimBalance({ requestedAmount: 0.3, availableBalance: 0.1, balanceUpdatedAt: new Date(), companyName: "Somtel" });
  assert.equal(r.status, "insufficient");
  assert.equal(r.missingAmount, 0.2);
});

test("unknown: no balance on record is never assumed to be enough", () => {
  const r = evaluateSimBalance({ requestedAmount: 5, availableBalance: null, balanceUpdatedAt: null, companyName: "Somnet" });
  assert.equal(r.status, "unknown");
  assert.equal(r.ok, false);
  assert.equal(r.availableBalance, null);
  assert.equal(r.missingAmount, null);
  assert.match(r.message!, /^SIM Balance Unknown — Somnet\..*Somnet SIM/);
});

test("outdated: an old balance is a separate warning even if it looked big enough", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const r = evaluateSimBalance({
    requestedAmount: 5,
    availableBalance: 100,
    balanceUpdatedAt: new Date("2026-10-07T12:00:00Z"),
    companyName: "Amtel",
    now,
    maxAgeMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(r.status, "outdated");
  assert.equal(r.ok, false);
  assert.match(r.message!, /^SIM Balance Outdated — Amtel\..*\$100\.00/);
  const fresh = evaluateSimBalance({
    requestedAmount: 5,
    availableBalance: 100,
    balanceUpdatedAt: new Date("2026-10-09T11:00:00Z"),
    companyName: "Amtel",
    now,
    maxAgeMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(fresh.status, "sufficient");
});

// ---------------- API + enforcement ----------------

async function insertOrder(amount = 20, sendCount = 1): Promise<string> {
  const id = "TESTSIMBAL" + Math.floor(100000 + Math.random() * 900000);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel, ussd_generated)
     VALUES ($1,$2,$3,$4,$5,'252619990001','252770001234','in_progress','customer_app',$6)`,
    [id, CUSTOMER_ID, COMPANY_ID, packageId, amount, USSD]
  );
  if (sendCount > 1) await query(`UPDATE orders SET send_count=$2 WHERE id=$1`, [id, sendCount]);
  return id;
}

async function setBalance(balance: number | null, updatedAt = new Date()) {
  await query(
    `INSERT INTO sim_balances (device_id, sim_slot, company_id, provider_key, balance, updated_at, last_source)
     VALUES ($1, 1, $2, 'hormuud', $3, $4, 'sms')`,
    [DEVICE_ID, COMPANY_ID, balance, updatedAt]
  );
}

function check(orderId: string) {
  return fetch(`${baseUrl}/agent/orders/${orderId}/sim-balance-check?simSlot=1`, { headers: { Authorization: `Bearer ${agentToken}` } });
}

function dial(orderId: string, extra: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/agent/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ simSlot: 1, ussdString: USSD, attemptNumber: 1, ...extra }),
  });
}

async function attemptCount(orderId: string): Promise<number> {
  return (await query(`SELECT id FROM ussd_dial_attempts WHERE order_id=$1`, [orderId])).length;
}

async function cleanup() {
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTSIMBAL%'`);
  await query(`DELETE FROM sim_balance_history WHERE sim_balance_id IN (SELECT id FROM sim_balances WHERE device_id=$1)`, [DEVICE_ID]);
  await query(`DELETE FROM sim_balances WHERE device_id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTSIMBAL%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
}

before(async () => {
  await cleanup();
  await query(`DELETE FROM sim_routing WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone='252619990001'`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1 OR phone='252699007788'`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  await query(`INSERT INTO agent_devices (id, name, enabled) VALUES ($1,'Test SIM Balance Device', true)`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699007788','Test SIM Balance Agent','x',$2)`, [AGENT_ID, DEVICE_ID]);
  agentToken = signAccessToken(AGENT_ID, "agent");
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,'252619990001','Ahmed Ali')`, [CUSTOMER_ID]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Hormuud',1,'#16A34A')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,1,1)`, [COMPANY_ID, DEVICE_ID]);
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Test Package',20) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(cleanup);

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
  await query(`DELETE FROM sim_routing WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await pool.end();
});

test("insufficient balance: the check shows every detail, and the dial is refused with nothing logged", async () => {
  await setBalance(12);
  const orderId = await insertOrder(20);

  const res = await check(orderId);
  assert.equal(res.status, 200);
  const c = (await res.json()) as Record<string, unknown>;
  assert.equal(c.status, "insufficient");
  assert.equal(c.customerName, "Ahmed Ali");
  assert.equal(c.companyName, "Hormuud");
  assert.equal(c.requestedAmount, 20);
  assert.equal(c.availableBalance, 12);
  assert.equal(c.missingAmount, 8);

  const blocked = await dial(orderId);
  assert.equal(blocked.status, 409);
  const body = (await blocked.json()) as { code: string; error: string };
  assert.equal(body.code, "insufficient_sim_balance");
  assert.match(body.error, /^Insufficient SIM Balance — .*\. The customer requested \$20\.00, but the available SIM balance is only \$12\.00\. The remaining amount needed is \$8\.00\./);
  assert.equal(await attemptCount(orderId), 0, "no dial attempt may be started");

  // Confirming does NOT override an insufficient balance.
  const stillBlocked = await dial(orderId, { confirmUnknownBalance: true });
  assert.equal(stillBlocked.status, 409);
  assert.equal(await attemptCount(orderId), 0);
});

test("sufficient balance: the dial goes ahead exactly as before", async () => {
  await setBalance(25);
  const orderId = await insertOrder(20);
  const c = (await (await check(orderId)).json()) as Record<string, unknown>;
  assert.equal(c.status, "sufficient");
  const res = await dial(orderId);
  assert.equal(res.status, 201);
  assert.equal(await attemptCount(orderId), 1);
  // A retried log of that same attempt is never blocked (it isn't a new dial).
  await query(`UPDATE sim_balances SET balance=0 WHERE device_id=$1`, [DEVICE_ID]);
  const retry = await dial(orderId);
  assert.equal(retry.status, 200);
});

test("unknown balance: refused until the agent confirms, then allowed", async () => {
  const orderId = await insertOrder(20);
  const c = (await (await check(orderId)).json()) as Record<string, unknown>;
  assert.equal(c.status, "unknown");
  assert.equal(c.availableBalance, null);

  const blocked = await dial(orderId);
  assert.equal(blocked.status, 409);
  assert.equal(((await blocked.json()) as { code: string }).code, "sim_balance_unverified");
  assert.equal(await attemptCount(orderId), 0);

  const confirmed = await dial(orderId, { confirmUnknownBalance: true });
  assert.equal(confirmed.status, 201);
});

test("outdated balance: a 2-day-old balance is not trusted, even if it was enough", async () => {
  await setBalance(100, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  const orderId = await insertOrder(20);
  const c = (await (await check(orderId)).json()) as Record<string, unknown>;
  assert.equal(c.status, "outdated");
  const blocked = await dial(orderId);
  assert.equal(blocked.status, 409);
  assert.equal(((await blocked.json()) as { code: string }).code, "sim_balance_unverified");
});

test("an Extra Package needs the balance for every delivery still owed", async () => {
  await setBalance(50);
  const orderId = await insertOrder(20, 3); // 3 x $20 = $60 needed
  const c = (await (await check(orderId)).json()) as Record<string, unknown>;
  assert.equal(c.status, "insufficient");
  assert.equal(c.requestedAmount, 60);
  assert.equal(c.missingAmount, 10);
});

test("other balances on the same SIM (e.g. EVC Plus) are never counted as the company's data balance", async () => {
  await query(
    `INSERT INTO sim_balances (device_id, sim_slot, company_id, provider_key, balance, updated_at, last_source)
     VALUES ($1, 1, NULL, 'evc_plus', 999, now(), 'sms')`,
    [DEVICE_ID]
  );
  const orderId = await insertOrder(20);
  const c = (await (await check(orderId)).json()) as Record<string, unknown>;
  assert.equal(c.status, "unknown");
});

test("after the SIM is recharged and its balance updated, the same order dials normally", async () => {
  await setBalance(12);
  const orderId = await insertOrder(20);
  assert.equal((await dial(orderId)).status, 409);

  // A balance SMS / manual edit records the recharge.
  await query(`UPDATE sim_balances SET balance=32, updated_at=now() WHERE device_id=$1`, [DEVICE_ID]);
  const c = (await (await check(orderId)).json()) as Record<string, unknown>;
  assert.equal(c.status, "sufficient");
  assert.equal(c.missingAmount, 0);
  const retry = await dial(orderId);
  assert.equal(retry.status, 201);
  assert.equal(await attemptCount(orderId), 1);
});

test("the company name in every warning is the order's own company (Hormuud, Somtel, Somnet, Amtel)", async () => {
  for (const name of ["Hormuud", "Somtel", "Somnet", "Amtel"]) {
    await query(`UPDATE companies SET name=$2 WHERE id=$1`, [COMPANY_ID, name]);
    await query(`DELETE FROM sim_balances WHERE device_id=$1`, [DEVICE_ID]);
    await query(
      `INSERT INTO sim_balances (device_id, sim_slot, company_id, provider_key, balance, updated_at, last_source)
       VALUES ($1, 1, $2, $3, 5, now(), 'sms')`,
      [DEVICE_ID, COMPANY_ID, name.toLowerCase()]
    );
    const orderId = await insertOrder(7.5);
    const c = (await (await check(orderId)).json()) as Record<string, any>;
    assert.equal(c.companyName, name);
    assert.equal(c.status, "insufficient", name);
    assert.equal(c.missingAmount, 2.5, name);
    assert.equal(
      c.message,
      `Insufficient SIM Balance — ${name}. The customer requested $7.50, but the available SIM balance is only $5.00. The remaining amount needed is $2.50. Please recharge the ${name} SIM and try again.`
    );
  }
  await query(`UPDATE companies SET name='Hormuud' WHERE id=$1`, [COMPANY_ID]);
});

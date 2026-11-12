// Run against a real local Postgres test database (DATABASE_URL/PGSSL set):
//   npx tsx --test src/routes/__tests__/simRoutingAssignment.test.ts
//
// An order is dialed only by the phone + SIM the Admin assigned
// (utils/orderRouting.ts): never moved to a backup phone, the other SIM, or
// another device -- not when the assigned SIM is offline, has no balance,
// errors or times out. It waits, or needs verification. Other phones keep
// working on their own assignments, and an Admin routing change applies.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ussdRouter, effectiveDialStatus } from "../ussd.routes.js";
import { ordersRouter } from "../orders.routes.js";
import { assignedRouteFor } from "../../utils/orderRouting.js";

const AMTEL = "test-route-amtel";
const HORMUUD = "test-route-hormuud";
const MOBILE_1 = "test-route-mobile-1";
const MOBILE_2 = "test-route-mobile-2";
const AGENT_1 = randomUUID();
const AGENT_2 = randomUUID();
const CUSTOMER_ID = randomUUID();
const CAT_AMTEL = randomUUID();
const CAT_HORMUUD = randomUUID();
const USSD = "*914*711338686*01*1234#";

let pkgAmtel: string;
let pkgHormuud: string;
let token1: string;
let token2: string;

const app = express();
app.use(express.json());
app.use(ussdRouter);
app.use(ordersRouter);
let server: http.Server;
let baseUrl: string;

async function insertOrder(companyId: string, packageId: string): Promise<string> {
  const id = "TESTROUTE" + Math.floor(100000 + Math.random() * 900000);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel, ussd_generated)
     VALUES ($1,$2,$3,$4,0.09,'252610346060','252711338686','in_progress','customer_app',$5)`,
    [id, CUSTOMER_ID, companyId, packageId, USSD]
  );
  await query(
    `INSERT INTO payment_transactions (id, order_id, customer_phone, amount, status) VALUES (gen_random_uuid(),$1,'252610346060',0.09,'pending')`,
    [id]
  );
  return id;
}

async function setBalance(deviceId: string, slot: number, companyId: string, providerKey: string, balance: number) {
  await query(
    `INSERT INTO sim_balances (device_id, sim_slot, company_id, provider_key, balance, updated_at, last_source)
     VALUES ($1,$2,$3,$4,$5, now(), 'sms')`,
    [deviceId, slot, companyId, providerKey, balance]
  );
}

function dial(token: string, orderId: string, simSlot: number, attemptNumber = 1) {
  return fetch(`${baseUrl}/agent/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ simSlot, ussdString: USSD, attemptNumber }),
  });
}

async function report(token: string, attemptId: string, status: string, responseMessage: string | null) {
  return fetch(`${baseUrl}/agent/dial-attempts/${attemptId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status, responseMessage, isFinalAttempt: true }),
  });
}

async function candidates(token: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/agent/orders/self-heal-candidates`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return ((await res.json()) as Array<{ id: string }>).map((o) => o.id);
}

async function routingFor(token: string, deviceId: string) {
  const res = await fetch(`${baseUrl}/agent/sim-routing?deviceId=${deviceId}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()) as Array<{ companyId: string; simSlot: number }>;
}

async function setOnline(deviceId: string, online: boolean) {
  await query(
    `UPDATE agent_devices SET network_online=$2, last_heartbeat_at = CASE WHEN $2 THEN now() ELSE now() - interval '1 hour' END WHERE id=$1`,
    [deviceId, online]
  );
}

async function cleanup() {
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM orders WHERE id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM sim_balance_history WHERE sim_balance_id IN (SELECT id FROM sim_balances WHERE device_id IN ($1,$2))`, [MOBILE_1, MOBILE_2]);
  await query(`DELETE FROM sim_balances WHERE device_id IN ($1,$2)`, [MOBILE_1, MOBILE_2]);
  await query(`DELETE FROM sim_routing WHERE company_id IN ($1,$2)`, [AMTEL, HORMUUD]);
  // The live setup: Amtel -> Mobile 2 SIM 2 (primary) with Mobile 1 SIM 1
  // listed as a backup; Hormuud -> Mobile 1 SIM 1.
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,2,1)`, [AMTEL, MOBILE_2]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,1,2)`, [AMTEL, MOBILE_1]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,1,1)`, [HORMUUD, MOBILE_1]);
  await setOnline(MOBILE_1, true);
  await setOnline(MOBILE_2, true);
  await setBalance(MOBILE_2, 2, AMTEL, "amtel", 10);
  await setBalance(MOBILE_1, 1, AMTEL, "amtel", 10);
  await setBalance(MOBILE_1, 1, HORMUUD, "hormuud", 10);
}

before(async () => {
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM orders WHERE id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM sim_routing WHERE company_id IN ($1,$2)`, [AMTEL, HORMUUD]);
  await query(`DELETE FROM packages WHERE company_id IN ($1,$2)`, [AMTEL, HORMUUD]);
  await query(`DELETE FROM service_categories WHERE id IN ($1,$2)`, [CAT_AMTEL, CAT_HORMUUD]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2)`, [AMTEL, HORMUUD]);
  await query(`DELETE FROM agents WHERE id IN ($1,$2) OR phone IN ('252699101001','252699101002')`, [AGENT_1, AGENT_2]);
  await query(`DELETE FROM agent_devices WHERE id IN ($1,$2)`, [MOBILE_1, MOBILE_2]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone='252610346061'`, [CUSTOMER_ID]);

  await query(`INSERT INTO agent_devices (id, name, enabled, sim1_present, sim2_present) VALUES ($1,'Route Mobile 1',true,true,true),($2,'Route Mobile 2',true,true,true)`, [MOBILE_1, MOBILE_2]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699101001','Agent 1','x',$2),($3,'252699101002','Agent 2','x',$4)`, [AGENT_1, MOBILE_1, AGENT_2, MOBILE_2]);
  token1 = signAccessToken(AGENT_1, "agent");
  token2 = signAccessToken(AGENT_2, "agent");
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,'252610346061','Route Customer')`, [CUSTOMER_ID]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Amtel',2,'#C81E2C'),($2,'Hormuud',1,'#16A34A')`, [AMTEL, HORMUUD]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data'),($3,$4,'data','Data')`, [CAT_AMTEL, AMTEL, CAT_HORMUUD, HORMUUD]);
  pkgAmtel = (await queryOne<{ id: string }>(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Amtel 500MB',0.09) RETURNING id`, [AMTEL, CAT_AMTEL]))!.id;
  pkgHormuud = (await queryOne<{ id: string }>(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'Hormuud 1GB',0.09) RETURNING id`, [HORMUUD, CAT_HORMUUD]))!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(cleanup);

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM orders WHERE id LIKE 'TESTROUTE%'`);
  await query(`DELETE FROM sim_balance_history WHERE sim_balance_id IN (SELECT id FROM sim_balances WHERE device_id IN ($1,$2))`, [MOBILE_1, MOBILE_2]);
  await query(`DELETE FROM sim_balances WHERE device_id IN ($1,$2)`, [MOBILE_1, MOBILE_2]);
  await query(`DELETE FROM sim_routing WHERE company_id IN ($1,$2)`, [AMTEL, HORMUUD]);
  await query(`DELETE FROM packages WHERE company_id IN ($1,$2)`, [AMTEL, HORMUUD]);
  await query(`DELETE FROM service_categories WHERE id IN ($1,$2)`, [CAT_AMTEL, CAT_HORMUUD]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2)`, [AMTEL, HORMUUD]);
  await query(`DELETE FROM agents WHERE id IN ($1,$2)`, [AGENT_1, AGENT_2]);
  await query(`DELETE FROM agent_devices WHERE id IN ($1,$2)`, [MOBILE_1, MOBILE_2]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await pool.end();
});

test("1. an Amtel order assigned to Mobile 2 · SIM 2 is never dialed by Mobile 1 or the other SIM", async () => {
  const order = await insertOrder(AMTEL, pkgAmtel);
  assert.deepEqual(await assignedRouteFor({ company_id: AMTEL }), { deviceId: MOBILE_2, simSlot: 2, source: "sim_routing" });

  // Mobile 1 is only a backup: it isn't offered the order and is refused if it tries.
  assert.ok(!(await candidates(token1)).includes(order));
  const fromMobile1 = await dial(token1, order, 1);
  assert.equal(fromMobile1.status, 409);
  assert.equal(((await fromMobile1.json()) as any).code, "not_assigned_sim");
  // Mobile 2's other SIM is refused too.
  const otherSim = await dial(token2, order, 1);
  assert.equal(((await otherSim.json()) as any).code, "not_assigned_sim");
  // Mobile 1's routing list doesn't contain Amtel at all (backup rows aren't routes).
  assert.ok(!(await routingFor(token1, MOBILE_1)).some((r) => r.companyId === AMTEL));

  // The assigned SIM dials it.
  assert.ok((await candidates(token2)).includes(order));
  assert.equal((await dial(token2, order, 2)).status, 201);
  assert.equal((await query(`SELECT id FROM ussd_dial_attempts WHERE order_id=$1`, [order])).length, 1);
});

test("2. an offline assigned SIM doesn't move the order: it waits for Mobile 2", async () => {
  const order = await insertOrder(AMTEL, pkgAmtel);
  await setOnline(MOBILE_2, false);
  assert.ok(!(await candidates(token1)).includes(order));
  assert.equal(((await (await dial(token1, order, 1)).json()) as any).code, "not_assigned_sim");
  assert.equal((await query(`SELECT id FROM ussd_dial_attempts WHERE order_id=$1`, [order])).length, 0);
  // Still Mobile 2's order the moment it reports in.
  assert.ok((await candidates(token2)).includes(order));
});

test("3. insufficient balance on the assigned SIM blocks the dial and never falls back", async () => {
  const order = await insertOrder(AMTEL, pkgAmtel);
  await query(`UPDATE sim_balances SET balance=0.01 WHERE device_id=$1 AND sim_slot=2`, [MOBILE_2]);
  const blocked = await dial(token2, order, 2);
  assert.equal(blocked.status, 409);
  assert.equal(((await blocked.json()) as any).code, "insufficient_sim_balance");
  // Mobile 1 has plenty of Amtel balance -- still not allowed.
  assert.equal(((await (await dial(token1, order, 1)).json()) as any).code, "not_assigned_sim");
  assert.equal((await query(`SELECT id FROM ussd_dial_attempts WHERE order_id=$1`, [order])).length, 0);
  assert.equal((await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [order]))!.status, "in_progress");
});

test("4. a timeout is 'result unknown', never 'failed', and the order is not dialed again", async () => {
  const order = await insertOrder(AMTEL, pkgAmtel);
  const start = (await (await dial(token2, order, 2)).json()) as { id: string };
  // How the older Agent App reports a USSD timeout: "failed" with no text.
  assert.equal((await report(token2, start.id, "failed", null)).status, 200);
  const attempt = await queryOne<{ status: string }>(`SELECT status FROM ussd_dial_attempts WHERE id=$1`, [start.id]);
  assert.equal(attempt!.status, "ambiguous");
  const o = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [order]);
  assert.equal(o!.status, "in_progress", "the customer isn't told it failed");
  const again = await dial(token2, order, 2, 2);
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as any).code, "previous_attempt_unresolved");

  assert.equal(effectiveDialStatus("failed", "USSD timed out"), "ambiguous");
  assert.equal(effectiveDialStatus("failed", "Insufficient balance"), "failed");
  assert.equal(effectiveDialStatus("failed", "No response from the carrier at step 1 of 5 — nothing was paid."), "failed");
  assert.equal(effectiveDialStatus("success", null), "success");
});

test("5. when the assigned SIM reconnects, its order resumes on that same SIM", async () => {
  const order = await insertOrder(AMTEL, pkgAmtel);
  await setOnline(MOBILE_2, false);
  assert.equal((await query(`SELECT id FROM ussd_dial_attempts WHERE order_id=$1`, [order])).length, 0);
  await setOnline(MOBILE_2, true);
  assert.ok((await candidates(token2)).includes(order));
  assert.equal((await dial(token2, order, 2)).status, 201);
});

test("6. other SIMs keep processing their own orders independently", async () => {
  const amtelOrder = await insertOrder(AMTEL, pkgAmtel);
  const hormuudOrder = await insertOrder(HORMUUD, pkgHormuud);
  await setOnline(MOBILE_2, false);
  const mine = await candidates(token1);
  assert.ok(mine.includes(hormuudOrder));
  assert.ok(!mine.includes(amtelOrder));
  assert.equal((await dial(token1, hormuudOrder, 1)).status, 201);
  // Mobile 2 never sees Mobile 1's Hormuud order.
  assert.ok(!(await candidates(token2)).includes(hormuudOrder));
});

test("7. an Admin routing change moves the order, and the new assignment is respected", async () => {
  const order = await insertOrder(AMTEL, pkgAmtel);
  // Admin makes Mobile 1 · SIM 1 Amtel's primary (what PUT /admin/sim-routing writes).
  await query(`UPDATE sim_routing SET priority=1 WHERE company_id=$1 AND device_id=$2`, [AMTEL, MOBILE_1]);
  await query(`UPDATE sim_routing SET priority=2 WHERE company_id=$1 AND device_id=$2`, [AMTEL, MOBILE_2]);
  assert.ok((await candidates(token1)).includes(order));
  assert.ok(!(await candidates(token2)).includes(order));
  assert.equal(((await (await dial(token2, order, 2)).json()) as any).code, "not_assigned_sim");
  assert.equal((await dial(token1, order, 1)).status, 201);
  assert.ok((await routingFor(token1, MOBILE_1)).some((r) => r.companyId === AMTEL && r.simSlot === 1));
});

test("7b. a template pinned to a device + SIM wins over SIM Routing, and only that SIM dials", async () => {
  const order = await insertOrder(AMTEL, pkgAmtel);
  await query(`UPDATE orders SET ussd_device_id=$2, ussd_sim_slot=1 WHERE id=$1`, [order, MOBILE_2]);
  await setBalance(MOBILE_2, 1, AMTEL, "amtel", 10);
  assert.equal(((await (await dial(token2, order, 2)).json()) as any).code, "not_assigned_sim");
  assert.equal((await dial(token2, order, 1)).status, 201);
});

test("8. a successful dial still completes the order and its payment exactly once", async () => {
  const order = await insertOrder(AMTEL, pkgAmtel);
  const start = (await (await dial(token2, order, 2)).json()) as { id: string };
  assert.equal((await report(token2, start.id, "success", "Your Transfer Airtime to 252711338686 has been successfully processed")).status, 200);
  assert.equal((await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [order]))!.status, "completed");
  const payments = await query<{ status: string }>(`SELECT status FROM payment_transactions WHERE order_id=$1`, [order]);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].status, "completed");
});

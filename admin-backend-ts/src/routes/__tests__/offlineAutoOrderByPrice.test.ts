// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/offlineAutoOrderByPrice.test.ts
//
// Rukumo (Offline Auto-Order) registration names only the sender number,
// the receiver number and the company. The customer picks any of that
// company's services on the phone (even offline) and pays its price; the
// payment's amount decides the service. An older app's saved package still
// works. Never another company's service, and never a guess between two
// services with the same price.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";
import { customersRouter } from "../customers.routes.js";

const AGENT = randomUUID();
const DEVICE = "rukumo-price-device";
const CO = "rukumo-price-co";
const OTHER_CO = "rukumo-price-other";
const PKG_DAY = randomUUID(); // $0.50
const PKG_WEEK = randomUUID(); // $1.75
const PKG_TWIN_A = randomUUID(); // $3.00
const PKG_TWIN_B = randomUUID(); // $3.00
const PKG_OTHER = randomUUID(); // $2.20, other company

const app = express();
app.use(express.json());
app.use(customersRouter);
let server: http.Server;
let base: string;
let n = 0;

async function customerWithProfile(packageId: string | null): Promise<{ id: string; sender: string }> {
  const id = randomUUID();
  const sender = `6155507${String(10 + ++n).padStart(2, "0")}`;
  await query(`INSERT INTO customers (id, phone) VALUES ($1,$2)`, [id, `252${sender}`]);
  await query(
    `UPDATE customers SET offline_sender_number=$1, offline_destination_number='615550799', offline_company_id=$2,
       offline_package_id=$3, offline_profile_updated_at=now() WHERE id=$4`,
    [sender, CO, packageId, id]
  );
  return { id, sender };
}
function pay(sender: string, amount: number) {
  return ingestPaymentSms({
    agentId: AGENT, sender: "192", body: `rukumo-price ${randomUUID()}`,
    parsedProvider: "Hormuud", parsedAmount: amount, parsedPhone: sender, transactionRef: `TX-${randomUUID()}`,
  });
}
const ordersOf = (customerId: string) => query<{ package_id: string; amount: string; channel: string; receiver_phone: string }>(
  `SELECT package_id, amount, channel, receiver_phone FROM orders WHERE customer_id=$1`, [customerId]);

before(async () => {
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Rukumo price phone')`, [DEVICE]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699000188','Rukumo Agent','x',$2)`, [AGENT, DEVICE]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1,'Hormuud',1,'#000000','EVC Plus','61 0000001')`, [CO]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1,'Somtel',2,'#111111','eDahab','62 0000002')`, [OTHER_CO]);
  const cat = randomUUID();
  for (const [id, co, name, price] of [
    [PKG_DAY, CO, "Maalin", 0.5], [PKG_WEEK, CO, "Toddobaad", 1.75],
    [PKG_TWIN_A, CO, "Bil A", 3], [PKG_TWIN_B, CO, "Bil B", 3], [PKG_OTHER, OTHER_CO, "Somtel 5GB", 2.2],
  ] as const) {
    await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,$4,$5)`, [id, co, cat, name, price]);
  }
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("registration needs only sender, receiver and company (no package)", async () => {
  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252615550700')`, [id]);
  const res = await fetch(`${base}/customer/offline-profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signAccessToken(id, "customer")}` },
    body: JSON.stringify({ senderNumber: "615550700", destinationNumber: "615550701", companyId: CO }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as any;
  assert.equal(body.company.id, CO);
  assert.equal(body.package, null);
});

test("without a saved package, the amount paid picks the company's service", async () => {
  const c = await customerWithProfile(null);
  const r1 = await pay(c.sender, 1.75);
  assert.ok(r1.body.matchedOrderId, JSON.stringify(r1.body));
  const r2 = await pay(c.sender, 0.5);
  assert.ok(r2.body.matchedOrderId);
  const orders = await ordersOf(c.id);
  assert.deepEqual(orders.map((o) => o.package_id).sort(), [PKG_DAY, PKG_WEEK].sort());
  assert.ok(orders.every((o) => o.channel === "offline_auto" && o.receiver_phone === "615550799"));
});

test("an amount no service of the registered company costs creates nothing", async () => {
  const c = await customerWithProfile(null);
  const r = await pay(c.sender, 2.2); // the OTHER company's price
  assert.equal(r.body.matchedOrderId, null);
  assert.equal((await ordersOf(c.id)).length, 0, "never another company's service");
});

test("two services with the same price: no guess, left for an agent", async () => {
  const c = await customerWithProfile(null);
  const r = await pay(c.sender, 3);
  assert.equal(r.body.matchedOrderId, null);
  assert.equal((await ordersOf(c.id)).length, 0);
  const sms = await queryOne<{ match_failure_reason: string }>(`SELECT match_failure_reason FROM sms_logs WHERE parsed_phone=$1`, [c.sender]);
  assert.match(sms!.match_failure_reason ?? "", /agent must choose/);
});

test("an older app's saved package still works, and settles a same-price tie", async () => {
  const c = await customerWithProfile(PKG_TWIN_B);
  const r = await pay(c.sender, 3);
  assert.ok(r.body.matchedOrderId);
  assert.deepEqual((await ordersOf(c.id)).map((o) => o.package_id), [PKG_TWIN_B]);
  // ...and paying another service's price now buys that service.
  await pay(c.sender, 0.5);
  assert.ok((await ordersOf(c.id)).some((o) => o.package_id === PKG_DAY));
});

test("admins see each company's services that share a price", async () => {
  const { offlineAdminRouter } = await import("../offlineAdmin.routes.js");
  const admin = express();
  admin.use(express.json());
  admin.use(offlineAdminRouter);
  const s = http.createServer(admin as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => s.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/admin/offline/price-conflicts`, {
      headers: { Authorization: `Bearer ${signAccessToken(randomUUID(), "super_admin")}` },
    });
    assert.equal(res.status, 200);
    const rows = (await res.json()) as any[];
    const mine = rows.filter((r) => r.companyId === CO);
    assert.deepEqual(mine, [{ companyId: CO, companyName: "Hormuud", price: 3, services: ["Bil A", "Bil B"] }]);
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});

test("several accounts with the same payment number: the newest saved setup is used, not refused", async () => {
  const sender = "615550790";
  const older = randomUUID();
  const newer = randomUUID();
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252615550791'), ($2,'252615550792')`, [older, newer]);
  await query(
    `UPDATE customers SET offline_sender_number=$1, offline_destination_number='615550793', offline_company_id=$2,
       offline_profile_updated_at=now() - interval '2 days' WHERE id=$3`,
    [sender, CO, older]
  );
  await query(
    `UPDATE customers SET offline_sender_number=$1, offline_destination_number='615550794', offline_company_id=$2,
       offline_profile_updated_at=now() WHERE id=$3`,
    [sender, CO, newer]
  );
  const r = await pay(sender, 1.75);
  assert.ok(r.body.matchedOrderId, JSON.stringify(r.body));
  assert.equal((await ordersOf(older)).length, 0);
  const o = await ordersOf(newer);
  assert.equal(o.length, 1);
  assert.equal(o[0].receiver_phone, "615550794", "sent to the newest setup's internet number");
});

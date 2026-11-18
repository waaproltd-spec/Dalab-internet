// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/agentSchedule.test.ts
//
// Agent "Schedule Transaction": a scheduled order is never sent before its
// time, a payment is never lost or applied twice, and at the time a paid
// order is sent automatically (an unpaid one waits for its payment).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { ordersRouter, releaseDueScheduledOrders } from "../orders.routes.js";
import { resweepUnmatchedSmsLogs } from "../smsLogs.routes.js";
import { createPaymentTransaction } from "../../utils/paymentTransactions.js";

const app = express();
app.use(express.json());
app.use(ordersRouter);

let server: http.Server;
let base: string;
const AGENT = randomUUID();
const PACKAGE = randomUUID();
let token: string;
let price = 2;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const row = (id: string) => queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [id]);
let phoneN = 0;
const newPhone = () => `6155506${String(10 + ++phoneN).padStart(2, "0")}`;

/** A fresh package price per test, so payments of one test never match another's order. */
async function freshPackage(): Promise<string> {
  const id = randomUUID();
  price += 0.25;
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,'hormuud','internet',$2,$3)`, [id, `Sched ${price}`, price]);
  return id;
}
function schedule(pkg: string, phone: string, extra: Record<string, unknown> = {}) {
  return call("POST", "/agent/scheduled-orders", {
    customerName: "Abdirizak Mohamed", customerPhone: phone, companyId: "hormuud", packageId: pkg,
    receiverPhone: phone, scheduledAt: inMinutes(30), paymentMode: "pay_at_execution", ...extra,
  });
}
/** The customer's payment SMS reaching an agent phone, then the matcher's sweep. */
async function customerPays(phone: string, amount: number) {
  const sms = randomUUID();
  await query(
    `INSERT INTO sms_logs (id, agent_id, sender, body, parsed_amount, parsed_phone, received_at) VALUES ($1::uuid,$2,'192','paid ' || $1::text,$3,$4,now())`,
    [sms, AGENT, amount, phone]
  );
  // Upload creates the payment's ledger row; matching links it to the order.
  await createPaymentTransaction({ smsLogId: sms, orderId: null, transactionRef: null, customerPhone: phone, amount, paymentTimestamp: new Date().toISOString(), status: "pending" });
  await resweepUnmatchedSmsLogs();
}
const due = (id: string) => query(`UPDATE orders SET scheduled_at = now() - interval '1 second' WHERE id=$1`, [id]);

before(async () => {
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'615550601','Schedule Agent','x')`, [AGENT]);
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,'hormuud','internet','Anfac',0.09)`, [PACKAGE]);
  // Payments for this network are processed automatically (on systems where a company can require manual approval).
  const auto = await queryOne(`SELECT 1 FROM information_schema.columns WHERE table_name='companies' AND column_name='auto_process_enabled'`);
  if (auto) await query(`UPDATE companies SET auto_process_enabled=true WHERE id='hormuud'`);
  token = signAccessToken(AGENT, "agent");
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("options list the network with its packages", async () => {
  const r = await call("GET", "/agent/scheduled-orders/options");
  assert.equal(r.status, 200);
  const hormuud = r.body.companies.find((c: any) => c.id === "hormuud");
  assert.ok(hormuud.packages.some((p: any) => p.id === PACKAGE && p.price === 0.09));
});

test("registering: the customer is saved with the name, and the order waits for its time", async () => {
  const phone = newPhone();
  const r = await schedule(PACKAGE, phone, { receiverPhone: "615550699", note: "VIP" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = await row(r.body.id);
  assert.equal(o.status, "pending");
  assert.equal(o.payment_mode, "pay_at_execution");
  assert.equal(o.sender_phone, phone);
  assert.equal(o.receiver_phone, "615550699");
  assert.equal(o.schedule_note, "VIP");
  assert.equal(o.scheduled_paid_at, null);
  assert.equal(r.body.customerName, "Abdirizak Mohamed");
  const listed = await call("GET", "/agent/scheduled-orders");
  assert.ok(listed.body.some((x: any) => x.id === r.body.id));
});

test("pay at execution, paid early: held (not sent) until the time, then sent automatically", async () => {
  const pkg = await freshPackage();
  const phone = newPhone();
  const { body } = await schedule(pkg, phone);
  await customerPays(phone, price);
  let o = await row(body.id);
  assert.equal(o.status, "pending", "not sent before its time");
  assert.ok(o.scheduled_paid_at, "payment recorded");
  assert.equal(o.ussd_generated, null, "nothing to dial yet");
  assert.equal((await query(`SELECT 1 FROM payment_transactions WHERE order_id=$1`, [body.id])).length, 1);

  assert.equal(await releaseDueScheduledOrders(), 0, "not due yet");
  await due(body.id);
  await releaseDueScheduledOrders();
  o = await row(body.id);
  assert.equal(o.status, "in_progress", "sent at its time");
});

test("a second payment of the same amount is never applied to an already-paid scheduled order", async () => {
  const pkg = await freshPackage();
  const phone = newPhone();
  const { body } = await schedule(pkg, phone);
  await customerPays(phone, price);
  await customerPays(phone, price);
  const linked = await query(`SELECT id FROM sms_logs WHERE matched_order_id=$1`, [body.id]);
  assert.equal(linked.length, 1, "only the first payment is linked");
  const tx = await query(`SELECT status FROM payment_transactions WHERE order_id=$1`, [body.id]);
  assert.equal(tx.length, 1);
});

test("pay at execution, not paid at the time: waits, then is sent the moment the payment arrives", async () => {
  const pkg = await freshPackage();
  const phone = newPhone();
  const { body } = await schedule(pkg, phone);
  await due(body.id);
  await releaseDueScheduledOrders();
  assert.equal((await row(body.id)).status, "pending", "waits for the payment");
  // Registered days ago: still matched (scheduled orders aren't limited to 24h since creation).
  await query(`UPDATE orders SET created_at = now() - interval '3 days', updated_at = now() - interval '3 days' WHERE id=$1`, [body.id]);
  await customerPays(phone, price);
  assert.equal((await row(body.id)).status, "in_progress");
});

test("prepaid: payment recorded now, held until the time; Run now sends it at once", async () => {
  const pkg = await freshPackage();
  const r = await schedule(pkg, newPhone(), { paymentMode: "prepaid" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let o = await row(r.body.id);
  assert.equal(o.status, "pending");
  assert.ok(o.scheduled_paid_at);
  assert.equal((await query(`SELECT 1 FROM payment_transactions WHERE order_id=$1`, [r.body.id])).length, 1);
  const logs = await query<{ action: string }>(`SELECT action FROM admin_activity_log WHERE entity_id=$1 AND agent_id=$2`, [r.body.id, AGENT]);
  assert.ok(logs.some((l) => l.action === "agent_order_scheduled"));

  const now = await call("POST", `/agent/scheduled-orders/${r.body.id}/run-now`, {});
  assert.equal(now.status, 200, JSON.stringify(now.body));
  o = await row(r.body.id);
  assert.equal(o.status, "in_progress");
  const again = await call("POST", `/agent/scheduled-orders/${r.body.id}/run-now`, {});
  assert.equal(again.status, 409);
});

test("a held scheduled order can be cancelled; it is then never sent", async () => {
  const pkg = await freshPackage();
  const { body } = await schedule(pkg, newPhone(), { paymentMode: "prepaid" });
  const c = await call("POST", `/agent/orders/${body.id}/cancel`, { reason: "customer changed mind" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  await due(body.id);
  await releaseDueScheduledOrders();
  assert.equal((await row(body.id)).status, "cancelled");
});

test("bad input is refused", async () => {
  const phone = newPhone();
  assert.equal((await schedule(PACKAGE, phone, { scheduledAt: inMinutes(-10) })).status, 400, "time passed");
  assert.equal((await schedule(PACKAGE, phone, { scheduledAt: inMinutes(61 * 24 * 60) })).status, 400, "too far ahead");
  assert.equal((await schedule(PACKAGE, phone, { customerName: " " })).status, 400, "no name");
  assert.equal((await schedule(PACKAGE, phone, { paymentMode: "later" })).status, 400, "no payment mode");
  assert.equal((await schedule(PACKAGE, "12")).status, 400, "bad phone");
});

test("an agent whose operational access is off can't schedule", async () => {
  await query(`UPDATE agents SET operations_enabled=false WHERE id=$1`, [AGENT]);
  try {
    assert.equal((await schedule(PACKAGE, newPhone())).status, 403);
  } finally {
    await query(`UPDATE agents SET operations_enabled=true WHERE id=$1`, [AGENT]);
  }
});

test("customer Schedule: the customer picks a time at checkout, pays now, and it is sent at that time", async () => {
  const pkg = await freshPackage();
  const cust = randomUUID();
  const phone = newPhone();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Schedule Customer')`, [cust, phone]);
  const ctoken = signAccessToken(cust, "customer");
  const order = (body: Record<string, unknown>) =>
    fetch(`${base}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctoken}` },
      body: JSON.stringify({ companyId: "hormuud", packageId: pkg, senderPhone: phone, receiverPhone: phone, clientRequestId: randomUUID(), ...body }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  assert.equal((await order({ scheduledAt: inMinutes(-10) })).status, 400, "time passed");
  assert.equal((await order({ scheduledAt: inMinutes(61 * 24 * 60) })).status, 400, "too far ahead");

  const r = await order({ scheduledAt: inMinutes(45) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok((await row(r.body.id)).scheduled_at, "scheduled");
  await customerPays(phone, price);
  let o = await row(r.body.id);
  assert.equal(o.status, "pending", "paid but held until its time");
  assert.ok(o.scheduled_paid_at);
  await due(r.body.id);
  await releaseDueScheduledOrders();
  o = await row(r.body.id);
  assert.equal(o.status, "in_progress", "sent at its time");

  // Without a time: exactly today's behaviour (sent as soon as paid).
  const now = await order({});
  assert.equal(now.status, 201);
  assert.equal((await row(now.body.id)).scheduled_at, null);
});

test("customer Schedule: unpaid at its time is never sent; paid is sent exactly once even if released twice at once", async () => {
  const pkg = await freshPackage();
  const cust = randomUUID();
  const phone = newPhone();
  await query(`INSERT INTO customers (id, phone) VALUES ($1,$2)`, [cust, phone]);
  const res = await fetch(`${base}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signAccessToken(cust, "customer")}` },
    body: JSON.stringify({ companyId: "hormuud", packageId: pkg, senderPhone: phone, receiverPhone: phone, clientRequestId: randomUUID(), scheduledAt: inMinutes(30) }),
  });
  const { id } = (await res.json()) as any;

  // Time reached, no payment: nothing is sent.
  await due(id);
  assert.equal(await releaseDueScheduledOrders(), 0);
  let o = await row(id);
  assert.equal(o.status, "pending");
  assert.equal(o.ussd_generated, null, "nothing to dial without a verified payment");

  // Payment verified after the time: sent once. Two releases racing never send it twice.
  await customerPays(phone, price);
  const [a, b] = await Promise.all([releaseDueScheduledOrders(), releaseDueScheduledOrders()]);
  assert.ok(a + b <= 1, `released ${a + b} times`);
  o = await row(id);
  assert.equal(o.status, "in_progress");
  assert.equal((await query(`SELECT 1 FROM payment_transactions WHERE order_id=$1`, [id])).length, 1, "one payment record");
  assert.equal(await releaseDueScheduledOrders(), 0, "never sent again");
});

test("customer Schedule: the same checkout sent twice (retry) is one order", async () => {
  const pkg = await freshPackage();
  const cust = randomUUID();
  const phone = newPhone();
  await query(`INSERT INTO customers (id, phone) VALUES ($1,$2)`, [cust, phone]);
  const body = JSON.stringify({ companyId: "hormuud", packageId: pkg, senderPhone: phone, receiverPhone: phone, clientRequestId: randomUUID(), scheduledAt: inMinutes(30) });
  const post = () => fetch(`${base}/orders`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${signAccessToken(cust, "customer")}` }, body }).then((r) => r.json() as any);
  const [x, y] = [await post(), await post()];
  assert.equal(x.id, y.id);
  assert.equal((await query(`SELECT 1 FROM orders WHERE customer_id=$1`, [cust])).length, 1);
});

test("Prepaid, then the customer also pays by EVC: one delivery only, never a second (Rukumo) order", async () => {
  const pkg = await freshPackage();
  const phone = newPhone();
  const r = await schedule(pkg, phone, { paymentMode: "prepaid", receiverPhone: "615550698" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // The same customer also has a Rukumo setup for this company.
  const cust = (await row(r.body.id)).customer_id;
  await query(
    `UPDATE customers SET offline_sender_number=$1, offline_destination_number=$1, offline_company_id='hormuud', offline_profile_updated_at=now() WHERE id=$2`,
    [phone, cust]
  );
  await customerPays(phone, price);
  const orders = await query<{ id: string }>(`SELECT id FROM orders WHERE customer_id=$1`, [cust]);
  assert.deepEqual(orders.map((o) => o.id), [r.body.id], "no second order created from the payment");
  const sms = await queryOne<{ matched_order_id: string }>(`SELECT matched_order_id FROM sms_logs WHERE parsed_phone=$1`, [phone]);
  assert.equal(sms!.matched_order_id, r.body.id, "the payment is linked to the scheduled order");
  assert.equal((await row(r.body.id)).status, "pending", "still held until its time");
  await due(r.body.id);
  await releaseDueScheduledOrders();
  assert.equal((await row(r.body.id)).status, "in_progress", "sent once, at its time");
});

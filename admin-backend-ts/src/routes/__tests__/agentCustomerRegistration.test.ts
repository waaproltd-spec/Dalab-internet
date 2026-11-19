// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/agentCustomerRegistration.test.ts
//
// Agent Customer Registration: an agent registers a customer with four
// details (name, payment sender, internet receiver, network: Hormuud,
// Somnet, Somtel or Amtel). The customer pays from the sender number; the payment
// SMS goes through the real pipeline (ingestPaymentSms -> Rukumo), which
// verifies it and only then creates the order for the receiver number on
// that network. A payment that can't be matched creates nothing and is
// reported to the agent and the admins.
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
import { agentRegistrationsRouter } from "../agentRegistrations.routes.js";

const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const DEVICE = `agent-reg-${randomUUID()}`;
const HORMUUD = `agentreg-hormuud-${randomUUID().slice(0, 8)}`;
const AMTEL = `agentreg-amtel-${randomUUID().slice(0, 8)}`;
const PKG_DAY = randomUUID(); // $0.50
const PKG_WEEK = randomUUID(); // $1.75
const ADMIN = randomUUID();

const app = express();
app.use(express.json());
app.use(agentRegistrationsRouter);
let server: http.Server;
let base: string;
const agentToken = signAccessToken(AGENT, "agent");
const otherToken = signAccessToken(OTHER_AGENT, "agent");
const adminToken = signAccessToken(ADMIN, "super_admin");

function call(method: string, p: string, body?: unknown, token = agentToken) {
  return fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));
}
const register = (b: Record<string, unknown>, token = agentToken) => call("POST", "/agent/registered-customers", b, token);
function pay(sender: string, amount: number, ref = `TX-${randomUUID()}`) {
  return ingestPaymentSms({
    agentId: AGENT, sender: "192", body: `agent-reg ${randomUUID()}`,
    parsedProvider: "Hormuud", parsedAmount: amount, parsedPhone: sender, transactionRef: ref,
  });
}

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,'x','super_admin')`, [ADMIN, `reg-${ADMIN}@example.com`]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Agent reg phone')`, [DEVICE]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699000301','Reg Agent','x',$2)`, [AGENT, DEVICE]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699000302','Other Agent','x')`, [OTHER_AGENT]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number) VALUES ($1,'Hormuud',1,'#16A34A','EVC Plus','610000001')`, [HORMUUD]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Amtel',2,'#C81E2C')`, [AMTEL]);
  const cat = randomUUID();
  await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,'Maalin',0.5),($4,$2,$3,'Toddobaad',1.75)`, [PKG_DAY, HORMUUD, cat, PKG_WEEK]);
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("an agent registers a customer with name, sender, receiver and network", async () => {
  const r = await register({ name: "Faadumo Cali", senderPhone: "615552001", receiverPhone: "615552002", companyId: HORMUUD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.equal(r.body.name, "Faadumo Cali");
  assert.equal(r.body.registeredByAgentId, AGENT);
  assert.equal(r.body.companyId, HORMUUD);
  const c = await queryOne<any>(`SELECT phone, offline_sender_number, offline_destination_number, offline_company_id, offline_package_id FROM customers WHERE id=$1`, [r.body.id]);
  assert.deepEqual(
    [c.offline_sender_number, c.offline_destination_number, c.offline_company_id, c.offline_package_id],
    ["252615552001", "252615552002", HORMUUD, null]
  );
  const log = await queryOne(`SELECT 1 FROM admin_activity_log WHERE action='agent_registered_customer' AND entity_id=$1`, [r.body.id]);
  assert.ok(log, "registration is in the Activity Log");
});

test("Hormuud, Somnet, Somtel or Amtel only; the receiver must be a number of that network; a name is required", async () => {
  const amtel = await register({ name: "Amtel Customer", senderPhone: "615552013", receiverPhone: "715552014", companyId: AMTEL });
  assert.equal(amtel.status, 201, JSON.stringify(amtel.body));
  assert.equal(amtel.body.receiverNumber, "252715552014");
  assert.equal((await register({ name: "X Y", senderPhone: "615552015", receiverPhone: "615552016", companyId: AMTEL })).body.code, "invalid_receiver", "an Amtel receiver must be a 71 number");
  assert.equal((await register({ name: "X Y", senderPhone: "615552011", receiverPhone: "615552012", companyId: "no-such-network" })).body.code, "network_not_allowed");
  assert.equal((await register({ name: "X Y", senderPhone: "615552011", receiverPhone: "625552012", companyId: HORMUUD })).body.code, "invalid_receiver");
  assert.equal((await register({ name: "X Y", senderPhone: "12", receiverPhone: "615552012", companyId: HORMUUD })).body.code, "invalid_sender");
  assert.equal((await register({ name: "", senderPhone: "615552011", receiverPhone: "615552012", companyId: HORMUUD })).body.code, "name_required");
});

test("the customer pays: the payment is verified and only then the order is created for the receiver number", async () => {
  const reg = (await register({ name: "Axmed Nuur", senderPhone: "615552101", receiverPhone: "615552102", companyId: HORMUUD })).body;
  const ref = `TX-${randomUUID()}`;
  await pay("615552101", 1.75, ref);
  const orders = await query<any>(`SELECT id, package_id, amount, receiver_phone, company_id, channel FROM orders WHERE customer_id=$1`, [reg.id]);
  assert.equal(orders.length, 1);
  assert.deepEqual(
    [orders[0].package_id, Number(orders[0].amount), orders[0].receiver_phone, orders[0].company_id, orders[0].channel],
    [PKG_WEEK, 1.75, "252615552102", HORMUUD, "offline_auto"]
  );
  // The same transaction again is never a second order.
  await pay("615552101", 1.75, ref);
  assert.equal((await query(`SELECT 1 FROM orders WHERE customer_id=$1`, [reg.id])).length, 1, "no duplicate");

  // A payment row without the transaction ID (e.g. one created when sending
  // started): the order still shows the ID from its matched payment SMS.
  await query(`UPDATE payment_transactions SET transaction_ref=NULL WHERE order_id=$1`, [orders[0].id]);
  const mine = await call("GET", `/agent/registered-customers/${reg.id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.orders.length, 1);
  assert.equal(mine.body.orders[0].transactionRef, ref, "the payment's transaction ID");
  assert.equal(mine.body.paymentMethod, undefined, "no pay-to card");
  assert.equal(mine.body.orders[0].paymentState, "paid");
  assert.ok(["waiting", "sending"].includes(mine.body.orders[0].deliveryState), "paid, not yet delivered");
});

test("a payment that matches no service creates nothing, and is reported to the agent and the admins", async () => {
  const reg = (await register({ name: "Hodan Xasan", senderPhone: "615552201", receiverPhone: "615552202", companyId: HORMUUD })).body;
  const ref = `TX-${randomUUID()}`;
  await pay("615552201", 0.77, ref);
  assert.equal((await query(`SELECT 1 FROM orders WHERE customer_id=$1`, [reg.id])).length, 0, "no internet without a verified match");
  const issues = (await call("GET", "/agent/registered-payment-issues")).body.filter((i: any) => i.customerId === reg.id);
  assert.equal(issues.length, 1);
  assert.equal(Number(issues[0].amount), 0.77);
  assert.equal(issues[0].transactionRef, ref);
  assert.match(issues[0].reason, /No available service/);
  await pay("615552201", 0.77, ref);
  assert.equal((await call("GET", "/agent/registered-payment-issues")).body.filter((i: any) => i.customerId === reg.id).length, 1, "reported once");
  const log = await queryOne(`SELECT 1 FROM admin_activity_log WHERE action='agent_registration_payment_failed' AND entity_id=$1`, [reg.id]);
  assert.ok(log);

  // The admin sees it and resolves it.
  const open = (await call("GET", "/admin/agent-registrations/payment-issues", undefined, adminToken)).body;
  const issue = open.find((i: any) => i.customerId === reg.id);
  assert.ok(issue);
  const done = await call("PUT", `/admin/agent-registrations/payment-issues/${issue.id}/resolve`, {}, adminToken);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(!(await call("GET", "/admin/agent-registrations/payment-issues", undefined, adminToken)).body.some((i: any) => i.customerId === reg.id));
});

test("payments of customers nobody registered are not reported", async () => {
  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone, offline_sender_number, offline_destination_number, offline_company_id, offline_profile_updated_at) VALUES ($1,'252615552301','252615552301','252615552302',$2, now())`, [id, HORMUUD]);
  await pay("615552301", 0.77);
  assert.equal((await query(`SELECT 1 FROM agent_registration_payment_issues WHERE customer_id=$1`, [id])).length, 0);
});

test("each agent sees only the customers they registered; admins see all, with the agent", async () => {
  await register({ name: "Other's Customer", senderPhone: "615552401", receiverPhone: "615552402", companyId: HORMUUD }, otherToken);
  const mine = (await call("GET", "/agent/registered-customers")).body;
  assert.ok(mine.length >= 3);
  assert.ok(mine.every((c: any) => c.registeredByAgentId === AGENT));
  const others = (await call("GET", "/agent/registered-customers", undefined, otherToken)).body;
  assert.deepEqual(others.map((c: any) => c.name), ["Other's Customer"]);
  assert.equal((await call("GET", `/agent/registered-customers/${mine[0].id}`, undefined, otherToken)).status, 404);

  const all = (await call("GET", "/admin/agent-registrations", undefined, adminToken)).body;
  assert.ok(all.registrations.length >= 4);
  assert.ok(all.registrations.some((c: any) => c.agentName === "Other Agent"));
  assert.ok(all.totals.registrations >= 4);
  const byAgent = (await call("GET", `/admin/agent-registrations?agentId=${OTHER_AGENT}`, undefined, adminToken)).body;
  assert.deepEqual(byAgent.registrations.map((c: any) => c.name), ["Other's Customer"]);
  const tx = (await call("GET", `/admin/agent-registrations/transactions?agentId=${AGENT}`, undefined, adminToken)).body;
  assert.ok(tx.length >= 1);
  assert.ok(tx.every((o: any) => o.agentId === AGENT));
  const history = (await call("GET", "/agent/registered-transactions")).body;
  assert.ok(history.length >= 1);
  assert.ok(history[0].transactionRef, "every order carries its transaction ID");
});

test("registering again updates the same customer (same payment number)", async () => {
  const again = await register({ name: "Faadumo Cali", senderPhone: "615552001", receiverPhone: "615552099", companyId: HORMUUD });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.receiverNumber, "252615552099");
  assert.equal((await query(`SELECT 1 FROM customers WHERE RIGHT(phone, 9)='615552001'`)).length, 1, "no second customer");
});

test("only agents register; only staff see the admin view", async () => {
  const customer = signAccessToken(randomUUID(), "customer");
  assert.equal((await register({ name: "A B", senderPhone: "615552501", receiverPhone: "615552502", companyId: HORMUUD }, customer)).status, 403);
  assert.equal((await call("GET", "/admin/agent-registrations", undefined, agentToken)).status, 403);
});

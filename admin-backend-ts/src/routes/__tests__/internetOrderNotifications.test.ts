// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/internetOrderNotifications.test.ts
//
// Regression coverage for a real production complaint: customers were
// getting repeated "⏳ Lacag-bixintu way socotaa" (still processing) push
// notifications for the SAME Internet order, and in some paths could also
// get the same final success/failure notification more than once. Root
// cause traced to two separate things:
//
// 1. An intermediate "processing" notification was sent on every genuine
//    pending->in_progress transition (verifyOrderAndGenerateUssd, and the
//    admin "Start Processing" route) -- but a single order can legitimately
//    pass through that transition more than once over its lifetime (e.g. a
//    failed dial gets manually/automatically retried, landing back at
//    in_progress), so a per-transition notification is a repeat
//    notification from the customer's point of view. Fix: removed the
//    intermediate notification entirely -- a customer now only ever gets
//    the one final success or failure push.
//
// 2. Two of the four "final" notification call sites had gaps in their own
//    duplicate-prevention:
//      - PUT /admin/orders/:id/status's failed/cancelled branch had NO
//        compare-and-swap guard at all on the UPDATE before sending the
//        notification -- a double-submit or retried request re-setting the
//        same status sent the failure notification twice.
//      - The USSD exhausted-retries failure path (PUT
//        /agent/dial-attempts/:attemptId) guarded its UPDATE against an
//        already-'completed' order but not an already-'failed' one, so a
//        second independent exhausted-retries report for the same order
//        re-sent the failure notification.
//
// Both are fixed with the same pattern every other double-fire-sensitive
// branch in this file already uses: UPDATE ... WHERE status differs from
// the target, RETURNING id, and only notify when a row actually came back.
//
// 3. Separately (found while verifying the above fix against a real live
//    order, DLB336495502): PUT /agent/dial-attempts/:attemptId's own
//    success branch -- a successful USSD dial completing the order, the
//    single most common way a real Internet order ever completes -- never
//    called notifyCustomer at all. completeOrderById's success notification
//    only covers the OTHER completion paths (admin manual complete,
//    SOMLINK, voucher-confirmation corroboration), so a customer whose
//    order completed via this exact branch got zero notifications, not a
//    duplicate but a complete absence. Fixed by adding the same approved
//    success notification here too, gated on `completed.length > 0` exactly
//    like every other side effect in that branch.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken, encrypt } from "../../auth/crypto.js";
import { ordersRouter } from "../orders.routes.js";
import { ussdRouter } from "../ussd.routes.js";

const COMPANY_ID = "test-internet-notif-co";
const CATEGORY_ID = randomUUID();
const CUSTOMER_PHONE = "252619991300";
const AGENT_PHONE = "252699001300";

let CUSTOMER_ID: string;
const AGENT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const DEVICE_ID = "test-internet-notif-device";

let packageId: string;
let agentToken: string;
let adminToken: string;
const app = express();
app.use(express.json());
app.use(ordersRouter);
app.use(ussdRouter);
let server: http.Server;
let baseUrl: string;

function makeOrderId(): string {
  return "TESTNOTIF" + Math.floor(100000000 + Math.random() * 900000000);
}

async function insertPendingOrder(): Promise<string> {
  const id = makeOrderId();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, sender_phone, receiver_phone, status, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','customer_app')`,
    [id, CUSTOMER_ID, COMPANY_ID, packageId, 5, CUSTOMER_PHONE, CUSTOMER_PHONE]
  );
  return id;
}

function verifyPayment(orderId: string) {
  return fetch(`${baseUrl}/agent/orders/${orderId}/verify-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ smsLogId: null }),
  });
}

function setStatus(orderId: string, status: string) {
  return fetch(`${baseUrl}/admin/orders/${orderId}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status }),
  });
}

function completeAsAgent(orderId: string) {
  return fetch(`${baseUrl}/agent/orders/${orderId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
  });
}

function reportDialAttempt(attemptId: string, status: string, isFinalAttempt: boolean) {
  return fetch(`${baseUrl}/agent/dial-attempts/${attemptId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ status, isFinalAttempt }),
  });
}

async function insertDialAttempt(orderId: string, attemptNumber: number): Promise<string> {
  return (
    await queryOne<{ id: string }>(
      `INSERT INTO ussd_dial_attempts (order_id, agent_id, ussd_string, attempt_number, status)
       VALUES ($1,$2,'*000*test#',$3,'pending') RETURNING id`,
      [orderId, AGENT_ID, attemptNumber]
    )
  )!.id;
}

async function orderUpdateNotifications(customerId: string) {
  return query<{ title: string; body: string }>(
    `SELECT title, body FROM notifications WHERE customer_id=$1 AND type='order_update' ORDER BY sent_at ASC`,
    [customerId]
  );
}

before(async () => {
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTNOTIF%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTNOTIF%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE phone=$1`, [CUSTOMER_PHONE]);
  await query(`DELETE FROM agents WHERE id=$1 OR device_id=$2 OR phone=$3`, [AGENT_ID, DEVICE_ID, AGENT_PHONE]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1 OR email=$2`, [ADMIN_ID, "internet-notif-test-admin@example.com"]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Test Internet Notif Co',1,'#000000',$2)`, [
    COMPANY_ID,
    encrypt("8233"),
  ]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  const templateId = (
    await queryOne<{ id: string }>(
      `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status) VALUES (gen_random_uuid(),$1,'Test Package','*727*{number}*{amount}*{pin}#','enabled') RETURNING id`,
      [COMPANY_ID]
    )
  )!.id;
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, ussd_template_id) VALUES (gen_random_uuid(),$1,$2,'Test Package',5,$3) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID, templateId]
    )
  )!.id;
  CUSTOMER_ID = (await queryOne<{ id: string }>(`INSERT INTO customers (id, phone) VALUES (gen_random_uuid(),$1) RETURNING id`, [CUSTOMER_PHONE]))!
    .id;
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Test Internet Notif Device')`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,$2,'Test Agent','x',$3)`, [
    AGENT_ID,
    AGENT_PHONE,
    DEVICE_ID,
  ]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'internet-notif-test-admin@example.com','x','super_admin')`, [
    ADMIN_ID,
  ]);

  agentToken = signAccessToken(AGENT_ID, "agent");
  adminToken = signAccessToken(ADMIN_ID, "super_admin");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await query(`DELETE FROM notifications WHERE customer_id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTNOTIF%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTNOTIF%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
});

after(async () => {
  // fetch()'s keep-alive pool can leave a socket open indefinitely, which
  // makes a plain server.close() hang forever waiting for it -- force any
  // lingering connections closed first.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await query(`DELETE FROM notifications WHERE customer_id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTNOTIF%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTNOTIF%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [ADMIN_ID]);
  await pool.end();
});

test("verify-payment's pending -> in_progress transition sends no intermediate 'processing' notification", async () => {
  const orderId = await insertPendingOrder();
  const res = await verifyPayment(orderId);
  assert.equal(res.status, 200);

  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "in_progress");

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.deepEqual(notifications, [], "no notification should be sent for a payment still being processed");
});

test("admin 'Start Processing' pending -> in_progress transition sends no intermediate 'processing' notification", async () => {
  const orderId = await insertPendingOrder();
  const res = await setStatus(orderId, "in_progress");
  assert.equal(res.status, 200);

  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "in_progress");

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.deepEqual(notifications, [], "no notification should be sent for a payment still being processed");
});

test("marking an order failed twice via the admin status route sends the failure notification exactly once, with the approved copy", async () => {
  const orderId = await insertPendingOrder();
  await setStatus(orderId, "in_progress");

  const first = await setStatus(orderId, "failed");
  assert.equal(first.status, 200);
  const second = await setStatus(orderId, "failed");
  assert.equal(second.status, 200);

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.equal(notifications.length, 1, `expected exactly one failure notification, got ${notifications.length}`);
  assert.equal(notifications[0].title, "⚠️ Lacag-bixintu way ciladeysatay");
  assert.equal(
    notifications[0].body,
    "Macmiil, lacag-bixintaada cilad ayaa ku timid, Internet-kana lama dirin. Fadlan lacagta mar kale ha dirin. Haddii number-ka iyo xogta dalabka ay sax yihiin, la xiriir Agent-ka Dalab si uu kuu caawiyo. 🤝"
  );
});

test("marking an order completed twice via the admin status route sends the success notification exactly once, with the approved copy", async () => {
  const orderId = await insertPendingOrder();
  await setStatus(orderId, "in_progress");

  const first = await setStatus(orderId, "completed");
  assert.equal(first.status, 200);
  const second = await setStatus(orderId, "completed");
  assert.equal(second.status, 200);

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.equal(notifications.length, 1, `expected exactly one success notification, got ${notifications.length}`);
  assert.equal(notifications[0].title, "🎉 Hambalyo Macmiil!");
  assert.equal(
    notifications[0].body,
    "Lacagtaada si guul leh ayaa loo helay, Internet-kana waxaa loo diray number-ka aad dooratay. Wax sugitaan ah ma jiro. Mahadsanid inaad isticmaashay Dalab App. ❤️"
  );
});

test("calling the agent 'complete order' endpoint twice for the same order sends the success notification exactly once", async () => {
  const orderId = await insertPendingOrder();
  await setStatus(orderId, "in_progress");

  const first = await completeAsAgent(orderId);
  assert.equal(first.status, 200);
  // completeOrderById treats an already-completed order as an idempotent
  // no-op (200, not an error) -- the second call's job here is just to
  // prove it doesn't re-send the notification, not to prove it's rejected.
  const second = await completeAsAgent(orderId);
  assert.equal(second.status, 200);

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.equal(notifications.length, 1, `expected exactly one success notification, got ${notifications.length}`);
});

test("two independent exhausted-retries reports for the same order never send the failure notification twice", async () => {
  const orderId = await insertPendingOrder();
  await setStatus(orderId, "in_progress");

  const attempt1 = await insertDialAttempt(orderId, 1);
  const attempt2 = await insertDialAttempt(orderId, 2);

  const first = await reportDialAttempt(attempt1, "failed", true);
  assert.equal(first.status, 200);
  const second = await reportDialAttempt(attempt2, "failed", true);
  assert.equal(second.status, 200);

  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "failed");

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.equal(notifications.length, 1, `expected exactly one failure notification, got ${notifications.length}`);
  assert.equal(notifications[0].title, "⚠️ Lacag-bixintu way ciladeysatay");
});

test("a full successful Internet order lifecycle produces exactly one notification in total, never an intermediate one", async () => {
  const orderId = await insertPendingOrder();
  await verifyPayment(orderId);
  await setStatus(orderId, "completed");

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.equal(notifications.length, 1, `expected exactly one total notification for this order, got ${notifications.length}`);
  assert.equal(notifications[0].title, "🎉 Hambalyo Macmiil!");
});

// Regression coverage for DLB336495502: a real order that completed via a
// successful USSD dial report got zero notifications, because this branch
// never called notifyCustomer at all (distinct from every duplicate/repeat
// scenario above -- this is an absence, not a repeat).
test("a successful USSD dial that completes an order sends the success notification exactly once, with the approved copy", async () => {
  const orderId = await insertPendingOrder();
  await setStatus(orderId, "in_progress");
  const attemptId = await insertDialAttempt(orderId, 1);

  const res = await reportDialAttempt(attemptId, "success", true);
  assert.equal(res.status, 200);

  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  assert.equal(order?.status, "completed");

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.equal(notifications.length, 1, `expected exactly one success notification, got ${notifications.length}`);
  assert.equal(notifications[0].title, "🎉 Hambalyo Macmiil!");
  assert.equal(
    notifications[0].body,
    "Lacagtaada si guul leh ayaa loo helay, Internet-kana waxaa loo diray number-ka aad dooratay. Wax sugitaan ah ma jiro. Mahadsanid inaad isticmaashay Dalab App. ❤️"
  );
});

test("a retried report of an already-resolved successful dial attempt never re-sends the success notification", async () => {
  const orderId = await insertPendingOrder();
  await setStatus(orderId, "in_progress");
  const attemptId = await insertDialAttempt(orderId, 1);

  const first = await reportDialAttempt(attemptId, "success", true);
  assert.equal(first.status, 200);
  // The dial_attempts row itself is only ever 'pending' once -- a retried
  // report of the SAME attempt id is a no-op read of the already-resolved
  // row, never a second run of the completion side effects.
  const second = await reportDialAttempt(attemptId, "success", true);
  assert.equal(second.status, 200);

  const notifications = await orderUpdateNotifications(CUSTOMER_ID);
  assert.equal(notifications.length, 1, `expected exactly one success notification, got ${notifications.length}`);
});

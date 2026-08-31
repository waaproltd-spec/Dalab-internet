// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_internet_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/offlineAdmin.test.ts
//
// Covers the new Admin > Offline section end-to-end against real data
// produced by the real pipeline (matchOrCreateOfflineAutoOrder ->
// verify-payment -> generateUssdForOrder -> a real dial attempt) --
// proving each endpoint reflects genuine state, never fabricated, and
// that an Online order is never pulled into any Offline view.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { encrypt, signAccessToken } from "../../auth/crypto.js";
import { ordersRouter } from "../orders.routes.js";
import { ussdRouter } from "../ussd.routes.js";
import { offlineAdminRouter } from "../offlineAdmin.routes.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";

const COMPANY_ID = "test-offadmin-hormuud";
const CATEGORY_ID = randomUUID();
const DEVICE_ID = "test-offadmin-device";
const AGENT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const CUSTOMER_PHONE = "252611119955";
const SENDER_NUMBER = "611119955";
const DESTINATION_NUMBER = "770009955";

let packageId: string;
let customerId: string;
let agentToken: string;
let staffToken: string;
let onlineOrderId: string;

const app = express();
app.use(express.json());
app.use(ordersRouter);
app.use(ussdRouter);
app.use(offlineAdminRouter);
let server: http.Server;
let baseUrl: string;

before(async () => {
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'OFFADMIN%' OR order_id LIKE 'ONLINEADMIN%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM sim_routing WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  // A completed order from a previous run credited Macaash points -- that
  // row's order_id gets SET NULL (not deleted) when the order above is
  // removed, so it still blocks deleting the customer unless cleared first.
  await query(`DELETE FROM macaash_transactions WHERE customer_id IN (SELECT id FROM customers WHERE phone=$1)`, [CUSTOMER_PHONE]);
  await query(`DELETE FROM customers WHERE phone=$1`, [CUSTOMER_PHONE]);
  await query(`DELETE FROM agents WHERE id=$1 OR phone='252699000599'`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1 OR email='offadmin-test@test.local'`, [ADMIN_ID]);

  await query(`INSERT INTO agent_devices (id, name, enabled, network_online, last_heartbeat_at) VALUES ($1, 'Test OffAdmin Device', true, true, now())`, [DEVICE_ID]);
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000599', 'Test OffAdmin Agent', 'x', $2)`,
    [AGENT_ID, DEVICE_ID]
  );
  await query(
    `INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'offadmin-test@test.local','x','super_admin')`,
    [ADMIN_ID]
  );
  const customer = await queryOne<{ id: string }>(
    `INSERT INTO customers (id, phone, name) VALUES (gen_random_uuid(), $1, 'Test Offline Customer') RETURNING id`,
    [CUSTOMER_PHONE]
  );
  customerId = customer!.id;

  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, payment_number, pin_encrypted) VALUES ($1,'Test OffAdmin Hormuud',1,'#000000','EVC Plus','611119955',$2)`,
    [COMPANY_ID, encrypt("7711")]
  );
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  const templateId = (
    await queryOne<{ id: string }>(
      `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status)
       VALUES (gen_random_uuid(),$1,'OffAdmin 1GB','*123*1*{number}*{amount}*{pin}#','enabled') RETURNING id`,
      [COMPANY_ID]
    )
  )!.id;
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, mb, active, ussd_template_id)
       VALUES (gen_random_uuid(),$1,$2,'OffAdmin 1GB',0.25,1024,true,$3) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID, templateId]
    )
  )!.id;
  await query(
    `INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,1,1)`,
    [COMPANY_ID, DEVICE_ID]
  );
  // Saved Offline Profile -- the only app interaction Rukumo ever needs.
  await query(
    `UPDATE customers SET offline_sender_number=$1, offline_destination_number=$2, offline_company_id=$3, offline_package_id=$4, offline_profile_updated_at=now() WHERE id=$5`,
    [SENDER_NUMBER, DESTINATION_NUMBER, COMPANY_ID, packageId, customerId]
  );

  // A plain ONLINE order for the same company, to prove it never leaks
  // into any Offline endpoint.
  onlineOrderId = "ONLINEADMIN" + randomUUID().slice(0, 6);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone, channel)
     VALUES ($1,$2,$3,$4,0.25,'completed','611119900','611119900','android')`,
    [onlineOrderId, customerId, COMPANY_ID, packageId]
  );

  agentToken = signAccessToken(AGENT_ID, "agent");
  staffToken = signAccessToken(ADMIN_ID, "super_admin");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  // A completed order here credits Macaash points, leaving a
  // macaash_transactions row referencing this run's customer -- other test
  // files in this suite (e.g. offlineAutoOrder.test.ts) do an unscoped
  // `DELETE FROM customers` in their own before() hook, assuming they own
  // the whole table; leaving that row behind would break THEIR cleanup on
  // the next run even though nothing about their own code changed. Clean
  // up thoroughly rather than relying on any other file's assumptions.
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'OFFADMIN%' OR order_id LIKE 'ONLINEADMIN%'`);
  await query(`DELETE FROM payment_transactions WHERE customer_phone=$1`, [CUSTOMER_PHONE]);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM macaash_transactions WHERE customer_id=$1`, [customerId]);
  await query(`DELETE FROM sim_routing WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1`, [customerId]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [ADMIN_ID]);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("Admin > Offline reflects the real Rukumo lifecycle end-to-end and never leaks Online orders", async () => {
  // ---- 0. Customers page shows the profile with zero orders yet.
  const custBefore = (await (await fetch(`${baseUrl}/admin/offline/customers?search=${SENDER_NUMBER}`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  const custRowBefore = custBefore.find((c) => c.phone === CUSTOMER_PHONE);
  assert.ok(custRowBefore, "the Offline Profile customer must be listed");
  assert.equal(custRowBefore.companyName, "Test OffAdmin Hormuud");
  assert.equal(custRowBefore.packageName, "OffAdmin 1GB");
  assert.equal(Number(custRowBefore.orderCount ?? 0), 0);

  // ---- 1. PAYMENT arrives -- a real payment SMS, no pre-existing order.
  const transactionRef = "OFFADMINREF" + randomUUID().slice(0, 8);
  const ingest = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: `[-EVCPLUS-] waxaad $0.25 ka heshay 0${SENDER_NUMBER}, Tar: 24/07/26`,
    parsedProvider: "Hormuud",
    parsedAmount: 0.25,
    parsedPhone: `0${SENDER_NUMBER}`,
    transactionRef,
    simSlot: 1,
  } as any);
  assert.equal(ingest.status, 201);
  const orderId = ingest.body.matchedOrderId as string;
  assert.ok(orderId);

  // ---- 2. Orders list: PAYMENT_VERIFIED before anything dials it -- the
  // routed device (Test OffAdmin Device) is online, so this is NOT
  // WAITING_FOR_AGENT (that's reserved for when the routed device is
  // offline/disabled/missing -- see OFFLINE_STATUS_CASE).
  const ordersPending = (await (await fetch(`${baseUrl}/admin/offline/orders?status=PAYMENT_VERIFIED`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  assert.ok(ordersPending.some((o) => o.id === orderId), "must show PAYMENT_VERIFIED before verify-payment, since the routed device is online");
  assert.ok(!ordersPending.some((o) => o.id === onlineOrderId), "an Online order must never appear in Offline Orders");

  // And WAITING_FOR_AGENT must be empty for this order right now -- proves
  // the two are genuinely distinguished, not just two names for the same thing.
  const ordersWaitingAgent = (await (await fetch(`${baseUrl}/admin/offline/orders?status=WAITING_FOR_AGENT`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  assert.ok(!ordersWaitingAgent.some((o) => o.id === orderId), "must NOT show WAITING_FOR_AGENT while the routed device is online");

  // ---- 3. verify-payment (automatic, same as Online) generates the USSD.
  const verifyRes = await fetch(`${baseUrl}/agent/orders/${orderId}/verify-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ smsLogId: ingest.body.id }),
  });
  assert.equal(verifyRes.status, 200);
  const verified: any = await verifyRes.json();
  assert.equal(verified.status, "in_progress");

  const ordersWaitingUssd = (await (await fetch(`${baseUrl}/admin/offline/orders?status=WAITING_FOR_USSD`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  assert.ok(ordersWaitingUssd.some((o) => o.id === orderId), "must show WAITING_FOR_USSD once verified but not yet dialed");

  // ---- 4. Agent dials the exact stored command.
  const startRes = await fetch(`${baseUrl}/agent/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ simSlot: 1, ussdString: verified.ussdGenerated, attemptNumber: 1 }),
  });
  const attemptId = ((await startRes.json()) as any).id;

  const resultRes = await fetch(`${baseUrl}/agent/dial-attempts/${attemptId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ status: "success", responseMessage: "Waad ku guuleysatay.", isFinalAttempt: true }),
  });
  assert.equal(resultRes.status, 200);

  // ---- 5. Orders list: SUCCESS now, with agent/device/SIM populated.
  const ordersSuccess = (await (await fetch(`${baseUrl}/admin/offline/orders?status=SUCCESS`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  const successRow = ordersSuccess.find((o) => o.id === orderId);
  assert.ok(successRow, "must show SUCCESS once the real dial attempt reports success");
  assert.equal(successRow.deviceId, DEVICE_ID);
  assert.equal(successRow.assignedDeviceName, "Test OffAdmin Device");
  assert.equal(Number(successRow.simSlot), 1);
  assert.equal(Number(successRow.dialAttemptCount), 1);
  assert.equal(successRow.channel, "offline_auto");

  // ---- 6. Order detail: full picture, all pieces present.
  const detailRes = await fetch(`${baseUrl}/admin/offline/orders/${orderId}`, { headers: { Authorization: `Bearer ${staffToken}` } });
  assert.equal(detailRes.status, 200);
  const detail: any = await detailRes.json();
  assert.equal(detail.order.status, "completed");
  assert.equal(detail.order.customerPhone, CUSTOMER_PHONE);
  assert.equal(detail.paymentTransactions.length, 1);
  assert.equal(detail.paymentTransactions[0].transactionRef, transactionRef);
  assert.equal(detail.dialAttempts.length, 1);
  assert.equal(detail.dialAttempts[0].status, "success");
  assert.equal(detail.dialAttempts[0].deviceName, "Test OffAdmin Device");
  assert.equal(detail.ussdLog.templateServiceName, "OffAdmin 1GB");
  assert.equal(detail.simRouting[0].deviceId, DEVICE_ID);
  assert.equal(detail.simRouting[0].deviceOnline, true);

  // ---- 7. Payment Transactions view links straight back to this order.
  const txList = (await (await fetch(`${baseUrl}/admin/offline/payment-transactions?search=${transactionRef}`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  assert.equal(txList.length, 1);
  assert.equal(txList[0].orderId, orderId);
  assert.equal(txList[0].transactionRef, transactionRef);
  assert.equal(txList[0].companyName, "Test OffAdmin Hormuud");

  // ---- 8. DUPLICATE: the exact same payment redelivered is blocked, and
  // the order now also shows up under the DUPLICATE filter.
  const redelivered = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "192",
    body: `[-EVCPLUS-] waxaad $0.25 ka heshay 0${SENDER_NUMBER}, Tar: 24/07/26`,
    parsedProvider: "Hormuud",
    parsedAmount: 0.25,
    parsedPhone: `0${SENDER_NUMBER}`,
    transactionRef,
    simSlot: 1,
  } as any);
  assert.equal(redelivered.body.duplicate, true);

  const dupOrders = (await (await fetch(`${baseUrl}/admin/offline/orders?status=DUPLICATE`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  assert.ok(dupOrders.some((o) => o.id === orderId), "an order with a blocked duplicate payment must show under the DUPLICATE filter");

  // ---- 9. Customers page now reflects the completed order.
  const custAfter = (await (await fetch(`${baseUrl}/admin/offline/customers?search=${SENDER_NUMBER}`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  const custRowAfter = custAfter.find((c) => c.phone === CUSTOMER_PHONE);
  assert.equal(Number(custRowAfter.orderCount), 1);
  assert.equal(custRowAfter.lastStatus, "completed");

  // ---- 10. Stats: counts add up, SUCCESS >= 1, and SYNC_PENDING is
  // honestly empty rather than fabricated (see offlineAdmin.routes.ts).
  const stats = (await (await fetch(`${baseUrl}/admin/offline/stats?companyId=${COMPANY_ID}`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any;
  assert.ok(stats.SUCCESS >= 1);
  assert.ok(stats.duplicate >= 1);

  const syncPending = (await (await fetch(`${baseUrl}/admin/offline/orders?status=SYNC_PENDING`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  assert.equal(syncPending.length, 0, "SYNC_PENDING must never fabricate rows the backend has no real visibility into");

  // ---- 11. Search by Order ID on the customers page works too.
  const custByOrderId = (await (await fetch(`${baseUrl}/admin/offline/customers?search=${orderId}`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  })).json()) as any[];
  assert.ok(custByOrderId.some((c) => c.phone === CUSTOMER_PHONE), "searching by the exact order id must find its customer");
});

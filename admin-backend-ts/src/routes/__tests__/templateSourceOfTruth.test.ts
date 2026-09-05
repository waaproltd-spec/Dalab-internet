// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/templateSourceOfTruth.test.ts
//
// Proves the full Admin-Template -> Backend -> Agent App source-of-truth
// chain end to end, through the real HTTP routes -- not by reading code:
//
//   1. A brand-new Admin-created, enabled USSD template is immediately used
//      to generate the dial string for a new order the instant it's linked
//      to a package (packages.ussd_template_id) -- no cache, no restart.
//   2. Editing that template's ussd_code changes what a SUBSEQUENT new
//      order generates, while an order generated BEFORE the edit keeps its
//      already-generated string untouched (an already-verified/matched
//      payment must never have its dial string silently rewritten under it).
//   3. Disabling the template blocks generation for a new order with an
//      explicit, exact configuration error recorded on the order -- no
//      fallback guess at a different template, no ussd_generated value at
//      all.
//   4. A package's explicit ussd_template_id link always wins over the
//      legacy name-matching fallback, even when a differently-linked
//      template's name would otherwise match by substring.
//   5. The backend now rejects a dial-attempt whose ussdString doesn't
//      exactly equal the order's own backend-generated ussd_generated --
//      the Agent App has no path to dial anything other than exactly what
//      the Admin's template produced.
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

const COMPANY_ID = "test-tsot-co";
const CATEGORY_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const AGENT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const DEVICE_ID = "test-tsot-device";

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
  return "TESTTSOT" + Math.floor(100000000 + Math.random() * 900000000);
}

async function insertPendingOrder(pkgId: string = packageId): Promise<string> {
  const id = makeOrderId();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, sender_phone, receiver_phone, status, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','customer_app')`,
    [id, CUSTOMER_ID, COMPANY_ID, pkgId, 5.00, 5.00, "252619991111", "252619992222"]
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

function createTemplate(ussdCode: string, serviceName = "TSOT Package") {
  return fetch(`${baseUrl}/admin/ussd-templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ companyId: COMPANY_ID, serviceName, ussdCode }),
  });
}

function editTemplate(templateId: string, ussdCode: string) {
  return fetch(`${baseUrl}/admin/ussd-templates/${templateId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ ussdCode }),
  });
}

function setTemplateStatus(templateId: string, status: "enabled" | "disabled") {
  return fetch(`${baseUrl}/admin/ussd-templates/${templateId}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status }),
  });
}

async function linkPackageToTemplate(pkgId: string, templateId: string | null) {
  await query(`UPDATE packages SET ussd_template_id=$1 WHERE id=$2`, [templateId, pkgId]);
}

before(async () => {
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTTSOT%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTTSOT%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone=$2`, [CUSTOMER_ID, "252619991111"]);
  await query(`DELETE FROM agents WHERE id=$1 OR device_id=$2`, [AGENT_ID, DEVICE_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1 OR email=$2`, [ADMIN_ID, "tsot-test-admin@example.com"]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Test TSOT Co',1,'#000000',$2)`, [
    COMPANY_ID,
    encrypt("8233"),
  ]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY_ID]);
  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price) VALUES (gen_random_uuid(),$1,$2,'TSOT Package',5.00) RETURNING id`,
      [COMPANY_ID, CATEGORY_ID]
    )
  )!.id;
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252619991111')`, [CUSTOMER_ID]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1,'Test TSOT Device')`, [DEVICE_ID]);
  await query(`DELETE FROM agents WHERE phone=$1`, ["252699009911"]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,'252699009911','Test Agent','x',$2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'tsot-test-admin@example.com','x','super_admin')`, [
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
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTTSOT%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTTSOT%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await linkPackageToTemplate(packageId, null);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await query(`DELETE FROM ussd_dial_attempts WHERE order_id LIKE 'TESTTSOT%'`);
  await query(`DELETE FROM payment_transactions WHERE order_id LIKE 'TESTTSOT%'`);
  await query(`DELETE FROM orders WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone=$2`, [CUSTOMER_ID, "252619991111"]);
  await query(`DELETE FROM agents WHERE id=$1`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [ADMIN_ID]);
  await pool.end();
});

test("1. a brand-new Admin-created, enabled template is immediately used by a new order the moment it's linked to a package", async () => {
  const createRes = await createTemplate("*111*{number}*{amount}*{pin}#");
  assert.equal(createRes.status, 201);
  const template: any = await createRes.json();
  assert.equal(template.status, "enabled");

  await linkPackageToTemplate(packageId, template.id);

  const orderId = await insertPendingOrder();
  const verifyRes = await verifyPayment(orderId);
  assert.equal(verifyRes.status, 200);
  const order: any = await verifyRes.json();

  assert.equal(order.status, "in_progress");
  // {number} -> the receiver phone stripped to bare local digits, {amount} ->
  // provider_amount formatted, {pin} -> the real PIN. Exact substitution
  // proves the just-created template (not a guess, not a cached default) is
  // what generated this string.
  assert.equal(order.ussdGeneratedMasked, "*111*619992222*5*••••#");
});

test("2. editing the template changes what a SUBSEQUENT new order generates, but never rewrites an already-generated order", async () => {
  const createRes = await createTemplate("*111*{number}*{amount}*{pin}#");
  const template: any = await createRes.json();
  await linkPackageToTemplate(packageId, template.id);

  const firstOrderId = await insertPendingOrder();
  const firstVerify: any = await (await verifyPayment(firstOrderId)).json();
  assert.equal(firstVerify.ussdGeneratedMasked, "*111*619992222*5*••••#");

  const editRes = await editTemplate(template.id, "*222*{number}*{amount}*{pin}#");
  assert.equal(editRes.status, 200);

  const secondOrderId = await insertPendingOrder();
  const secondVerify: any = await (await verifyPayment(secondOrderId)).json();
  assert.equal(secondVerify.ussdGeneratedMasked, "*222*619992222*5*••••#", "a NEW order must use the just-edited template");

  const firstReloaded = await queryOne<{ ussd_generated_masked: string }>(
    `SELECT ussd_generated_masked FROM orders WHERE id=$1`,
    [firstOrderId]
  );
  assert.equal(
    firstReloaded?.ussd_generated_masked,
    "*111*619992222*5*••••#",
    "the FIRST order's already-generated string must stay exactly as it was, never silently rewritten by the later edit"
  );
});

test("3. disabling the template blocks generation for a new order with an explicit error -- no fallback guess, no ussd_generated at all", async () => {
  const createRes = await createTemplate("*111*{number}*{amount}*{pin}#");
  const template: any = await createRes.json();
  await linkPackageToTemplate(packageId, template.id);

  const statusRes = await setTemplateStatus(template.id, "disabled");
  assert.equal(statusRes.status, 200);

  const orderId = await insertPendingOrder();
  const verifyRes = await verifyPayment(orderId);
  assert.equal(verifyRes.status, 200);
  const order: any = await verifyRes.json();

  assert.equal(order.status, "in_progress", "the order still advances to in_progress -- payment WAS verified -- it just can't be dialed yet");
  assert.equal(order.ussdGeneratedMasked, null, "no USSD string may exist when the linked template is disabled");

  const reloaded = await queryOne<{ ussd_generation_failed_reason: string | null }>(
    `SELECT ussd_generation_failed_reason FROM orders WHERE id=$1`,
    [orderId]
  );
  assert.match(
    reloaded?.ussd_generation_failed_reason ?? "",
    /disabled/i,
    "the exact reason must be recorded, not a generic failure"
  );
});

test("4. a package's explicit ussd_template_id link always wins over the legacy name-matching fallback", async () => {
  // A template whose name matches the package's own name by substring --
  // under the old name-based matcher this would win by default.
  const nameMatchRes = await createTemplate("*999*{number}*{amount}*{pin}#", "TSOT Package");
  const nameMatchTemplate: any = await nameMatchRes.json();

  // The template actually, explicitly linked to the package -- a
  // differently-named template the Admin deliberately chose instead.
  const linkedRes = await createTemplate("*333*{number}*{amount}*{pin}#", "Completely Different Name");
  const linkedTemplate: any = await linkedRes.json();
  await linkPackageToTemplate(packageId, linkedTemplate.id);

  const orderId = await insertPendingOrder();
  const order: any = await (await verifyPayment(orderId)).json();

  assert.equal(
    order.ussdGeneratedMasked,
    "*333*619992222*5*••••#",
    "the explicitly-linked template must win, never the name-matched one"
  );
  assert.notEqual(nameMatchTemplate.id, linkedTemplate.id);
});

test("5. the backend rejects a dial-attempt whose ussdString does not exactly match what it generated -- the Agent App cannot override the Admin template", async () => {
  const createRes = await createTemplate("*111*{number}*{amount}*{pin}#");
  const template: any = await createRes.json();
  await linkPackageToTemplate(packageId, template.id);

  const orderId = await insertPendingOrder();
  const order: any = await (await verifyPayment(orderId)).json();
  assert.ok(order.ussdGeneratedMasked);

  // A tampered/independently-constructed string -- must be rejected outright.
  const tamperedRes = await fetch(`${baseUrl}/agent/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ simSlot: 1, ussdString: "*999*000000000*1*0000#", attemptNumber: 1 }),
  });
  assert.equal(tamperedRes.status, 400);

  const noAttempts = await query(`SELECT id FROM ussd_dial_attempts WHERE order_id=$1`, [orderId]);
  assert.equal(noAttempts.length, 0, "a rejected mismatch must never be logged as a real dial attempt");

  // The real, backend-generated raw string (unmasked -- what the Agent App
  // actually receives to dial) must be accepted normally.
  const realOrder = await queryOne<{ ussd_generated: string }>(`SELECT ussd_generated FROM orders WHERE id=$1`, [orderId]);
  const realRes = await fetch(`${baseUrl}/agent/orders/${orderId}/dial-attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ simSlot: 1, ussdString: realOrder!.ussd_generated, attemptNumber: 1 }),
  });
  assert.equal(realRes.status, 201);
});

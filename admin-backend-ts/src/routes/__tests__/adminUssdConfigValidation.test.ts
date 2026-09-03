// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Proves the admin-facing validation added on
// top of the USSD formatting/routing audit actually applies through the real
// HTTP routes (not just the underlying helper functions in isolation) --
// specifically that a BRAND NEW provider, template, and package added right
// now, with zero provider-specific code, are caught by the exact same rules
// as every existing one. This is the regression protection the audit asked
// for: nothing here should ever need a follow-up change when the next real
// provider/package is added from the dashboard.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { encrypt, signAccessToken } from "../../auth/crypto.js";
import { companiesRouter, packagesRouter } from "../companies.routes.js";
import { ussdRouter, generateUssdForOrder } from "../ussd.routes.js";

const app = express();
app.use(express.json());
app.use(companiesRouter);
app.use(packagesRouter);
app.use(ussdRouter);

let server: http.Server;
let baseUrl: string;
let superAdminToken: string;

const COMPANY_ID = "test-admin-validation-newco";
const OTHER_COMPANY_ID = "test-admin-validation-otherco";
const CATEGORY_ID = "data";
const DEVICE_ID = "test-admin-validation-device";
const CUSTOMER_ID = randomUUID();

async function cleanup() {
  await query(`DELETE FROM orders WHERE company_id IN ($1,$2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM packages WHERE company_id IN ($1,$2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM ussd_templates WHERE company_id IN ($1,$2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM sim_routing WHERE company_id IN ($1,$2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE company_id IN ($1,$2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2)`, [COMPANY_ID, OTHER_COMPANY_ID]);
}

before(async () => {
  await cleanup();
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252699000077')`, [CUSTOMER_ID]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Validation Device')`, [DEVICE_ID]);

  superAdminToken = signAccessToken(randomUUID(), "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  await query(`DELETE FROM customers WHERE id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(async () => {
  await cleanup();
});

async function asJson(res: Response): Promise<any> {
  return res.json();
}

function authed(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${superAdminToken}`, "Content-Type": "application/json" },
  });
}

// --- Scenario 1: a brand new provider, added from scratch, with zero ---
// --- provider-specific code -- proves the pipeline is genuinely generic ---
test("new provider + new template + new package end to end: correct final USSD with no code change needed", async () => {
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Brand New Telco',1,'#123456',$2)`,
    [COMPANY_ID, encrypt("4471")]
  );
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES ($1,$2,1)`, [COMPANY_ID, DEVICE_ID]);

  const templateRes = await authed("/admin/ussd-templates", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, serviceName: "New Bundle", ussdCode: "*555*{number}*{amount}*{pin}#" }),
  });
  assert.equal(templateRes.status, 201);
  const template = await asJson(templateRes);
  assert.equal(template.routingWarning, undefined, "sim_routing exists, so no routing warning should fire");

  const packageRes = await authed("/admin/packages", {
    method: "POST",
    body: JSON.stringify({
      companyId: COMPANY_ID, categoryId: CATEGORY_ID, name: "New 1GB Bundle",
      price: 0.5, providerAmount: 0.5, ussdTemplateId: template.id,
    }),
  });
  assert.equal(packageRes.status, 201);
  const pkg = await asJson(packageRes);
  assert.equal(pkg.templateWarning, undefined);

  const orderId = "TESTNEW1";
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, receiver_phone, channel)
     VALUES ($1,$2,$3,$4,0.5,0.5,'in_progress','252685115555','customer_app')`,
    [orderId, CUSTOMER_ID, COMPANY_ID, pkg.id]
  );
  const order = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  const generated = await generateUssdForOrder(order);
  assert.equal(generated.ussd, "*555*685115555*05*4471#", "252 stripped, 0.50 -> 05 (single token), PIN last");
});

test("new package with a valid explicit template link: no warning", async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Co A',1,'#000000',$2)`, [COMPANY_ID, encrypt("1234")]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES ($1,$2,1)`, [COMPANY_ID, DEVICE_ID]);
  const templateRes = await authed("/admin/ussd-templates", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, serviceName: "Valid Template", ussdCode: "*111*{number}*{amount}*{pin}#" }),
  });
  const template = await asJson(templateRes);

  const packageRes = await authed("/admin/packages", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, categoryId: CATEGORY_ID, name: "Pkg", price: 1, providerAmount: 1, ussdTemplateId: template.id }),
  });
  const pkg = await asJson(packageRes);
  assert.equal(packageRes.status, 201);
  assert.equal(pkg.templateWarning, undefined);
});

test("missing template: package saves, but is clearly flagged as unable to dial", async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Co B',1,'#000000',$2)`, [COMPANY_ID, encrypt("1234")]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_ID]);

  const packageRes = await authed("/admin/packages", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, categoryId: CATEGORY_ID, name: "Totally Unmatched Package", price: 1, providerAmount: 1 }),
  });
  assert.equal(packageRes.status, 201, "missing template never blocks the save");
  const pkg = await asJson(packageRes);
  assert.match(pkg.templateWarning, /cannot|no ussd template matches/i);

  const listRes = await authed("/admin/packages/missing-template");
  const flagged = await asJson(listRes);
  assert.ok(flagged.some((p: any) => p.id === pkg.id), "shows up on the proactive dashboard badge too");
});

test("wrong-provider template is rejected outright, not silently ignored", async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Co C',1,'#000000',$2)`, [COMPANY_ID, encrypt("1234")]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Co D',1,'#000000',$2)`, [OTHER_COMPANY_ID, encrypt("1234")]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_ID]);
  const otherTemplateRes = await authed("/admin/ussd-templates", {
    method: "POST",
    body: JSON.stringify({ companyId: OTHER_COMPANY_ID, serviceName: "Other Co Template", ussdCode: "*222*{number}*{amount}*{pin}#" }),
  });
  const otherTemplate = await asJson(otherTemplateRes);

  const packageRes = await authed("/admin/packages", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, categoryId: CATEGORY_ID, name: "Cross Provider Attempt", price: 1, providerAmount: 1, ussdTemplateId: otherTemplate.id }),
  });
  assert.equal(packageRes.status, 400);
  const body = await asJson(packageRes);
  assert.match(body.error, /does not match any USSD template for this company/);
});

test("linking to a disabled template: package saves, but is clearly flagged as unable to dial until re-enabled", async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Co E',1,'#000000',$2)`, [COMPANY_ID, encrypt("1234")]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES ($1,$2,1)`, [COMPANY_ID, DEVICE_ID]);
  const templateRes = await authed("/admin/ussd-templates", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, serviceName: "Will Be Disabled", ussdCode: "*333*{number}*{amount}*{pin}#" }),
  });
  const template = await asJson(templateRes);
  await authed(`/admin/ussd-templates/${template.id}/status`, { method: "PUT", body: JSON.stringify({ status: "disabled" }) });

  const packageRes = await authed("/admin/packages", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, categoryId: CATEGORY_ID, name: "Pkg On Disabled Template", price: 1, providerAmount: 1, ussdTemplateId: template.id }),
  });
  assert.equal(packageRes.status, 201);
  const pkg = await asJson(packageRes);
  assert.match(pkg.templateWarning, /disabled/i);
});

test("missing device/SIM routing entirely: flagged the moment the template is created, before any package uses it", async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Co F',1,'#000000',$2)`, [COMPANY_ID, encrypt("1234")]);

  const templateRes = await authed("/admin/ussd-templates", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, serviceName: "No Routing Template", ussdCode: "*444*{number}*{amount}*{pin}#" }),
  });
  assert.equal(templateRes.status, 201);
  const template = await asJson(templateRes);
  assert.match(template.routingWarning, /no device\/SIM routing configured/i);
});

test("setting deviceId without simSlot (or vice versa) is rejected rather than silently ignored", async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, pin_encrypted) VALUES ($1,'Co G',1,'#000000',$2)`, [COMPANY_ID, encrypt("1234")]);

  const res = await authed("/admin/ussd-templates", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, serviceName: "Partial Pin", ussdCode: "*666*{number}*{amount}*{pin}#", deviceId: DEVICE_ID }),
  });
  assert.equal(res.status, 400);
  const body = await asJson(res);
  assert.match(body.error, /must be set together/);
});

test("a package with no PIN configured on the provider is flagged even though a valid template is linked", async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Co No Pin',1,'#000000')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES ($1,$2,1)`, [COMPANY_ID, DEVICE_ID]);
  const templateRes = await authed("/admin/ussd-templates", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, serviceName: "No Pin Template", ussdCode: "*777*{number}*{amount}*{pin}#" }),
  });
  const template = await asJson(templateRes);

  const packageRes = await authed("/admin/packages", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, categoryId: CATEGORY_ID, name: "No Pin Pkg", price: 1, providerAmount: 1, ussdTemplateId: template.id }),
  });
  const pkg = await asJson(packageRes);
  assert.match(pkg.templateWarning, /no PIN configured/i);
});

test("a SOMLINK-fulfilled company's package never gets a USSD warning -- it doesn't use USSD at all", async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, fulfillment_method) VALUES ($1,'Somlink Co',1,'#000000','somlink')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [randomUUID(), COMPANY_ID]);

  const packageRes = await authed("/admin/packages", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, categoryId: CATEGORY_ID, name: "Somlink Bundle", price: 1, providerAmount: 1 }),
  });
  const pkg = await asJson(packageRes);
  assert.equal(packageRes.status, 201);
  assert.equal(pkg.templateWarning, undefined);
});

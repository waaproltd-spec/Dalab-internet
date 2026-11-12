// Run against a real local Postgres test database (fully migrated):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/multipleUssdServices.test.ts
//
// Multiple menu (interactive) USSD services managed from the dashboard
// (migration 126): create, edit, duplicate, turn on/off and delete a
// service; Amount and Custom text steps; one active package per menu option
// per service (API and database); new services never hijack unlinked
// packages by name; and Somtel Dhameys Plus is left exactly as it was.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { encrypt, signAccessToken } from "../../auth/crypto.js";
import { companiesRouter, packagesRouter } from "../companies.routes.js";
import { ordersRouter } from "../orders.routes.js";
import { ussdRouter, generateUssdForOrder, matchTemplateByName } from "../ussd.routes.js";
import { interactiveServicesRouter } from "../interactiveServices.routes.js";
import { validateInteractiveTemplate, renderUssdPlan, typedAmount } from "../../utils/interactiveUssd.js";

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../db/migrations/${name}`, import.meta.url).href), "utf8");
const DHAMEYS_MIGRATION = migration("118_interactive_package_ussd_dhameys_plus.sql");
const SERVICES_MIGRATION = migration("126_multiple_ussd_services.sql");

const app = express();
app.use(express.json());
app.use(companiesRouter);
app.use(packagesRouter);
app.use(interactiveServicesRouter);
app.use(ordersRouter);
app.use(ussdRouter);
let server: http.Server;
let baseUrl: string;

const SUPER_ID = randomUUID();
const MANAGER_ID = randomUUID();
const AGENT_ID = randomUUID();
let superToken: string;
let managerToken: string;
let agentToken: string;
let dhameysId: string;

/** A safe Hormuud-style menu: *155# > 3 > package > number > PIN. */
const STEPS = [
  { reply: "3", expect: ["Internet"] },
  { reply: "{packageCode}", checkMenuPrice: true },
  { reply: "{number}" },
  { reply: "{pin}", checkAmount: true, checkNumber: true },
];

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

/** Everything about Dhameys Plus that must never change. */
async function dhameysSnapshot() {
  const template = await queryOne<any>(
    `SELECT id, company_id, service_name, ussd_code, status, dial_mode, reply_steps, success_keywords, balance_source, menu_category_slug, updated_at
       FROM ussd_templates WHERE id=$1`,
    [dhameysId]
  );
  const category = await queryOne<any>(`SELECT id, slug, name, status, updated_at FROM service_categories WHERE company_id='somtel' AND slug='dhameys-plus'`);
  const packages = await query<any>(
    `SELECT id, code, price, active, category_id, ussd_template_id, updated_at FROM packages WHERE ussd_template_id=$1 ORDER BY id`,
    [dhameysId]
  );
  return JSON.stringify({ template, category, packages });
}

async function createService(body: Record<string, unknown>, token = superToken) {
  return call("POST", "/admin/interactive-services", token, {
    companyId: "hormuud",
    serviceName: "Hormuud Internet Menu",
    initialDial: "*155#",
    replySteps: STEPS,
    successKeywords: ["guuleysatay"],
    ...body,
  });
}

async function addPackage(service: any, body: Record<string, unknown>) {
  return call("POST", "/admin/packages", managerToken, {
    companyId: service.companyId,
    categoryId: service.menuCategorySlug,
    ussdTemplateId: service.id,
    name: "Pkg",
    price: 1,
    providerAmount: 1,
    validity: "1 day",
    mb: 0, minutes: 0, sms: 0,
    ...body,
  });
}

before(async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ('somtel','Somtel',2,'#F2C200') ON CONFLICT (id) DO NOTHING`);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ('hormuud','Hormuud',1,'#22B24C') ON CONFLICT (id) DO NOTHING`);
  await query(`UPDATE companies SET pin_encrypted=$1, status='online', deleted_at=NULL WHERE id IN ('somtel','hormuud')`, [encrypt("4321")]);
  await query(DHAMEYS_MIGRATION);
  await query(SERVICES_MIGRATION);
  await query(SERVICES_MIGRATION); // safe to re-run
  dhameysId = (await queryOne<{ id: string }>(`SELECT id FROM ussd_templates WHERE company_id='somtel' AND dial_mode='interactive' AND menu_category_slug IS NULL`))!.id;

  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,'x','super_admin')`, [SUPER_ID, `mus-super-${SUPER_ID}@example.com`]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,$2,'x','admin',$3)`, [MANAGER_ID, `mus-mgr-${MANAGER_ID}@example.com`, ["packages.manage"]]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'MUS Agent','x')`, [AGENT_ID, `25261${String(Date.now()).slice(-7)}`]);
  superToken = signAccessToken(SUPER_ID, "super_admin");
  managerToken = signAccessToken(MANAGER_ID, "admin");
  agentToken = signAccessToken(AGENT_ID, "agent");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("step types: Amount and Custom text are accepted, with the same safety rules as before", () => {
  // Amount instead of a package option (a service that types the price).
  const amountMenu = [{ reply: "2" }, { reply: "{amount}" }, { reply: "{number}" }, { reply: "{pin}", checkAmount: true, checkNumber: true }];
  assert.equal(validateInteractiveTemplate("*123#", amountMenu, []), null);
  // Custom text reply.
  assert.equal(validateInteractiveTemplate("*123#", [{ reply: "Y", kind: "text" }, ...STEPS], []), null);
  assert.equal(validateInteractiveTemplate("*123#", [{ reply: "1*2", kind: "text" }, ...STEPS], []), null);
  // Custom text can't be a token, contain braces, or be too long.
  assert.match(validateInteractiveTemplate("*123#", [{ reply: "{pin}", kind: "text" }, ...STEPS], [])!, /custom reply/);
  assert.match(validateInteractiveTemplate("*123#", [{ reply: "a{b}", kind: "text" }, ...STEPS], [])!, /custom reply/);
  assert.match(validateInteractiveTemplate("*123#", [{ reply: "x".repeat(31), kind: "text" }, ...STEPS], [])!, /custom reply/);
  // Without kind:"text", letters are still refused (a menu number is expected).
  assert.match(validateInteractiveTemplate("*123#", [{ reply: "Y" }, ...STEPS], [])!, /menu number/);
  assert.match(validateInteractiveTemplate("*123#", [{ reply: "Y", kind: "other" as any }, ...STEPS], [])!, /unknown step type/);
  // Amount only once; one of package option / amount is required.
  assert.match(validateInteractiveTemplate("*123#", [{ reply: "{amount}" }, ...amountMenu], [])!, /amount can only be entered once/);
  assert.match(validateInteractiveTemplate("*123#", [{ reply: "2" }, { reply: "{number}" }, { reply: "{pin}", checkAmount: true, checkNumber: true }], [])!, /package option step .* or an amount step/);
  // The menu-price check still only belongs on the package option step.
  assert.match(validateInteractiveTemplate("*123#", [{ reply: "{amount}", checkMenuPrice: true }, ...amountMenu.slice(2)], [])!, /package option step/);
  // The PIN must still be last and check the amount and number.
  assert.match(validateInteractiveTemplate("*123#", [...amountMenu.slice(0, 3), { reply: "{pin}", checkAmount: true }], [])!, /check both/);
});

test("plans type the amount as the carrier expects and pass custom text through unchanged", () => {
  assert.equal(typedAmount(0.55), "0.55");
  assert.equal(typedAmount("15"), "15");
  assert.equal(typedAmount(1.1), "1.10");
  const plan = renderUssdPlan(
    { ussd_code: "*123#", reply_steps: [{ reply: "Y", kind: "text" }, { reply: "{amount}" }, { reply: "{number}" }, { reply: "{pin}", checkAmount: true, checkNumber: true }], success_keywords: [] },
    { number: "615551234", packageCode: "", amount: 2 }
  );
  assert.deepEqual(plan.steps.map((s) => s.reply), ["Y", "2", "615551234", "{pin}"]);
  assert.equal(plan.steps[3].amount, "2.00");
  assert.equal(plan.steps[3].secret, true);
});

test("creating a service: Super Admin only, validated, starts OFF with its own category; Dhameys Plus untouched", async () => {
  const before = await dhameysSnapshot();
  assert.equal((await createService({}, managerToken)).status, 403);
  assert.match((await createService({ companyId: "nope" })).body.error, /provider/);
  assert.match((await createService({ initialDial: "155" })).body.error, /first USSD code/);
  assert.match((await createService({ serviceName: "" })).body.error, /Service name/);
  assert.match((await createService({ serviceType: "tv" })).body.error, /Service type/);
  assert.match((await createService({ replySteps: STEPS.slice(0, 3) })).body.error, /PIN step/);

  const created = await createService({});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const svc = created.body;
  assert.equal(svc.dialMode, "interactive");
  assert.equal(svc.ussdCode, "*155#");
  assert.equal(svc.menuCategorySlug, "hormuud-internet-menu");
  const category = await queryOne<any>(`SELECT * FROM service_categories WHERE company_id='hormuud' AND slug=$1`, [svc.menuCategorySlug]);
  assert.equal(category.status, "disabled", "a new service starts OFF");
  assert.deepEqual(category.service_types, ["data"]);
  assert.equal((await createService({ serviceName: "hormuud internet MENU" })).status, 409, "same provider + same name");

  const list = await call("GET", "/admin/interactive-services?companyId=hormuud", managerToken);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((s: any) => s.serviceName), ["Hormuud Internet Menu"]);
  assert.equal(list.body[0].categoryStatus, "disabled");
  assert.equal(list.body[0].packageCount, 0);
  assert.equal(list.body[0].orderCount, 0);
  const all = await call("GET", "/admin/interactive-services", managerToken);
  assert.ok(all.body.some((s: any) => s.id === dhameysId && s.categoryStatus !== null), "Dhameys Plus is still listed with its status");

  const log = await queryOne<any>(`SELECT * FROM admin_activity_log WHERE entity_id=$1 AND action='create_menu_service'`, [svc.id]);
  assert.ok(log);
  assert.equal(await dhameysSnapshot(), before);
});

test("a new service turns on and off by itself, even before it has packages", async () => {
  const svc = (await createService({ serviceName: "Switch Test" })).body;
  assert.equal((await call("PUT", `/admin/interactive-services/${svc.id}/active`, managerToken, { active: true })).status, 200);
  assert.equal((await queryOne<any>(`SELECT status FROM service_categories WHERE company_id='hormuud' AND slug=$1`, [svc.menuCategorySlug])).status, "enabled");
  assert.equal((await call("PUT", `/admin/interactive-services/${svc.id}/active`, managerToken, { active: false })).status, 200);
  assert.equal((await queryOne<any>(`SELECT status FROM service_categories WHERE company_id='hormuud' AND slug=$1`, [svc.menuCategorySlug])).status, "disabled");
});

test("menu options are unique among a service's active packages, in the API and in the database, per service", async () => {
  const a = (await createService({ serviceName: "Options A" })).body;
  const b = (await createService({ serviceName: "Options B" })).body;
  const first = await addPackage(a, { name: "A1", code: "1" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const clash = await addPackage(a, { name: "A1 again", code: "1" });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /already used by "A1" in this USSD service/);
  assert.equal((await addPackage(a, { name: "A1 old", code: "1", active: false })).status, 201, "an inactive package may keep the option");
  assert.equal((await addPackage(b, { name: "B1", code: "1" })).status, 201, "the same option in another service is fine");
  assert.match((await addPackage(a, { name: "Bad", code: "abc" })).body.error, /provider's menu/);
  // The database refuses it too, whatever writes it.
  await assert.rejects(
    query(
      `INSERT INTO packages (id, company_id, category_id, name, price, validity, code, ussd_template_id, active) VALUES (gen_random_uuid(),'hormuud',$1,'Sneaky',1,'',' 1 ',$2,true)`,
      [a.menuCategorySlug, a.id]
    ),
    /Menu option 1 is already used/
  );
  // Restoring the inactive duplicate is refused while option 1 is taken.
  const old = await queryOne<any>(`SELECT id FROM packages WHERE ussd_template_id=$1 AND name='A1 old'`, [a.id]);
  assert.equal((await call("PUT", `/admin/packages/${old.id}`, managerToken, { active: true })).status, 400);
  // Unrelated updates to a package are never blocked.
  await query(`UPDATE packages SET price=2 WHERE id=$1`, [old.id]);
});

test("editing a service's settings keeps its packages and is refused if invalid", async () => {
  const svc = (await createService({ serviceName: "Edit Me" })).body;
  assert.equal((await call("PUT", `/admin/interactive-services/${svc.id}`, managerToken, { initialDial: "*156#" })).status, 403);
  const bad = await call("PUT", `/admin/interactive-services/${svc.id}`, superToken, { replySteps: [{ reply: "{pin}", checkAmount: true, checkNumber: true }] });
  assert.equal(bad.status, 400);
  const steps = [{ reply: "Y", kind: "text", expect: ["Confirm"] }, ...STEPS];
  const ok = await call("PUT", `/admin/interactive-services/${svc.id}`, superToken, { initialDial: "*156#", replySteps: steps, serviceName: "Edited" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1`, [svc.id]);
  assert.equal(saved.ussd_code, "*156#");
  assert.equal(saved.service_name, "Edited");
  assert.deepEqual(saved.reply_steps[0], { reply: "Y", kind: "text", expect: ["Confirm"] });
  assert.equal((await call("PUT", `/admin/interactive-services/${svc.id}`, superToken, { serviceName: "Options A" })).status, 409, "name already used by this provider");
});

test("duplicating copies the settings and packages, all OFF, and leaves the original alone", async () => {
  const before = await dhameysSnapshot();
  const dup = await call("POST", `/admin/interactive-services/${dhameysId}/duplicate`, superToken, {});
  assert.equal(dup.status, 201, JSON.stringify(dup.body));
  assert.equal(dup.body.serviceName, "Dhameys Plus (copy)");
  assert.equal(dup.body.packagesCopied, (await query(`SELECT id FROM packages WHERE ussd_template_id=$1`, [dhameysId])).length);
  const copy = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1`, [dup.body.id]);
  const original = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1`, [dhameysId]);
  assert.deepEqual(copy.reply_steps, original.reply_steps);
  assert.equal(copy.ussd_code, original.ussd_code);
  assert.equal(copy.balance_source, original.balance_source);
  assert.notEqual(copy.menu_category_slug, "dhameys-plus");
  const copiedPackages = await query<any>(`SELECT * FROM packages WHERE ussd_template_id=$1`, [dup.body.id]);
  assert.ok(copiedPackages.every((p) => p.active === false && p.category_id === copy.menu_category_slug));
  assert.equal((await queryOne<any>(`SELECT status FROM service_categories WHERE company_id='somtel' AND slug=$1`, [copy.menu_category_slug])).status, "disabled");
  const second = await call("POST", `/admin/interactive-services/${dhameysId}/duplicate`, superToken, {});
  assert.equal(second.body.serviceName, "Dhameys Plus (copy) 2");
  assert.equal((await call("POST", `/admin/interactive-services/${dhameysId}/duplicate`, managerToken, {})).status, 403);
  assert.equal(await dhameysSnapshot(), before, "Dhameys Plus itself is unchanged");
});

test("a new service's package is dialed with its own plan; existing orders keep theirs when the service is edited", async () => {
  const svc = (await createService({
    serviceName: "Amount Service",
    initialDial: "*130#",
    replySteps: [{ reply: "Y", kind: "text" }, { reply: "{amount}" }, { reply: "{number}" }, { reply: "{pin}", checkAmount: true, checkNumber: true }],
  })).body;
  const pkg = await addPackage(svc, { name: "Two dollars", price: 2, providerAmount: 2 });
  assert.equal(pkg.status, 201, JSON.stringify(pkg.body));
  await call("PUT", `/admin/interactive-services/${svc.id}/active`, managerToken, { active: true });
  const created = await call("POST", "/agent/orders", agentToken, { customerPhone: "252615550777", companyId: "hormuud", packageId: pkg.body.id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [created.body.id]);
  const order = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [created.body.id]);
  const result = await generateUssdForOrder(order);
  assert.equal(result.error, undefined);
  assert.equal(result.ussd, "*130# > Y > 2 > 615550777 > [PIN]");
  const stored = await queryOne<any>(`SELECT ussd_plan FROM orders WHERE id=$1`, [order.id]);
  assert.ok(!JSON.stringify(stored.ussd_plan).includes("4321"), "the PIN is never stored");

  // Editing the service later never rewrites the order's plan.
  await call("PUT", `/admin/interactive-services/${svc.id}`, superToken, { initialDial: "*131#" });
  assert.equal((await queryOne<any>(`SELECT ussd_plan FROM orders WHERE id=$1`, [order.id])).ussd_plan.initialDial, "*130#");

  // A service with orders can't be deleted; it can be turned off.
  const del = await call("DELETE", `/admin/interactive-services/${svc.id}`, superToken);
  assert.equal(del.status, 409);
  assert.equal(del.body.code, "service_has_orders");
  assert.ok(await queryOne(`SELECT 1 FROM ussd_templates WHERE id=$1`, [svc.id]));
});

test("deleting an unused service removes it, its packages and its own category, and nothing else", async () => {
  const before = await dhameysSnapshot();
  const svc = (await createService({ serviceName: "Delete Me" })).body;
  await addPackage(svc, { name: "D1", code: "1" });
  assert.equal((await call("DELETE", `/admin/interactive-services/${svc.id}`, managerToken)).status, 403);
  const del = await call("DELETE", `/admin/interactive-services/${svc.id}`, superToken);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.packagesDeleted, 1);
  assert.equal(await queryOne(`SELECT 1 FROM ussd_templates WHERE id=$1`, [svc.id]), null);
  assert.equal(await queryOne(`SELECT 1 FROM packages WHERE ussd_template_id=$1`, [svc.id]), null);
  assert.equal(await queryOne(`SELECT 1 FROM service_categories WHERE company_id='hormuud' AND slug=$1`, [svc.menuCategorySlug]), null);
  assert.equal((await call("DELETE", `/admin/interactive-services/${svc.id}`, superToken)).status, 404);
  // A built-in service (Dhameys Plus) is never deleted, even with no orders.
  const builtIn = await call("DELETE", `/admin/interactive-services/${dhameysId}`, superToken);
  assert.equal(builtIn.status, 409);
  assert.equal(builtIn.body.code, "built_in_service");
  assert.equal(await dhameysSnapshot(), before);
});

test("a dashboard-made service is never picked by package-name guessing; older templates still are", async () => {
  await createService({ serviceName: "Data" });
  assert.equal(await matchTemplateByName("hormuud", "Data"), null);
  assert.equal(await matchTemplateByName("hormuud", "Super Data 5GB"), null);
  const legacyId = randomUUID();
  await query(`INSERT INTO ussd_templates (id, company_id, service_name, ussd_code) VALUES ($1,'hormuud','Anfac','*202*{number}*{amount}*{pin}#')`, [legacyId]);
  assert.equal((await matchTemplateByName("hormuud", "Anfac 3GB"))?.id, legacyId);
});

test("Dhameys Plus still generates exactly the same plan", async () => {
  const daily = await queryOne<any>(`SELECT * FROM packages WHERE ussd_template_id=$1 AND code='3'`, [dhameysId]);
  await query(`UPDATE packages SET active=true WHERE id=$1`, [daily.id]);
  await query(`UPDATE service_categories SET status='enabled' WHERE company_id='somtel' AND slug='dhameys-plus'`);
  const created = await call("POST", "/agent/orders", agentToken, { customerPhone: "252620346071", companyId: "somtel", packageId: daily.id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [created.body.id]);
  const result = await generateUssdForOrder(await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [created.body.id]));
  assert.equal(result.ussd, "*101# > 4 > 3 > 2 > 620346071 > [PIN]");
});

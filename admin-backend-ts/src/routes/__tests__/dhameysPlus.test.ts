// Run against a real local Postgres test database:
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/dhameysPlus.test.ts
//
// Somtel Dhameys Plus (migration 118): the seeded service and its seven
// packages, admin package management, menu-USSD validation, availability
// enforcement on new orders, the PIN-free dial plan, the just-in-time PIN
// endpoint, and that existing orders keep the price/name they were sold at.
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
import { ussdRouter, generateUssdForOrder } from "../ussd.routes.js";
import { interactiveServicesRouter } from "../interactiveServices.routes.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";
import { evaluateSimBalance } from "../../utils/simBalanceCheck.js";
import { validateInteractiveTemplate, renderUssdPlan, summarizeUssdPlan } from "../../utils/interactiveUssd.js";

const MIGRATION = readFileSync(fileURLToPath(new URL("../../db/migrations/118_interactive_package_ussd_dhameys_plus.sql", import.meta.url).href), "utf8");

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
const VIEWER_ID = randomUUID();
const AGENT_ID = randomUUID();
let superToken: string;
let managerToken: string;
let viewerToken: string;
let agentToken: string;
let templateId: string;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

async function dhameysPackages() {
  return query<any>(`SELECT * FROM packages WHERE company_id='somtel' AND category_id='dhameys-plus' ORDER BY sort_order`);
}

before(async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ('somtel','Somtel',2,'#F2C200') ON CONFLICT (id) DO NOTHING`);
  await query(`UPDATE companies SET pin_encrypted=$1, status='online', deleted_at=NULL WHERE id='somtel'`, [encrypt("4321")]);
  await query(MIGRATION);
  templateId = (await queryOne<{ id: string }>(`SELECT id FROM ussd_templates WHERE company_id='somtel' AND dial_mode='interactive'`))!.id;

  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,'x','super_admin')`, [SUPER_ID, `dp-super-${SUPER_ID}@example.com`]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,$2,'x','admin',$3)`, [MANAGER_ID, `dp-mgr-${MANAGER_ID}@example.com`, ["packages.manage"]]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,$2,'x','admin',$3)`, [VIEWER_ID, `dp-view-${VIEWER_ID}@example.com`, []]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,'DP Agent','x')`, [AGENT_ID, `25261${String(Date.now()).slice(-7)}`]);
  superToken = signAccessToken(SUPER_ID, "super_admin");
  managerToken = signAccessToken(MANAGER_ID, "admin");
  viewerToken = signAccessToken(VIEWER_ID, "admin");
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

test("migration seeds Dhameys Plus once: one category, one menu template, seven inactive packages with their real menu options", async () => {
  await query(MIGRATION); // a second (and third) run must not duplicate anything
  await query(MIGRATION);
  const pkgs = await dhameysPackages();
  assert.equal(pkgs.length, 7);
  assert.deepEqual(pkgs.map((p) => [p.code, Number(p.price), p.validity]), [
    ["1", 0.2, "6 hours"], ["2", 0.35, "12 hours"], ["3", 0.5, "24 hours"], ["4", 1, "48 hours"],
    ["5", 3.4, "7 days"], ["6", 7.5, "15 days"], ["7", 15, "Monthly"],
  ]);
  assert.ok(pkgs.every((p) => p.active === false && p.ussd_template_id === templateId));
  assert.equal(Number((await queryOne<any>(`SELECT COUNT(*) FROM ussd_templates WHERE company_id='somtel' AND dial_mode='interactive'`)).count), 1);
  assert.equal(Number((await queryOne<any>(`SELECT COUNT(*) FROM service_categories WHERE company_id='somtel' AND slug='dhameys-plus'`)).count), 1);
  const tpl = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1`, [templateId]);
  assert.equal(tpl.ussd_code, "*101#");
  assert.deepEqual(tpl.reply_steps.map((s: any) => s.reply), ["4", "{packageCode}", "2", "{number}", "{pin}"]);
  assert.equal(validateInteractiveTemplate(tpl.ussd_code, tpl.reply_steps, tpl.success_keywords), null);
});

test("menu settings validation rejects unsupported or unsafe sequences", () => {
  const ok = [
    { reply: "4", expect: ["Dhameys"] },
    { reply: "{packageCode}", checkMenuPrice: true },
    { reply: "2" },
    { reply: "{number}" },
    { reply: "{pin}", checkAmount: true, checkNumber: true },
  ];
  assert.equal(validateInteractiveTemplate("*101#", ok, ["guuleysatay"]), null);
  assert.match(validateInteractiveTemplate("101", ok, [])!, /first USSD code/);
  assert.match(validateInteractiveTemplate("*101#", ok.slice(0, 4), [])!, /PIN step/);
  assert.match(validateInteractiveTemplate("*101#", [ok[4], ...ok.slice(0, 4)], [])!, /PIN must be the last/);
  assert.match(validateInteractiveTemplate("*101#", [ok[0], ok[1], ok[2], ok[4]], [])!, /receiver number/);
  assert.match(validateInteractiveTemplate("*101#", [ok[0], ok[2], ok[3], ok[4]], [])!, /package option/);
  assert.match(validateInteractiveTemplate("*101#", [...ok.slice(0, 4), { reply: "{pin}" }], [])!, /check both the amount and the receiver number/);
  assert.match(validateInteractiveTemplate("*101#", [ok[0], { reply: "{packageCode}" }, ...ok.slice(2)], [])!, /check the price/);
  assert.match(validateInteractiveTemplate("*101#", [{ reply: "four" }, ...ok.slice(1)], [])!, /menu number/);
  assert.match(validateInteractiveTemplate("*101#", ok, ["ok"])!, /Success words/);
});

test("only a Super Admin can change the menu USSD settings; invalid settings are refused with a clear reason", async () => {
  const tpl = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1`, [templateId]);
  assert.equal((await call("PUT", `/admin/interactive-services/${templateId}`, managerToken, { initialDial: "*101#" })).status, 403);
  const bad = await call("PUT", `/admin/interactive-services/${templateId}`, superToken, { replySteps: tpl.reply_steps.slice(0, 4) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /PIN step/);
  const good = await call("PUT", `/admin/interactive-services/${templateId}`, superToken, { initialDial: " *101# ", successKeywords: ["guuleysatay", "ugu shubto"] });
  assert.equal(good.status, 200);
  assert.equal(good.body.ussdCode, "*101#");
  // The generic template editor can't overwrite a menu template's first dial.
  assert.equal((await call("PUT", `/admin/ussd-templates/${templateId}`, superToken, { ussdCode: "*101*4#" })).status, 400);
  const log = await queryOne<any>(`SELECT * FROM admin_activity_log WHERE entity_id=$1 AND action='update_menu_ussd_settings' ORDER BY created_at DESC LIMIT 1`, [templateId]);
  assert.equal(log.admin_id, SUPER_ID);
});

test("package management: add, edit price/validity/option, deactivate, restore, permissions, validation, audit", async () => {
  // Viewer (no packages.manage) can read but not change.
  assert.equal((await call("GET", `/admin/interactive-services/${templateId}`, viewerToken)).status, 200);
  const denied = await call("POST", "/admin/packages", viewerToken, { companyId: "somtel", categoryId: "dhameys-plus", name: "X", price: 1 });
  assert.equal(denied.status, 403);

  const base = { companyId: "somtel", categoryId: "dhameys-plus", ussdTemplateId: templateId, validity: "3 days" };
  assert.equal((await call("POST", "/admin/packages", managerToken, { ...base, name: "Dhameys Plus — 3 Days", price: 0 })).status, 400, "price 0 refused");
  assert.equal((await call("POST", "/admin/packages", managerToken, { ...base, name: "Dhameys Plus — 3 Days", price: 2, code: "x" })).status, 400, "menu option must be a number");
  assert.equal((await call("POST", "/admin/packages", managerToken, { ...base, name: "Dhameys Plus — 3 Days", price: 2, code: "8", sortOrder: -1 })).status, 400);

  // Activate the seeded packages first so option clashes are checked.
  for (const p of await dhameysPackages()) {
    assert.equal((await call("PUT", `/admin/packages/${p.id}`, managerToken, { active: true })).status, 200);
  }
  const clash = await call("POST", "/admin/packages", managerToken, { ...base, name: "Dupe", price: 2, code: "3" });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /already used/);

  const created = await call("POST", "/admin/packages", managerToken, {
    ...base, name: "Dhameys Plus — 3 Days", price: 1.6, code: "8", sortOrder: 8, description: "Test", visibleAgentApp: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal(created.body.visibleAgentApp, false);
  assert.ok(created.body.createdAt && created.body.updatedAt);

  const before = await queryOne<any>(`SELECT updated_at FROM packages WHERE id=$1`, [id]);
  await new Promise((r) => setTimeout(r, 20));
  const edited = await call("PUT", `/admin/packages/${id}`, managerToken, { price: 1.75, validity: "72 hours", code: "9", name: "Dhameys Plus — 72 Hours" });
  assert.equal(edited.status, 200);
  assert.equal(Number(edited.body.price), 1.75);
  assert.equal(edited.body.validity, "72 hours");
  assert.equal(edited.body.code, "9");
  assert.ok(new Date(edited.body.updatedAt) > new Date(before.updated_at), "modification date moves");

  assert.equal((await call("DELETE", `/admin/packages/${id}`, managerToken)).status, 200, "deactivate");
  assert.equal((await queryOne<any>(`SELECT active FROM packages WHERE id=$1`, [id])).active, false);
  assert.equal((await call("PUT", `/admin/packages/${id}`, managerToken, { active: true })).status, 200, "restore");
  assert.equal((await queryOne<any>(`SELECT active FROM packages WHERE id=$1`, [id])).active, true);

  // Never ordered -> can be deleted for good.
  assert.equal((await call("DELETE", `/admin/packages/${id}/permanent`, managerToken)).status, 200);
  assert.equal(await queryOne(`SELECT 1 FROM packages WHERE id=$1`, [id]), null);

  const actions = (await query<any>(`SELECT action FROM admin_activity_log WHERE entity_id=$1 ORDER BY created_at`, [id])).map((r) => r.action);
  assert.deepEqual(actions, ["create_package", "update_package", "deactivate_package", "update_package", "delete_package"]);
});

test("listing follows availability: hidden-from-app and disabled-service packages are not offered; temporarily unavailable ones are shown as such", async () => {
  const [p1, p2, p3] = await dhameysPackages();
  await call("PUT", `/admin/packages/${p1.id}`, managerToken, { visibleCustomerApp: false });
  await call("PUT", `/admin/packages/${p2.id}`, managerToken, { ordersEnabled: false });

  const customer = (await call("GET", "/companies/somtel/packages?audience=customer")).body.filter((p: any) => p.categoryId === "dhameys-plus");
  assert.ok(!customer.some((p: any) => p.id === p1.id), "hidden from the Customer App");
  assert.equal(customer.find((p: any) => p.id === p2.id).ordersEnabled, false);
  const agent = (await call("GET", "/companies/somtel/packages?audience=agent")).body.filter((p: any) => p.categoryId === "dhameys-plus");
  assert.ok(agent.some((p: any) => p.id === p1.id), "still in the Agent App");
  assert.deepEqual(agent.map((p: any) => p.code), ["1", "2", "3", "4", "5", "6", "7"], "admin display order");

  assert.equal((await call("PUT", `/admin/interactive-services/${templateId}/active`, managerToken, { active: false })).status, 200);
  const off = (await call("GET", "/companies/somtel/packages")).body.filter((p: any) => p.categoryId === "dhameys-plus");
  assert.equal(off.length, 0, "whole service off");
  assert.equal((await call("PUT", `/admin/interactive-services/${templateId}/active`, managerToken, { active: true })).status, 200);

  await call("PUT", `/admin/packages/${p1.id}`, managerToken, { visibleCustomerApp: true });
  await call("PUT", `/admin/packages/${p2.id}`, managerToken, { ordersEnabled: true });
  assert.ok(p3);
});

test("new orders are refused for an inactive, unavailable, hidden or switched-off package (even from an outdated app); the price is always the server's", async () => {
  const pkgs = await dhameysPackages();
  const daily = pkgs.find((p) => p.code === "3");
  const order = (body: object) => call("POST", "/agent/orders", agentToken, { customerPhone: "252620346060", companyId: "somtel", ...body });

  await call("PUT", `/admin/packages/${daily.id}`, managerToken, { ordersEnabled: false });
  const unavailable = await order({ packageId: daily.id });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.code, "package_unavailable");
  await call("PUT", `/admin/packages/${daily.id}`, managerToken, { ordersEnabled: true, visibleAgentApp: false });
  assert.equal((await order({ packageId: daily.id })).status, 409, "hidden from the Agent App");
  await call("PUT", `/admin/packages/${daily.id}`, managerToken, { visibleAgentApp: true });
  await call("PUT", `/admin/interactive-services/${templateId}/active`, managerToken, { active: false });
  assert.equal((await order({ packageId: daily.id })).status, 409, "service off");
  await call("PUT", `/admin/interactive-services/${templateId}/active`, managerToken, { active: true });
  await call("DELETE", `/admin/packages/${daily.id}`, managerToken);
  assert.equal((await order({ packageId: daily.id })).status, 404, "deactivated");
  await call("PUT", `/admin/packages/${daily.id}`, managerToken, { active: true });

  const ok = await order({ packageId: daily.id, amount: 0.01, price: 0.01 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(Number(ok.body.amount), 0.5, "client-supplied price ignored");
});

test("an interactive order gets a PIN-free menu plan with the screen checks; the PIN is released only while it is being dialed", async () => {
  const daily = (await dhameysPackages()).find((p) => p.code === "3");
  const created = await call("POST", "/agent/orders", agentToken, { customerPhone: "252620346071", companyId: "somtel", packageId: daily.id });
  const orderId = created.body.id;
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [orderId]);
  const order = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  const result = await generateUssdForOrder(order);
  assert.equal(result.error, undefined);
  assert.equal(result.ussd, "*101# > 4 > 3 > 2 > 620346071 > [PIN]");

  const stored = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  assert.equal(stored.ussd_dial_mode, "interactive");
  const plan = stored.ussd_plan;
  assert.equal(plan.initialDial, "*101#");
  assert.deepEqual(plan.steps.map((s: any) => s.reply), ["4", "3", "2", "620346071", "{pin}"]);
  assert.deepEqual(plan.steps[1].menuOption, { option: "3", amount: "0.50" });
  assert.equal(plan.steps[4].amount, "0.50");
  assert.equal(plan.steps[4].number, "620346071");
  assert.equal(plan.steps[4].secret, true);
  assert.ok(plan.successKeywords.includes("guuleysatay"));
  const everything = JSON.stringify(stored) + JSON.stringify(await query(`SELECT * FROM ussd_logs WHERE order_id=$1`, [orderId]));
  assert.ok(!everything.includes("4321"), "the PIN is never stored on the order or in the USSD log");

  // No dial in progress yet -> no PIN.
  assert.equal((await call("POST", `/agent/orders/${orderId}/ussd-pin`, agentToken)).status, 409);
  // The existing SIM balance gate applies to menu orders too: with no
  // recorded eDahab balance the dial is refused until the agent confirms.
  const blocked = await call("POST", `/agent/orders/${orderId}/dial-attempts`, agentToken, { simSlot: 2, ussdString: result.ussd, attemptNumber: 1 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "sim_balance_unverified");
  const attempt = await call("POST", `/agent/orders/${orderId}/dial-attempts`, agentToken, { simSlot: 2, ussdString: result.ussd, attemptNumber: 1, confirmUnknownBalance: true });
  assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
  const pin = await call("POST", `/agent/orders/${orderId}/ussd-pin`, agentToken);
  assert.equal(pin.status, 200);
  assert.equal(pin.body.pin, "4321");
  assert.equal((await call("POST", `/agent/orders/${orderId}/ussd-pin`, viewerToken)).status, 403, "staff tokens can't fetch it");

  // The carrier's real success text completes the order.
  const done = await call("PUT", `/agent/dial-attempts/${attempt.body.id}`, agentToken, {
    status: "success",
    responseMessage: "Macmiil, waxaad ku guuleysatay inaad = Daily 24 Hrs ugu shubto 620346071. Waad ku mahadsantahay isticmaalka adeegyada Somtel!",
    isFinalAttempt: true,
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await queryOne<any>(`SELECT status FROM orders WHERE id=$1`, [orderId])).status, "completed");
  assert.equal((await call("POST", `/agent/orders/${orderId}/ussd-pin`, agentToken)).status, 409, "no PIN once finished");
});

test("changing a package later never changes an existing order's price, name or validity; a package with orders can't be deleted", async () => {
  const weekly = (await dhameysPackages()).find((p) => p.code === "5");
  const created = await call("POST", "/agent/orders", agentToken, { customerPhone: "252620346072", companyId: "somtel", packageId: weekly.id });
  assert.equal(created.status, 201);
  await call("PUT", `/admin/packages/${weekly.id}`, managerToken, { price: 3.9, name: "Dhameys Plus — 7 Days", validity: "1 week" });
  const order = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [created.body.id]);
  assert.equal(Number(order.amount), 3.4);
  assert.equal(Number(order.provider_amount), 3.4);
  assert.equal(order.package_name_snapshot, "Dhameys Plus — Weekly");
  assert.equal(order.package_validity_snapshot, "7 days");
  const del = await call("DELETE", `/admin/packages/${weekly.id}/permanent`, managerToken);
  assert.equal(del.status, 409);
  await call("PUT", `/admin/packages/${weekly.id}`, managerToken, { price: 3.4, name: "Dhameys Plus — Weekly", validity: "7 days" });
});

test("a package with a missing or clashing menu option can't generate a dial", async () => {
  const sixHours = (await dhameysPackages()).find((p) => p.code === "1");
  await query(`UPDATE packages SET code=NULL WHERE id=$1`, [sixHours.id]);
  const created = await call("POST", "/agent/orders", agentToken, { customerPhone: "252620346073", companyId: "somtel", packageId: sixHours.id });
  const order = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [created.body.id]);
  const result = await generateUssdForOrder(order);
  assert.match(result.error!, /menu option/);
  await query(`UPDATE packages SET code='1' WHERE id=$1`, [sixHours.id]);
});

test("existing one-shot templates and other companies are unaffected", async () => {
  const plan = renderUssdPlan(
    { ussd_code: "*101#", reply_steps: [{ reply: "{packageCode}", checkMenuPrice: true }, { reply: "{number}" }, { reply: "{pin}", checkAmount: true, checkNumber: true }] },
    { number: "620346060", packageCode: "7", amount: 15 }
  );
  assert.equal(summarizeUssdPlan(plan), "*101# > 7 > 620346060 > [PIN]");
  assert.deepEqual(plan.steps[0].menuOption, { option: "7", amount: "15.00" });
  const oneShot = await queryOne<any>(`SELECT COUNT(*)::int AS n FROM ussd_templates WHERE dial_mode <> 'interactive' AND dial_mode <> 'one_shot'`);
  assert.equal(oneShot.n, 0);
});

// ---------------------------------------------------------------------------
// Insufficient balance check. Dhameys Plus is paid with the dialing SIM's
// eDahab PIN, so the check reads THAT SIM's eDahab wallet balance
// (sim_balances.provider_key='edahab'), never the Somtel Send Data balance
// and never another SIM's wallet. No balance is "unknown" (the agent must
// confirm), never zero; not enough is always refused. These run last: they
// switch the packages on and use an agent bound to a device.

const BAL_AGENT_ID = randomUUID();
const DEVICE_ID = randomUUID();
const OTHER_DEVICE_ID = randomUUID();
const SLOT = 2;
let balAgentToken: string;
let phoneSeq = 0;

async function menuOrder(code: string) {
  const pkg = await queryOne<any>(`SELECT * FROM packages WHERE company_id='somtel' AND category_id='dhameys-plus' AND code=$1`, [code]);
  const phone = `25262${String(4100000 + ++phoneSeq)}`;
  const created = await call("POST", "/agent/orders", balAgentToken, { customerPhone: phone, companyId: "somtel", packageId: pkg.id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await query(`UPDATE orders SET status='in_progress' WHERE id=$1`, [created.body.id]);
  const order = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [created.body.id]);
  const generated = await generateUssdForOrder(order);
  assert.equal(generated.error, undefined);
  return { id: created.body.id as string, ussd: generated.ussd as string };
}

async function setBalance(providerKey: string, balance: number, updatedAt = new Date(), deviceId = DEVICE_ID) {
  await query(
    `INSERT INTO sim_balances (device_id, sim_slot, company_id, provider_key, balance, updated_at, last_source)
     VALUES ($1, $2, 'somtel', $3, $4, $5, 'manual')`,
    [deviceId, SLOT, providerKey, balance, updatedAt]
  );
}

async function clearBalances() {
  await query(`DELETE FROM sim_balance_history WHERE sim_balance_id IN (SELECT id FROM sim_balances WHERE device_id IN ($1,$2))`, [DEVICE_ID, OTHER_DEVICE_ID]);
  await query(`DELETE FROM sim_balances WHERE device_id IN ($1,$2)`, [DEVICE_ID, OTHER_DEVICE_ID]);
}

async function balanceOf(providerKey: string) {
  const row = await queryOne<{ balance: string }>(`SELECT balance FROM sim_balances WHERE device_id=$1 AND sim_slot=$2 AND provider_key=$3`, [DEVICE_ID, SLOT, providerKey]);
  return row ? Number(row.balance) : null;
}

const check = (orderId: string) => call("GET", `/agent/orders/${orderId}/sim-balance-check?simSlot=${SLOT}`, balAgentToken);
const dial = (order: { id: string; ussd: string }, extra: Record<string, unknown> = {}) =>
  call("POST", `/agent/orders/${order.id}/dial-attempts`, balAgentToken, { simSlot: SLOT, ussdString: order.ussd, attemptNumber: 1, ...extra });

test("balance check setup: a device-bound agent on the Somtel SIM, packages on sale", async () => {
  await query(`INSERT INTO agent_devices (id, name, enabled) VALUES ($1,'Dhameys Balance Device',true), ($2,'Other Device',true)`, [DEVICE_ID, OTHER_DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,$2,'DP Balance Agent','x',$3)`, [BAL_AGENT_ID, `25261${String(Date.now() + 7).slice(-7)}`, DEVICE_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ('somtel',$1,$2,1)`, [DEVICE_ID, SLOT]);
  await query(`UPDATE packages SET active=true, orders_enabled=true, visible_agent_app=true WHERE company_id='somtel' AND category_id='dhameys-plus'`);
  await query(`UPDATE service_categories SET status='enabled' WHERE company_id='somtel' AND slug='dhameys-plus'`);
  balAgentToken = signAccessToken(BAL_AGENT_ID, "agent");
});

test("the Dhameys Plus template is paid from eDahab, and each order keeps that source", async () => {
  const tpl = await queryOne<any>(`SELECT balance_source FROM ussd_templates WHERE id=$1`, [templateId]);
  assert.equal(tpl.balance_source, "edahab");
  const order = await menuOrder("3");
  assert.equal((await queryOne<any>(`SELECT ussd_balance_source FROM orders WHERE id=$1`, [order.id])).ussd_balance_source, "edahab");
});

test("available: enough eDahab on the dialing SIM dials straight away, even with NO Somtel SIM balance recorded", async () => {
  await clearBalances();
  await setBalance("edahab", 10);
  const order = await menuOrder("3"); // $0.50
  const res = await check(order.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "sufficient");
  assert.equal(res.body.balanceSource, "edahab");
  assert.equal(res.body.balanceLabel, "eDahab");
  assert.equal(res.body.availableBalance, 10);
  assert.equal(res.body.requestedAmount, 0.5);
  const attempt = await dial(order);
  assert.equal(attempt.status, 201, "no confirmation needed: the paying balance is known and enough");
});

test("insufficient: not enough eDahab is refused even when the Somtel SIM balance is high, and even if the agent 'confirms'", async () => {
  await clearBalances();
  await setBalance("edahab", 3);
  await setBalance("somtel", 50);
  const order = await menuOrder("5"); // Weekly $3.40
  const res = await check(order.id);
  assert.equal(res.body.status, "insufficient");
  assert.equal(res.body.availableBalance, 3);
  assert.equal(res.body.missingAmount, 0.4);
  assert.match(res.body.message, /Insufficient eDahab Balance/);
  const refused = await dial(order, { confirmUnknownBalance: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "insufficient_sim_balance");
  assert.equal(Number((await queryOne<any>(`SELECT COUNT(*) FROM ussd_dial_attempts WHERE order_id=$1`, [order.id])).count), 0, "nothing was dialed");
});

test("unknown: no eDahab balance recorded is 'unknown' (never zero, never the Somtel balance) and needs the agent's confirmation", async () => {
  await clearBalances();
  await setBalance("somtel", 50); // Send Data doesn't pay for Dhameys Plus
  await setBalance("edahab", 10, new Date(), OTHER_DEVICE_ID); // another SIM's wallet doesn't either
  const order = await menuOrder("3");
  const res = await check(order.id);
  assert.equal(res.body.status, "unknown");
  assert.equal(res.body.availableBalance, null, "unknown, not $0");
  assert.equal(res.body.missingAmount, null);
  assert.match(res.body.message, /eDahab Balance Unknown/);
  const blocked = await dial(order);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "sim_balance_unverified");
  const confirmed = await dial(order, { confirmUnknownBalance: true });
  assert.equal(confirmed.status, 201);
});

test("outdated: an old eDahab reading needs the agent's confirmation", async () => {
  await clearBalances();
  await setBalance("edahab", 10, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
  const order = await menuOrder("3");
  const res = await check(order.id);
  assert.equal(res.body.status, "outdated");
  const blocked = await dial(order);
  assert.equal(blocked.body.code, "sim_balance_unverified");
});

test("an order without a wallet source still checks the company's own SIM balance, as before", async () => {
  await clearBalances();
  await setBalance("edahab", 100);
  await setBalance("somtel", 0.2);
  const order = await menuOrder("3");
  await query(`UPDATE orders SET ussd_balance_source=NULL WHERE id=$1`, [order.id]);
  const res = await check(order.id);
  assert.equal(res.body.status, "insufficient");
  assert.equal(res.body.balanceSource, "somtel");
  assert.equal(res.body.availableBalance, 0.2);
  assert.match(res.body.message, /Insufficient SIM Balance — Somtel/);
});

test("an unclear reply never completes or fails the order and blocks re-dialing until staff resolve it; then only a confirmed success completes it", async () => {
  await clearBalances();
  await setBalance("edahab", 10);
  await setBalance("somtel", 50);
  const order = await menuOrder("3");
  const attempt = await dial(order);
  assert.equal(attempt.status, 201);
  const unclear = await call("PUT", `/agent/dial-attempts/${attempt.body.id}`, balAgentToken, {
    status: "ambiguous",
    responseMessage: "Connection problem or invalid MMI code.",
    isFinalAttempt: true,
  });
  assert.equal(unclear.status, 200);
  const afterUnclear = await queryOne<any>(`SELECT status FROM orders WHERE id=$1`, [order.id]);
  assert.equal(afterUnclear.status, "in_progress", "an unclear reply is neither completed nor failed (the money may have gone out)");
  const flagged = await queryOne<any>(`SELECT 1 AS x FROM admin_activity_log WHERE entity_id=$1 AND action='dial_outcome_unknown'`, [order.id]);
  assert.ok(flagged, "flagged for a person to check");

  // No automatic second dial while the first one's result is unknown.
  const blocked = await dial(order, { attemptNumber: 2 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "previous_attempt_unresolved");

  // Staff checked: not delivered -> the order may be dialed again.
  assert.equal((await call("POST", `/admin/dial-attempts/${attempt.body.id}/resolve`, viewerToken, { delivered: false })).status, 403, "needs orders.manage");
  const resolved = await call("POST", `/admin/dial-attempts/${attempt.body.id}/resolve`, superToken, { delivered: false, note: "Customer confirmed nothing arrived" });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal((await call("POST", `/admin/dial-attempts/${attempt.body.id}/resolve`, superToken, { delivered: true })).status, 409, "only once");

  const second = await dial(order, { attemptNumber: 2 });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const done = await call("PUT", `/agent/dial-attempts/${second.body.id}`, balAgentToken, {
    status: "success",
    responseMessage: "Macmiil, waxaad ku guuleysatay inaad = Daily 24 Hrs ugu shubto 620346060. Haraagaaga Cusubi Waa: 9.50 Dollar",
    isFinalAttempt: true,
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await queryOne<any>(`SELECT status FROM orders WHERE id=$1`, [order.id])).status, "completed");
  assert.equal(await balanceOf("edahab"), 9.5);
  assert.equal(await balanceOf("somtel"), 50, "Somtel's Send Data balance is untouched");

  // A finished attempt is never handed back as "go ahead and dial", and a
  // completed order can't start a new dial.
  const replay = await dial(order, { attemptNumber: 2 });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "attempt_already_resolved");
  const third = await dial(order, { attemptNumber: 3 });
  assert.equal(third.status, 409);
  assert.equal(third.body.code, "order_not_dialable");
});

test("a dial with no reported result (app died mid-dial) blocks every new dial, another phone can't take it over, and staff can confirm it was delivered", async () => {
  await clearBalances();
  await setBalance("edahab", 10);
  const order = await menuOrder("3");
  const attempt = await dial(order);
  assert.equal(attempt.status, 201);
  // The same phone re-sending the start of its own pending attempt (a lost
  // reply) gets the same attempt back.
  const replay = await dial(order);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, attempt.body.id);
  // A second phone can't dial the same attempt...
  const otherAgent = randomUUID();
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1,$2,'DP Other Agent','x',$3)`, [otherAgent, `25261${String(Date.now() + 11).slice(-7)}`, OTHER_DEVICE_ID]);
  const otherToken = signAccessToken(otherAgent, "agent");
  const elsewhere = await call("POST", `/agent/orders/${order.id}/dial-attempts`, otherToken, { simSlot: SLOT, ussdString: order.ussd, attemptNumber: 1, confirmUnknownBalance: true });
  assert.equal(elsewhere.status, 409);
  assert.equal(elsewhere.body.code, "attempt_in_progress_elsewhere");
  // ...nor start a new one.
  const next = await dial(order, { attemptNumber: 2 });
  assert.equal(next.body.code, "previous_attempt_unresolved");

  const resolved = await call("POST", `/admin/dial-attempts/${attempt.body.id}/resolve`, superToken, { delivered: true, note: "Customer has the package" });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal((await queryOne<any>(`SELECT status FROM orders WHERE id=$1`, [order.id])).status, "completed");
  assert.equal((await queryOne<any>(`SELECT status FROM ussd_dial_attempts WHERE id=$1`, [attempt.body.id])).status, "success");
  const log = await queryOne<any>(`SELECT new_value FROM admin_activity_log WHERE entity_id=$1 AND action='dial_attempt_resolved'`, [order.id]);
  assert.equal(log.new_value.delivered, true);
});

test("an eDahab balance SMS on the Somtel dialing SIM is recorded as that SIM's eDahab balance; Somtel's own SMS stays separate", async () => {
  await clearBalances();
  await ingestPaymentSms({
    agentId: BAL_AGENT_ID,
    sender: "edahab",
    body: "1 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060Aqanoosiga : PP260825.1816.F72842  Haraagaaga Cusubi Waa: 31.34 Dollar..Tariikh:25-08-2026[-eDahab-Service-]",
    simSlot: SLOT,
  });
  assert.equal(await balanceOf("edahab"), 31.34);
  assert.equal(await balanceOf("somtel"), null);
  // A near-miss sender is still refused.
  await ingestPaymentSms({
    agentId: BAL_AGENT_ID,
    sender: "edahabsms",
    body: "1 Dollar Ayaad Ka Heshay Cali.Code-ka:NA.Lambarka :620346061Aqanoosiga : PP260825.1816.F72843  Haraagaaga Cusubi Waa: 1.00 Dollar..Tariikh:25-08-2026[-eDahab-Service-]",
    simSlot: SLOT,
  });
  assert.equal(await balanceOf("edahab"), 31.34);
});

test("the paying balance is a Super Admin setting, validated and audited", async () => {
  const bad = await call("PUT", `/admin/interactive-services/${templateId}`, superToken, { balanceSource: "zaad" });
  assert.equal(bad.status, 400);
  const ok = await call("PUT", `/admin/interactive-services/${templateId}`, superToken, { balanceSource: "evc_plus" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.balanceSource, "evc_plus");
  const log = await queryOne<any>(
    `SELECT old_value, new_value FROM admin_activity_log WHERE entity_id=$1 AND action='update_menu_ussd_settings' ORDER BY created_at DESC LIMIT 1`,
    [templateId]
  );
  assert.equal(log.old_value.balanceSource, "edahab");
  assert.equal(log.new_value.balanceSource, "evc_plus");
  await call("PUT", `/admin/interactive-services/${templateId}`, superToken, { balanceSource: "edahab" });
});

test("the decision itself: available, insufficient (to the cent) and unknown for a wallet", () => {
  const base = { companyName: "Somtel", walletLabel: "eDahab", balanceUpdatedAt: new Date() };
  assert.equal(evaluateSimBalance({ ...base, requestedAmount: 0.5, availableBalance: 0.5 }).status, "sufficient");
  const short = evaluateSimBalance({ ...base, requestedAmount: 0.35, availableBalance: 0.34 });
  assert.equal(short.status, "insufficient");
  assert.equal(short.missingAmount, 0.01);
  const unknown = evaluateSimBalance({ ...base, requestedAmount: 0.2, availableBalance: null });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.ok, false);
  assert.equal(evaluateSimBalance({ ...base, requestedAmount: 0.2, availableBalance: 0 }).status, "insufficient", "a recorded $0 is insufficient, not unknown");
});

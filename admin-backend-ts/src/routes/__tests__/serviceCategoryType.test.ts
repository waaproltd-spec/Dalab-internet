// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers the Admin-only Service Types on
// service categories (migrations 111/112) through the REAL HTTP routes:
// one, two or all three per service; required and validated on create,
// editable (add/remove, incl. none) on edit, kept when other fields are
// edited, the older single serviceType kept in sync, and both exposed on
// the admin list and the public Customer App category list.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { categoriesRouter } from "../categories.routes.js";

const app = express();
app.use(express.json());
app.use(categoriesRouter);

let server: http.Server;
let baseUrl: string;
let superAdminToken: string;

const COMPANY_ID = "test-service-type-co";

async function cleanup() {
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
}

before(async () => {
  await cleanup();
  await query(`INSERT INTO companies (id, name, group_number, color_hex, status) VALUES ($1,'Test Co',1,'#123456','online')`, [COMPANY_ID]);
  superAdminToken = signAccessToken(randomUUID(), "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function asSuperAdmin(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${superAdminToken}`, "Content-Type": "application/json" } });
}

function create(body: Record<string, unknown>) {
  return asSuperAdmin(`/admin/categories`, { method: "POST", body: JSON.stringify({ companyId: COMPANY_ID, ...body }) });
}

test("creating a service requires at least one valid service type", async () => {
  const missing = await create({ name: "No Type" });
  assert.equal(missing.status, 400);
  const empty = await create({ name: "Empty Types", serviceTypes: [] });
  assert.equal(empty.status, 400);
  const invalid = await create({ name: "Bad Type", serviceType: "fiber" });
  assert.equal(invalid.status, 400);
  const invalidInList = await create({ name: "Bad List", serviceTypes: ["wifi", "fiber"] });
  assert.equal(invalidInList.status, 400);
  const notAList = await create({ name: "Not List", serviceTypes: "wifi" });
  assert.equal(notAList.status, 400);
  const rows = await query(`SELECT id FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  assert.equal(rows.length, 0, "a rejected create must not insert anything");
});

test("each service type is saved and returned on the admin and public lists", async () => {
  for (const [name, serviceType] of [["5G Home", "wifi"], ["Dhameys", "wireless"], ["Anfac", "call"]] as const) {
    const res = await create({ name, serviceType });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as any).serviceType, serviceType);
  }
  const adminList = (await (await asSuperAdmin(`/admin/categories?companyId=${COMPANY_ID}`)).json()) as any[];
  assert.deepEqual(
    Object.fromEntries(adminList.map((c) => [c.name, c.serviceType])),
    { "5G Home": "wifi", Dhameys: "wireless", Anfac: "call" }
  );
  const publicList = (await (await fetch(`${baseUrl}/companies/${COMPANY_ID}/categories`)).json()) as any[];
  assert.equal(publicList.find((c) => c.name === "Anfac").serviceType, "call");
});

test("a service can have one, two or all three types, stored in a fixed order", async () => {
  const two = await create({ name: "Anfac Plus", serviceTypes: ["call", "wifi", "call"] });
  assert.equal(two.status, 201);
  const twoBody = (await two.json()) as any;
  assert.deepEqual(twoBody.serviceTypes, ["wifi", "call"]);
  assert.equal(twoBody.serviceType, "wifi", "older single field follows the first type");

  const all = await create({ name: "Everything", serviceTypes: ["call", "wireless", "wifi"] });
  assert.deepEqual(((await all.json()) as any).serviceTypes, ["wifi", "wireless", "call"]);

  const publicList = (await (await fetch(`${baseUrl}/companies/${COMPANY_ID}/categories`)).json()) as any[];
  assert.deepEqual(publicList.find((c) => c.name === "Anfac Plus").serviceTypes, ["wifi", "call"]);
});

test("editing can add and remove types, including removing them all", async () => {
  const cat = await queryOne<{ id: string }>(`SELECT id FROM service_categories WHERE company_id=$1 AND name='Anfac Plus'`, [COMPANY_ID]);
  const put = (body: Record<string, unknown>) =>
    asSuperAdmin(`/admin/categories/${cat!.id}`, { method: "PUT", body: JSON.stringify(body) });

  const added = (await (await put({ serviceTypes: ["wifi", "wireless", "call"] })).json()) as any;
  assert.deepEqual(added.serviceTypes, ["wifi", "wireless", "call"]);

  const removed = (await (await put({ serviceTypes: ["call"] })).json()) as any;
  assert.deepEqual(removed.serviceTypes, ["call"]);
  assert.equal(removed.serviceType, "call");

  const kept = (await (await put({ name: "Anfac Plus 2" })).json()) as any;
  assert.deepEqual(kept.serviceTypes, ["call"], "editing the name keeps the types");

  const none = (await (await put({ serviceTypes: [] })).json()) as any;
  assert.deepEqual(none.serviceTypes, []);
  assert.equal(none.serviceType, null);

  assert.equal((await put({ serviceTypes: ["fiber"] })).status, 400);
});

test("editing can change the type, and editing other fields keeps it", async () => {
  const cat = await queryOne<{ id: string }>(`SELECT id FROM service_categories WHERE company_id=$1 AND name='Dhameys'`, [COMPANY_ID]);
  const changed = await asSuperAdmin(`/admin/categories/${cat!.id}`, { method: "PUT", body: JSON.stringify({ serviceType: "call" }) });
  const changedBody = (await changed.json()) as any;
  assert.equal(changedBody.serviceType, "call");
  assert.deepEqual(changedBody.serviceTypes, ["call"]);

  const renamed = await asSuperAdmin(`/admin/categories/${cat!.id}`, { method: "PUT", body: JSON.stringify({ name: "Dhameys Plus" }) });
  const body = (await renamed.json()) as any;
  assert.equal(body.name, "Dhameys Plus");
  assert.equal(body.serviceType, "call");

  const invalid = await asSuperAdmin(`/admin/categories/${cat!.id}`, { method: "PUT", body: JSON.stringify({ serviceType: "fiber" }) });
  assert.equal(invalid.status, 400);
});

test("a category created before service types existed stays editable without one", async () => {
  const legacy = await queryOne<{ id: string }>(
    `INSERT INTO service_categories (company_id, slug, name) VALUES ($1,'legacy','Legacy') RETURNING id`,
    [COMPANY_ID]
  );
  const res = await asSuperAdmin(`/admin/categories/${legacy!.id}`, { method: "PUT", body: JSON.stringify({ name: "Legacy 2" }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.serviceType, null);
  assert.deepEqual(body.serviceTypes, []);
});

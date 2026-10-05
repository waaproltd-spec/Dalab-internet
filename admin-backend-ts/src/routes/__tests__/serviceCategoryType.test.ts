// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers the Admin-only Service Type on
// service categories (migration 111) through the REAL HTTP routes: it is
// required and validated on create, editable (and optional) on edit, kept
// when other fields are edited, and exposed on both the admin list and the
// public Customer App category list.
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

test("creating a service requires a valid service type", async () => {
  const missing = await create({ name: "No Type" });
  assert.equal(missing.status, 400);
  const invalid = await create({ name: "Bad Type", serviceType: "fiber" });
  assert.equal(invalid.status, 400);
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

test("editing can change the type, and editing other fields keeps it", async () => {
  const cat = await queryOne<{ id: string }>(`SELECT id FROM service_categories WHERE company_id=$1 AND name='Dhameys'`, [COMPANY_ID]);
  const changed = await asSuperAdmin(`/admin/categories/${cat!.id}`, { method: "PUT", body: JSON.stringify({ serviceType: "call" }) });
  assert.equal(((await changed.json()) as any).serviceType, "call");

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
  assert.equal(((await res.json()) as any).serviceType, null);
});

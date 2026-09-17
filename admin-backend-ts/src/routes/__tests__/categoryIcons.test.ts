// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers the admin-manageable category icon
// feature end-to-end through the REAL HTTP routes: uploading, serving the
// raw bytes, the hasIcon flag showing correctly (and only that flag, never
// the raw bytes) on both the admin list and the public Customer/Agent App
// category list, clearing an icon, and that a regular Admin without
// categories.manage is rejected from managing them.
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
let plainAdminToken: string;
let categoryId: string;

const COMPANY_ID = "test-category-icons-co";
const PLAIN_ADMIN_ID = randomUUID();

// A 1x1 red pixel PNG, same fixture shape as other image-upload tests in
// this codebase.
const TEST_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function cleanup() {
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [PLAIN_ADMIN_ID]);
}

before(async () => {
  await cleanup();
  await query(`INSERT INTO companies (id, name, group_number, color_hex, status) VALUES ($1,'Test Co',1,'#123456','online')`, [COMPANY_ID]);
  const cat = await queryOne<{ id: string }>(
    `INSERT INTO service_categories (company_id, slug, name) VALUES ($1,'data','Data') RETURNING id`,
    [COMPANY_ID]
  );
  categoryId = cat!.id;

  await query(`INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,'cat-icon-test-admin@example.com','x','admin','{}')`, [PLAIN_ADMIN_ID]);
  superAdminToken = signAccessToken(randomUUID(), "super_admin");
  plainAdminToken = signAccessToken(PLAIN_ADMIN_ID, "admin");

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
function asPlainAdmin(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${plainAdminToken}`, "Content-Type": "application/json" } });
}

test("a brand-new category has no icon, and the admin/public lists both say so", async () => {
  const adminList = await (await asSuperAdmin(`/admin/categories?companyId=${COMPANY_ID}`)).json();
  const cat = (adminList as any[]).find((c) => c.id === categoryId);
  assert.equal(cat.hasIcon, false);
  assert.equal(cat.iconData, undefined, "raw icon bytes must never appear in the list response");

  const publicList = await (await fetch(`${baseUrl}/companies/${COMPANY_ID}/categories`)).json();
  const publicCat = (publicList as any[]).find((c) => c.id === categoryId);
  assert.equal(publicCat.hasIcon, false);

  const res = await fetch(`${baseUrl}/categories/${categoryId}/icon`);
  assert.equal(res.status, 404);
});

test("uploading an icon makes hasIcon true everywhere and the raw bytes are servable", async () => {
  const putRes = await asSuperAdmin(`/admin/categories/${categoryId}/icon`, { method: "PUT", body: JSON.stringify({ iconBase64: TEST_PNG_BASE64 }) });
  const putBody = (await putRes.json()) as any;
  assert.equal(putRes.status, 200, JSON.stringify(putBody));
  assert.equal(putBody.hasIcon, true);

  const adminList = await (await asSuperAdmin(`/admin/categories?companyId=${COMPANY_ID}`)).json();
  const cat = (adminList as any[]).find((c) => c.id === categoryId);
  assert.equal(cat.hasIcon, true);

  const publicList = await (await fetch(`${baseUrl}/companies/${COMPANY_ID}/categories`)).json();
  const publicCat = (publicList as any[]).find((c) => c.id === categoryId);
  assert.equal(publicCat.hasIcon, true);

  const iconRes = await fetch(`${baseUrl}/categories/${categoryId}/icon`);
  assert.equal(iconRes.status, 200);
  assert.equal(iconRes.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await iconRes.arrayBuffer());
  assert.ok(bytes.length > 0);
});

test("deleting the icon clears hasIcon and the icon route 404s again", async () => {
  await asSuperAdmin(`/admin/categories/${categoryId}/icon`, { method: "PUT", body: JSON.stringify({ iconBase64: TEST_PNG_BASE64 }) });
  const delRes = await asSuperAdmin(`/admin/categories/${categoryId}/icon`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  const delBody = (await delRes.json()) as any;
  assert.equal(delBody.hasIcon, false);

  const iconRes = await fetch(`${baseUrl}/categories/${categoryId}/icon`);
  assert.equal(iconRes.status, 404);
});

test("an invalid data URI is rejected with 400, not silently accepted", async () => {
  const res = await asSuperAdmin(`/admin/categories/${categoryId}/icon`, { method: "PUT", body: JSON.stringify({ iconBase64: "not-a-data-uri" }) });
  assert.equal(res.status, 400);
});

test("a non-existent category id 404s on icon upload and delete", async () => {
  const fakeId = randomUUID();
  const putRes = await asSuperAdmin(`/admin/categories/${fakeId}/icon`, { method: "PUT", body: JSON.stringify({ iconBase64: TEST_PNG_BASE64 }) });
  assert.equal(putRes.status, 404);
  const delRes = await asSuperAdmin(`/admin/categories/${fakeId}/icon`, { method: "DELETE" });
  assert.equal(delRes.status, 404);
});

test("a regular Admin without categories.manage cannot upload or delete a category icon", async () => {
  const putRes = await asPlainAdmin(`/admin/categories/${categoryId}/icon`, { method: "PUT", body: JSON.stringify({ iconBase64: TEST_PNG_BASE64 }) });
  assert.equal(putRes.status, 403);
  const delRes = await asPlainAdmin(`/admin/categories/${categoryId}/icon`, { method: "DELETE" });
  assert.equal(delRes.status, 403);
});

test("editing a category via PUT /admin/categories/:id preserves its icon", async () => {
  await asSuperAdmin(`/admin/categories/${categoryId}/icon`, { method: "PUT", body: JSON.stringify({ iconBase64: TEST_PNG_BASE64 }) });
  const putRes = await asSuperAdmin(`/admin/categories/${categoryId}`, { method: "PUT", body: JSON.stringify({ name: "Data Renamed" }) });
  const putBody = (await putRes.json()) as any;
  assert.equal(putRes.status, 200);
  assert.equal(putBody.name, "Data Renamed");
  assert.equal(putBody.hasIcon, true, "renaming a category must not clear its icon");
});

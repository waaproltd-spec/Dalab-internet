// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers per-package icon images end-to-end
// through the REAL HTTP routes: uploading, serving the raw bytes, the
// has_image flag showing correctly (and only that flag, never the raw
// bytes) on both the admin list and the public Customer/Agent App package
// list, clearing an image, and that a regular Admin without packages.manage
// is rejected from managing them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { companiesRouter, packagesRouter } from "../companies.routes.js";

const app = express();
app.use(express.json());
app.use(companiesRouter);
app.use(packagesRouter);

let server: http.Server;
let baseUrl: string;
let superAdminToken: string;
let plainAdminToken: string;
let packageId: string;

const COMPANY_ID = "test-package-images-co";
const PLAIN_ADMIN_ID = randomUUID();

// A 1x1 red pixel PNG, same fixture shape as other image-upload tests in
// this codebase.
const TEST_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function cleanup() {
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [PLAIN_ADMIN_ID]);
}

before(async () => {
  await cleanup();
  await query(`INSERT INTO companies (id, name, group_number, color_hex, status) VALUES ($1,'Test Co',1,'#123456','online')`, [COMPANY_ID]);
  await query(`INSERT INTO service_categories (company_id, slug, name) VALUES ($1,'data','Data')`, [COMPANY_ID]);
  const pkg = await queryOne<{ id: string }>(
    `INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,'data','Test Package',5.00) RETURNING id`,
    [randomUUID(), COMPANY_ID]
  );
  packageId = pkg!.id;

  await query(`INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,'pkg-image-test-admin@example.com','x','admin','{}')`, [PLAIN_ADMIN_ID]);
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

test("a brand-new package has no image, and the admin/public lists both say so", async () => {
  const adminList = await (await asSuperAdmin(`/admin/packages?companyId=${COMPANY_ID}`)).json();
  const pkg = (adminList as any[]).find((p) => p.id === packageId);
  assert.equal(pkg.hasImage, false);
  assert.equal(pkg.imageData, undefined, "raw image bytes must never appear in the list response");

  const publicList = await (await fetch(`${baseUrl}/companies/${COMPANY_ID}/packages`)).json();
  const publicPkg = (publicList as any[]).find((p) => p.id === packageId);
  assert.equal(publicPkg.hasImage, false);

  const res = await fetch(`${baseUrl}/packages/${packageId}/image`);
  assert.equal(res.status, 404);
});

test("uploading an image makes hasImage true everywhere and the raw bytes are servable", async () => {
  const putRes = await asSuperAdmin(`/admin/packages/${packageId}/image`, { method: "PUT", body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }) });
  const putBody = (await putRes.json()) as any;
  assert.equal(putRes.status, 200, JSON.stringify(putBody));
  assert.equal(putBody.hasImage, true);

  const adminList = await (await asSuperAdmin(`/admin/packages?companyId=${COMPANY_ID}`)).json();
  const pkg = (adminList as any[]).find((p) => p.id === packageId);
  assert.equal(pkg.hasImage, true);

  const publicList = await (await fetch(`${baseUrl}/companies/${COMPANY_ID}/packages`)).json();
  const publicPkg = (publicList as any[]).find((p) => p.id === packageId);
  assert.equal(publicPkg.hasImage, true);

  const imgRes = await fetch(`${baseUrl}/packages/${packageId}/image`);
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  assert.ok(bytes.length > 0);
});

test("deleting the image clears hasImage and the image route 404s again", async () => {
  await asSuperAdmin(`/admin/packages/${packageId}/image`, { method: "PUT", body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }) });
  const delRes = await asSuperAdmin(`/admin/packages/${packageId}/image`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  const delBody = (await delRes.json()) as any;
  assert.equal(delBody.hasImage, false);

  const imgRes = await fetch(`${baseUrl}/packages/${packageId}/image`);
  assert.equal(imgRes.status, 404);
});

test("an invalid data URI is rejected with 400, not silently accepted", async () => {
  const res = await asSuperAdmin(`/admin/packages/${packageId}/image`, { method: "PUT", body: JSON.stringify({ imageBase64: "not-a-data-uri" }) });
  assert.equal(res.status, 400);
});

test("a non-existent package id 404s on upload and delete", async () => {
  const fakeId = randomUUID();
  const putRes = await asSuperAdmin(`/admin/packages/${fakeId}/image`, { method: "PUT", body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }) });
  assert.equal(putRes.status, 404);
  const delRes = await asSuperAdmin(`/admin/packages/${fakeId}/image`, { method: "DELETE" });
  assert.equal(delRes.status, 404);
});

test("a regular Admin without packages.manage cannot upload or delete a package image", async () => {
  const putRes = await asPlainAdmin(`/admin/packages/${packageId}/image`, { method: "PUT", body: JSON.stringify({ imageBase64: TEST_PNG_BASE64 }) });
  assert.equal(putRes.status, 403);
  const delRes = await asPlainAdmin(`/admin/packages/${packageId}/image`, { method: "DELETE" });
  assert.equal(delRes.status, 403);
});

// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Covers Nala Soco end to end: the public
// feed only ever returns published posts, the image route serves raw bytes
// only when an image actually exists, Admin+Agent CRUD (create with/without
// an image, update without touching the image, replace the image,
// explicitly remove the image, delete), that a plain Admin (not just Super
// Admin) can manage posts, that an Agent has the exact same management
// permissions as an Admin (requireAuth("super_admin","admin","agent"), not
// promo_images' stricter Super-Admin-only gate), and that a Customer can
// manage nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { nalaSocoRouter } from "../nalaSoco.routes.js";

const app = express();
app.use(express.json());
app.use(nalaSocoRouter);

let server: http.Server;
let baseUrl: string;
let adminToken: string;
let agentToken: string;
let customerToken: string;

const ADMIN_ID = randomUUID();
const AGENT_ID = randomUUID();
const CUSTOMER_ID = randomUUID();

// A 1x1 transparent PNG, base64-encoded -- small, real, valid image bytes.
const TINY_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function asJson(res: Response): Promise<any> {
  return res.json();
}

function authed(token: string | null, body?: unknown) {
  return {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

before(async () => {
  await query(`DELETE FROM nala_soco_posts WHERE title LIKE 'Nala Soco Test%'`);
  // Deletes by the fixed literal email/phone too, not just this run's fresh
  // random id -- a prior run that crashed mid-test (e.g. Postgres going
  // down) can leave a same-email/phone row behind under a DIFFERENT id,
  // which the id-only delete below would never find, tripping the unique
  // constraint on this run's own insert.
  await query(`DELETE FROM admin_users WHERE id=$1 OR email='nala-soco-test@example.com'`, [ADMIN_ID]);
  await query(`DELETE FROM agents WHERE id=$1 OR phone='252699000011'`, [AGENT_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone='252699000010'`, [CUSTOMER_ID]);

  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'nala-soco-test@example.com','x','admin')`, [ADMIN_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699000011','Nala Soco Test Agent','x')`, [AGENT_ID]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252699000010')`, [CUSTOMER_ID]);
  adminToken = signAccessToken(ADMIN_ID, "admin");
  agentToken = signAccessToken(AGENT_ID, "agent");
  customerToken = signAccessToken(CUSTOMER_ID, "customer");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await query(`DELETE FROM nala_soco_posts WHERE title LIKE 'Nala Soco Test%'`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("GET /admin/nala-soco rejects an unauthenticated caller", async () => {
  const res = await fetch(`${baseUrl}/admin/nala-soco`, authed(null));
  assert.equal(res.status, 401);
});

test("POST /admin/nala-soco rejects a customer token (a Customer can manage nothing)", async () => {
  const res = await fetch(`${baseUrl}/admin/nala-soco`, {
    method: "POST",
    ...authed(customerToken, { title: "Nala Soco Test Nope", body: "should never be created" }),
  });
  assert.equal(res.status, 403);
});

test("POST /admin/nala-soco requires both title and body", async () => {
  const noTitle = await fetch(`${baseUrl}/admin/nala-soco`, { method: "POST", ...authed(adminToken, { body: "no title" }) });
  assert.equal(noTitle.status, 400);
  const noBody = await fetch(`${baseUrl}/admin/nala-soco`, { method: "POST", ...authed(adminToken, { title: "no body" }) });
  assert.equal(noBody.status, 400);
});

test("full lifecycle: a plain Admin creates a text-only post, it appears on the public feed, then gets updated with an image, then the image is removed, then deleted", async () => {
  const createRes = await fetch(`${baseUrl}/admin/nala-soco`, {
    method: "POST",
    ...authed(adminToken, { title: "Nala Soco Test Announcement", body: "Text-only post body" }),
  });
  assert.equal(createRes.status, 201);
  const created = await asJson(createRes);
  assert.equal(created.title, "Nala Soco Test Announcement");
  assert.equal(created.published, true, "published defaults to true");
  assert.equal(created.hasImage, false);

  const publicListRes = await fetch(`${baseUrl}/nala-soco`);
  const publicList = await asJson(publicListRes);
  assert.ok(
    publicList.some((p: { id: string }) => p.id === created.id),
    "a published post must appear on the public feed"
  );

  const noImageRes = await fetch(`${baseUrl}/nala-soco/${created.id}/image`);
  assert.equal(noImageRes.status, 404, "a text-only post has no image to serve");

  // Update: add an image, and flip published to false.
  const updateRes = await fetch(`${baseUrl}/admin/nala-soco/${created.id}`, {
    method: "PUT",
    ...authed(adminToken, { title: created.title, body: created.body, published: false, imageBase64: TINY_PNG_DATA_URI }),
  });
  assert.equal(updateRes.status, 200);
  const updated = await asJson(updateRes);
  assert.equal(updated.published, false);
  assert.equal(updated.hasImage, true);

  const afterUnpublishListRes = await fetch(`${baseUrl}/nala-soco`);
  const afterUnpublishList = await asJson(afterUnpublishListRes);
  assert.ok(
    !afterUnpublishList.some((p: { id: string }) => p.id === created.id),
    "an unpublished post must never appear on the public feed"
  );

  const imageRes = await fetch(`${baseUrl}/nala-soco/${created.id}/image`);
  assert.equal(imageRes.status, 200);
  assert.equal(imageRes.headers.get("content-type"), "image/png");

  // Explicitly remove the image (imageBase64: null) while leaving title/body
  // untouched via omission.
  const removeImageRes = await fetch(`${baseUrl}/admin/nala-soco/${created.id}`, {
    method: "PUT",
    ...authed(adminToken, { imageBase64: null }),
  });
  assert.equal(removeImageRes.status, 200);
  const afterRemove = await asJson(removeImageRes);
  assert.equal(afterRemove.hasImage, false);
  assert.equal(afterRemove.title, created.title, "omitting title on update must leave it unchanged");

  const goneImageRes = await fetch(`${baseUrl}/nala-soco/${created.id}/image`);
  assert.equal(goneImageRes.status, 404);

  const deleteRes = await fetch(`${baseUrl}/admin/nala-soco/${created.id}`, { method: "DELETE", ...authed(adminToken) });
  assert.equal(deleteRes.status, 200);

  const afterDeleteAdminList = await asJson(await fetch(`${baseUrl}/admin/nala-soco`, authed(adminToken)));
  assert.ok(!afterDeleteAdminList.some((p: { id: string }) => p.id === created.id), "deleted post must not reappear");
});

test("an update omitting imageBase64 entirely never wipes an existing image", async () => {
  const createRes = await fetch(`${baseUrl}/admin/nala-soco`, {
    method: "POST",
    ...authed(adminToken, { title: "Nala Soco Test Keep Image", body: "body", imageBase64: TINY_PNG_DATA_URI }),
  });
  const created = await asJson(createRes);
  assert.equal(created.hasImage, true);

  const updateRes = await fetch(`${baseUrl}/admin/nala-soco/${created.id}`, {
    method: "PUT",
    ...authed(adminToken, { title: "Nala Soco Test Keep Image (edited)" }),
  });
  const updated = await asJson(updateRes);
  assert.equal(updated.hasImage, true, "an update that never mentions imageBase64 must leave the existing image alone");

  const imageRes = await fetch(`${baseUrl}/nala-soco/${created.id}/image`);
  assert.equal(imageRes.status, 200);
});

test("GET /nala-soco paginates with limit/offset and never exceeds the max page size", async () => {
  for (let i = 0; i < 3; i++) {
    await fetch(`${baseUrl}/admin/nala-soco`, {
      method: "POST",
      ...authed(adminToken, { title: `Nala Soco Test Page ${i}`, body: "body" }),
    });
  }
  const res = await fetch(`${baseUrl}/nala-soco?limit=200&offset=0`);
  const list = await asJson(res);
  assert.ok(list.length <= 50, "limit must be clamped to the max page size even when a caller asks for more");
});

test("an Agent has the exact same Nala Soco management permissions as an Admin: create, list-all, update, publish/unpublish, delete", async () => {
  // Create as Agent.
  const createRes = await fetch(`${baseUrl}/admin/nala-soco`, {
    method: "POST",
    ...authed(agentToken, { title: "Nala Soco Test Agent Post", body: "Created by an agent" }),
  });
  assert.equal(createRes.status, 201, "an Agent must be able to create a post, same as an Admin");
  const created = await asJson(createRes);

  // List-all (incl. this one, which is published by default) as Agent.
  const listRes = await fetch(`${baseUrl}/admin/nala-soco`, authed(agentToken));
  assert.equal(listRes.status, 200);
  const list = await asJson(listRes);
  assert.ok(list.some((p: { id: string }) => p.id === created.id));

  // An Admin must also be able to manage a post an Agent created, and vice
  // versa -- there is no per-creator ownership restriction, only the
  // shared role gate.
  const adminUpdateRes = await fetch(`${baseUrl}/admin/nala-soco/${created.id}`, {
    method: "PUT",
    ...authed(adminToken, { published: false }),
  });
  assert.equal(adminUpdateRes.status, 200, "an Admin must be able to unpublish a post an Agent created");
  assert.equal((await asJson(adminUpdateRes)).published, false);

  // Republish as Agent.
  const agentRepublishRes = await fetch(`${baseUrl}/admin/nala-soco/${created.id}`, {
    method: "PUT",
    ...authed(agentToken, { published: true }),
  });
  assert.equal(agentRepublishRes.status, 200);
  assert.equal((await asJson(agentRepublishRes)).published, true);

  // Delete as Agent.
  const deleteRes = await fetch(`${baseUrl}/admin/nala-soco/${created.id}`, { method: "DELETE", ...authed(agentToken) });
  assert.equal(deleteRes.status, 200, "an Agent must be able to delete a post, same as an Admin");
});

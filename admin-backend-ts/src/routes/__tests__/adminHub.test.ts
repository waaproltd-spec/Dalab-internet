// Run against a real local Postgres test database (DATABASE_URL/PGSSL set):
//   npx tsx --test src/routes/__tests__/adminHub.test.ts
//
// Admin Hub link: only a message signed by the hub's key, addressed to this
// system, unexpired and never used before starts an admin session here; the
// hub's access changes (disable, role change) end existing sessions at once;
// hub-linked admins have no local password back door.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import jwtLib from "jsonwebtoken";
import { query, queryOne, pool } from "../../db/pool.js";
import { hashPassword } from "../../auth/crypto.js";
import { requireStaff, staffStatusMiddleware } from "../../auth/middleware.js";
import { authRouter } from "../auth.routes.js";
import { hubRouter } from "../hub.routes.js";
import { usersRouter } from "../users.routes.js";

const jwt = jwtLib as unknown as { sign: (p: object, k: string, o: Record<string, unknown>) => string };

const hubKeys = generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const otherKeys = generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

const HUB_USER = randomUUID();
const HUB_USER_2 = randomUUID();
const IMPORTED_EMAIL = "hub-test-imported@example.com";
const NEW_EMAIL = "hub-test-new@example.com";
const SECOND_EMAIL = "hub-test-second@example.com";

const app = express();
app.use(express.json());
app.use(staffStatusMiddleware);
app.use(authRouter);
app.use(hubRouter);
app.use(usersRouter);
app.get("/test/staff", requireStaff(), (_req, res) => {
  res.json({ ok: true });
});
let server: http.Server;
let base: string;

function sign(typ: string, payload: object, opts: { key?: string; aud?: string; sub?: string; expiresIn?: number } = {}) {
  return jwt.sign({ ...payload, typ }, opts.key ?? hubKeys.privateKey, {
    algorithm: "ES256",
    issuer: "waaproltd-admin-hub",
    audience: opts.aud ?? "dalab",
    expiresIn: opts.expiresIn ?? 60,
    jwtid: randomUUID(),
    ...(opts.sub ? { subject: opts.sub } : {}),
  });
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const sso = (assertion: string) => call("POST", "/admin/auth/hub-sso", { assertion });
const ssoFor = (sub: string, email: string, role: string, permissions: string[] = [], opts = {}) =>
  sso(sign("hub_sso", { email, name: "Test Person", role, permissions }, { sub, ...opts }));

async function cleanup() {
  await query(`DELETE FROM refresh_tokens WHERE subject_id IN (SELECT id::text FROM admin_users WHERE email LIKE 'hub-test-%')`);
  await query(`DELETE FROM admin_users WHERE email LIKE 'hub-test-%'`);
}

before(async () => {
  process.env.HUB_PUBLIC_KEY = hubKeys.publicKey.replace(/\n/g, "\\n");
  process.env.HUB_SYSTEM_KEY = "dalab";
  delete process.env.HUB_ONLY_LOGIN;
  await cleanup();
  await query(
    `INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,$2,$3,'admin',$4)`,
    [randomUUID(), IMPORTED_EMAIL, await hashPassword("Old-pass-123!"), ["orders.manage"]]
  );
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await cleanup();
  await pool.end();
});

test("a signed hand-off creates the admin here and starts a normal session", async () => {
  const res = await ssoFor(HUB_USER, NEW_EMAIL, "admin", ["orders.manage", "not.a.permission"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.admin.role, "admin");
  assert.deepEqual(res.body.admin.permissions, ["orders.manage"], "unknown permissions are dropped");
  const row = await queryOne(`SELECT hub_user_id, role FROM admin_users WHERE email=$1`, [NEW_EMAIL]);
  assert.equal(row.hub_user_id, HUB_USER);
  assert.equal((await call("GET", "/test/staff", undefined, res.body.accessToken)).status, 200);
});

test("the same hand-off can't be used twice", async () => {
  const assertion = sign("hub_sso", { email: NEW_EMAIL, role: "admin", permissions: [] }, { sub: HUB_USER });
  assert.equal((await sso(assertion)).status, 200);
  assert.equal((await sso(assertion)).status, 401);
});

test("a hand-off for another system, signed by another key, expired or of the wrong kind is refused", async () => {
  assert.equal((await ssoFor(HUB_USER, NEW_EMAIL, "admin", [], { aud: "another-system" })).status, 401);
  assert.equal((await ssoFor(HUB_USER, NEW_EMAIL, "admin", [], { key: otherKeys.privateKey })).status, 401);
  assert.equal((await ssoFor(HUB_USER, NEW_EMAIL, "admin", [], { expiresIn: -10 })).status, 401);
  assert.equal((await sso(sign("hub_sync", { email: NEW_EMAIL, role: "admin" }, { sub: HUB_USER }))).status, 401);
  assert.equal((await sso("not-a-token")).status, 401);
});

test("an existing admin with the same email is linked, keeps working, and loses the local-password back door", async () => {
  assert.equal((await call("POST", "/admin/auth/login", { email: IMPORTED_EMAIL, password: "Old-pass-123!" })).status, 200, "before the hub, local login works");
  const res = await ssoFor(HUB_USER_2, IMPORTED_EMAIL, "super_admin");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.admin.role, "super_admin");
  const login = await call("POST", "/admin/auth/login", { email: IMPORTED_EMAIL, password: "Old-pass-123!" });
  assert.equal(login.status, 403);
  assert.equal(login.body.code, "HUB_ONLY");
  assert.equal((await call("POST", "/admin/auth/forgot-password", { email: IMPORTED_EMAIL })).body.debugResetToken, undefined, "no local reset link");
});

test("the hub removing access ends the session at once (access and refresh tokens)", async () => {
  const res = await ssoFor(HUB_USER, NEW_EMAIL, "admin", ["orders.manage"]);
  const { accessToken, refreshToken } = res.body;
  const sync = await call("POST", "/admin/hub/sync", {}, sign("hub_sync", { users: [{ hubUserId: HUB_USER, email: NEW_EMAIL, role: null, permissions: [], disabled: true }] }));
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  const staff = await call("GET", "/test/staff", undefined, accessToken);
  assert.equal(staff.status, 401);
  assert.equal(staff.body.code, "ADMIN_ACCESS_CHANGED");
  assert.equal((await call("POST", "/auth/refresh", { refreshToken })).status, 401);
  assert.equal((await ssoFor(HUB_USER, NEW_EMAIL, "admin", [], { aud: "dalab" })).status, 200, "granting access again works");
});

test("a role change from the hub ends the old session; the next sign-in carries the new role", async () => {
  const res = await ssoFor(HUB_USER, NEW_EMAIL, "admin", []);
  const sync = await call("POST", "/admin/hub/sync", {}, sign("hub_sync", { users: [{ hubUserId: HUB_USER, email: NEW_EMAIL, role: "super_admin", permissions: [] }] }));
  assert.equal(sync.status, 200);
  assert.equal((await call("GET", "/test/staff", undefined, res.body.accessToken)).status, 401);
  const again = await ssoFor(HUB_USER, NEW_EMAIL, "super_admin");
  assert.equal(again.body.admin.role, "super_admin");
});

test("sync is signed and single-use; a sync for someone never seen here creates nothing", async () => {
  const token = sign("hub_sync", { users: [{ hubUserId: randomUUID(), email: SECOND_EMAIL, role: "admin", permissions: [] }] });
  assert.equal((await call("POST", "/admin/hub/sync", {}, token)).status, 200);
  assert.equal((await call("POST", "/admin/hub/sync", {}, token)).status, 401, "replay");
  assert.equal(await queryOne(`SELECT id FROM admin_users WHERE email=$1`, [SECOND_EMAIL]), null);
  const forged = sign("hub_sync", { users: [] }, { key: otherKeys.privateKey });
  assert.equal((await call("POST", "/admin/hub/sync", {}, forged)).status, 401);
});

test("hub-managed admins can't be edited locally, and the hub can read this system's permission list", async () => {
  const supers = await ssoFor(HUB_USER_2, IMPORTED_EMAIL, "super_admin");
  const target = await queryOne(`SELECT id FROM admin_users WHERE email=$1`, [NEW_EMAIL]);
  const edit = await call("PUT", `/admin/users/${target.id}/permissions`, { permissions: [] }, supers.body.accessToken);
  assert.equal(edit.status, 409);
  const meta = await call("GET", "/admin/hub/meta", undefined, sign("hub_meta", {}));
  assert.equal(meta.status, 200);
  assert.ok(meta.body.permissions.includes("orders.manage"));
});

test("with the hub switched off, none of this is reachable and local login is unchanged", async () => {
  const key = process.env.HUB_PUBLIC_KEY;
  delete process.env.HUB_PUBLIC_KEY;
  try {
    assert.equal((await ssoFor(HUB_USER, NEW_EMAIL, "admin")).status, 404);
    assert.equal((await call("GET", "/admin/hub/meta", undefined, sign("hub_meta", {}))).status, 404);
  } finally {
    process.env.HUB_PUBLIC_KEY = key;
  }
});

test("HUB_ONLY_LOGIN closes local sign-in for everyone", async () => {
  process.env.HUB_ONLY_LOGIN = "true";
  try {
    const res = await call("POST", "/admin/auth/login", { email: "anyone@example.com", password: "whatever" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "HUB_ONLY");
  } finally {
    delete process.env.HUB_ONLY_LOGIN;
  }
});

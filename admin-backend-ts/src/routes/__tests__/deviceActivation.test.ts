// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/deviceActivation.test.ts
//
// Device Activation end to end: an Agent App install gets a device number
// and a 4-character code, every agent API is blocked until an admin checks
// and approves that code, and expired / invalid / used / rejected codes
// can never authorize a device.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { deviceActivationRouter, agentDeviceActivationMiddleware } from "../deviceActivation.routes.js";
import { clearApprovedDeviceCache, generateActivationCode, hashActivationCode } from "../../utils/deviceActivation.js";

delete process.env.DEVICE_ACTIVATION_REQUIRED;

const NEW_AGENT = randomUUID();
const LEGACY_AGENT = randomUUID();
const SUPER_ADMIN = randomUUID();
const LIMITED_ADMIN = randomUUID();
let agentToken: string;
let legacyToken: string;
let superToken: string;
let limitedToken: string;

const app = express();
app.use(express.json());
app.use(agentDeviceActivationMiddleware);
app.use(deviceActivationRouter);
// Stand-in for any real agent API (orders, wallet, support, ...).
app.get("/agent/ping", (_req, res) => {
  res.json({ ok: true });
});
let server: http.Server;
let baseUrl: string;

const installA = "install-aaaaaaaaaaaaaaaa";
const installB = "install-bbbbbbbbbbbbbbbb";

function status(token: string, installId: string) {
  return fetch(`${baseUrl}/agent/device-activation/status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Agent-Install-Id": installId },
    body: JSON.stringify({ deviceModel: "Samsung A15" }),
  });
}
function ping(token: string, installId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (installId) headers["X-Agent-Install-Id"] = installId;
  return fetch(`${baseUrl}/agent/ping`, { headers });
}
function admin(path: string, token: string, body: unknown = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;

async function cleanup() {
  await query(`DELETE FROM admin_activity_log WHERE admin_id = ANY($1::uuid[])`, [[SUPER_ADMIN, LIMITED_ADMIN]]);
  await query(`DELETE FROM agent_device_activations WHERE agent_id = ANY($1::uuid[])`, [[NEW_AGENT, LEGACY_AGENT]]);
  await query(`DELETE FROM agents WHERE id = ANY($1::uuid[]) OR phone IN ('252699330001','252699330002')`, [[NEW_AGENT, LEGACY_AGENT]]);
  await query(`DELETE FROM admin_users WHERE id = ANY($1::uuid[]) OR email IN ('da-super@test.local','da-limited@test.local')`, [[SUPER_ADMIN, LIMITED_ADMIN]]);
}

before(async () => {
  await cleanup();
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699330001','Yaasiin Maxamed Adan','x')`, [NEW_AGENT]);
  // An agent who was already using the app before Device Activation existed.
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, last_login_at)
     VALUES ($1,'252699330002','Legacy Agent','x', (SELECT started_at FROM device_activation_rollout) - interval '1 day')`,
    [LEGACY_AGENT]
  );
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'da-super@test.local','x','super_admin')`, [SUPER_ADMIN]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,'da-limited@test.local','x','admin','{}')`, [LIMITED_ADMIN]);
  agentToken = signAccessToken(NEW_AGENT, "agent");
  legacyToken = signAccessToken(LEGACY_AGENT, "agent");
  superToken = signAccessToken(SUPER_ADMIN, "super_admin");
  limitedToken = signAccessToken(LIMITED_ADMIN, "admin");
  clearApprovedDeviceCache();
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await cleanup();
  await pool.end();
});

test("codes are random 4-character alphanumerics, and only their hash is used for lookup", () => {
  const codes = new Set(Array.from({ length: 200 }, () => generateActivationCode()));
  for (const c of codes) assert.match(c, /^[a-z0-9]{4}$/);
  assert.ok(codes.size > 150, "codes must not repeat a fixed value");
  assert.notEqual(hashActivationCode("44b1"), "44b1");
  assert.equal(hashActivationCode("44B1"), hashActivationCode("44b1"));
});

let deviceId: string;
let code: string;
let deviceNumber: string;

test("a new device is pending: it gets a device number and a code, stable across Check taps", async () => {
  const r1 = await json(await status(agentToken, installA));
  assert.equal(r1.status, "pending");
  assert.match(r1.deviceNumber, /^\d{7}$/);
  assert.match(r1.code, /^[a-z0-9]{4}$/);
  assert.ok(new Date(r1.codeExpiresAt).getTime() > Date.now());
  const r2 = await json(await status(agentToken, installA));
  assert.equal(r2.code, r1.code, "tapping Check doesn't change a live code");
  assert.equal(r2.deviceNumber, r1.deviceNumber);
  code = r1.code;
  deviceNumber = r1.deviceNumber;
  const row = await queryOne<{ id: string; code_hash: string; code_encrypted: string }>(
    `SELECT id, code_hash, code_encrypted FROM agent_device_activations WHERE agent_id=$1 AND install_id=$2`,
    [NEW_AGENT, installA]
  );
  deviceId = row!.id;
  assert.ok(!row!.code_encrypted.includes(code) && row!.code_hash !== code, "the code is never stored in plain text");
});

test("an unapproved device can't use any agent API (with or without an install id)", async () => {
  for (const r of [await ping(agentToken, installA), await ping(agentToken)]) {
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("x-device-activation"), "required");
    assert.equal((await json(r)).code, "DEVICE_NOT_ACTIVATED");
  }
});

test("admin permissions are enforced on the server", async () => {
  assert.equal((await admin("/admin/device-activations/check", limitedToken, { code })).status, 403);
  assert.equal((await admin("/admin/device-activations/check", agentToken, { code })).status, 403);
  assert.equal((await admin(`/admin/device-activations/${deviceId}/approve`, limitedToken, { code })).status, 403);
});

test("Check Code: invalid codes are rejected, a valid code shows the right agent and device", async () => {
  const bad = await admin("/admin/device-activations/check", superToken, { code: code === "zzzz" ? "yyyy" : "zzzz" });
  assert.equal(bad.status, 404);
  assert.equal((await json(bad)).code, "INVALID_CODE");
  assert.equal((await admin("/admin/device-activations/check", superToken, { code: "12" })).status, 400);

  const ok = await admin("/admin/device-activations/check", superToken, { code: code.toUpperCase() });
  assert.equal(ok.status, 200);
  const d = await json(ok);
  assert.equal(d.agentName, "Yaasiin Maxamed Adan");
  assert.equal(d.agentPhone, "252699330001");
  assert.equal(d.deviceNumber, deviceNumber);
  assert.equal(d.accountStatus, "active");
  assert.equal(d.activationStatus, "pending");
  assert.match(d.agentCode, /^AGT-[0-9A-F]{8}$/);
});

test("approve needs this device's own code; approval unlocks the app and is audited", async () => {
  const wrong = await admin(`/admin/device-activations/${deviceId}/approve`, superToken, { code: code === "zzzz" ? "yyyy" : "zzzz" });
  assert.equal(wrong.status, 409);
  assert.equal((await json(wrong)).code, "CODE_MISMATCH");

  const ok = await admin(`/admin/device-activations/${deviceId}/approve`, superToken, { code });
  assert.equal(ok.status, 200);
  const d = await json(ok);
  assert.equal(d.activationStatus, "approved");
  assert.equal(d.approvedByEmail, "da-super@test.local");
  assert.ok(d.approvedAt);

  assert.equal((await json(await status(agentToken, installA))).status, "approved");
  assert.equal((await ping(agentToken, installA)).status, 200);
  const log = await queryOne(`SELECT 1 FROM admin_activity_log WHERE admin_id=$1 AND action='device_activation.approved' AND entity_id=$2`, [
    SUPER_ADMIN,
    deviceId,
  ]);
  assert.ok(log, "who approved and when is recorded");
});

test("a used code can't authorize anything again", async () => {
  const again = await admin("/admin/device-activations/check", superToken, { code });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, "CODE_USED");
  assert.equal((await admin(`/admin/device-activations/${deviceId}/approve`, superToken, { code })).status, 409);
});

test("a different install of the same agent needs its own approval", async () => {
  const b = await json(await status(agentToken, installB));
  assert.equal(b.status, "pending");
  assert.notEqual(b.deviceNumber, deviceNumber);
  assert.equal((await ping(agentToken, installB)).status, 403);
});

test("an expired code is refused, and the app gets a new code on Check", async () => {
  const before = await json(await status(agentToken, installB));
  await query(`UPDATE agent_device_activations SET code_expires_at = now() - interval '1 minute' WHERE agent_id=$1 AND install_id=$2`, [
    NEW_AGENT,
    installB,
  ]);
  const check = await admin("/admin/device-activations/check", superToken, { code: before.code });
  assert.equal(check.status, 410);
  assert.equal((await json(check)).code, "CODE_EXPIRED");
  const id = (await queryOne<{ id: string }>(`SELECT id FROM agent_device_activations WHERE agent_id=$1 AND install_id=$2`, [NEW_AGENT, installB]))!.id;
  assert.equal((await admin(`/admin/device-activations/${id}/approve`, superToken, { code: before.code })).status, 410);
  assert.equal((await ping(agentToken, installB)).status, 403);

  const renewed = await json(await status(agentToken, installB));
  assert.equal(renewed.status, "pending");
  assert.ok(new Date(renewed.codeExpiresAt).getTime() > Date.now());
});

test("a rejected device stays blocked and says so", async () => {
  const id = (await queryOne<{ id: string }>(`SELECT id FROM agent_device_activations WHERE agent_id=$1 AND install_id=$2`, [NEW_AGENT, installB]))!.id;
  const r = await admin(`/admin/device-activations/${id}/reject`, superToken);
  assert.equal(r.status, 200);
  assert.equal((await json(await status(agentToken, installB))).status, "rejected");
  assert.equal((await ping(agentToken, installB)).status, 403);
});

test("revoking an approved device blocks it at once and it must be approved again", async () => {
  assert.equal((await admin(`/admin/device-activations/${deviceId}/revoke`, superToken)).status, 200);
  assert.equal((await ping(agentToken, installA)).status, 403);
  const s = await json(await status(agentToken, installA));
  assert.equal(s.status, "pending");
  assert.match(s.code, /^[a-z0-9]{4}$/);
  assert.notEqual(s.code, code, "a fresh code, the old one stays used");
});

test("an agent already using the app before activation existed keeps working on that first device only", async () => {
  const first = await json(await status(legacyToken, installA));
  assert.equal(first.status, "approved");
  assert.equal((await ping(legacyToken, installA)).status, 200);
  const second = await json(await status(legacyToken, installB));
  assert.equal(second.status, "pending", "a second phone still needs approval");
});

test("an approved device of one agent never unlocks another agent", async () => {
  // LEGACY_AGENT's installA is approved; NEW_AGENT's installA was revoked.
  assert.equal((await ping(agentToken, installA)).status, 403);
});

test("the feature can be switched off on the server (DEVICE_ACTIVATION_REQUIRED=false)", async () => {
  process.env.DEVICE_ACTIVATION_REQUIRED = "false";
  try {
    assert.equal((await ping(agentToken, installB)).status, 200);
    assert.equal((await json(await status(agentToken, installB))).status, "approved");
  } finally {
    delete process.env.DEVICE_ACTIVATION_REQUIRED;
  }
});

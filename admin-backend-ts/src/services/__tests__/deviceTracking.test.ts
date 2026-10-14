// Run against a real local Postgres test database (DATABASE_URL/PGSSL set):
//   npx tsx --test src/services/__tests__/deviceTracking.test.ts
//
// Trusted Devices listed one phone several times, because every reinstall or
// data clear makes a new per-install device_id. A login carrying the phone's
// hardware id now reuses that phone's entry.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, pool } from "../../db/pool.js";
import { parseDeviceInfo, registerCustomerDeviceLogin } from "../deviceTracking.js";

const customerId = randomUUID();
const phone = `61${String(Date.now()).slice(-7)}`;

before(async () => {
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Device Test Customer')`, [customerId, phone]);
});

after(async () => {
  await query(`DELETE FROM customers WHERE id=$1`, [customerId]);
  await pool.end();
});

async function listed() {
  return query<{ device_id: string; app_version: string | null; hardware_id: string | null }>(
    `SELECT device_id, app_version, hardware_id FROM customer_devices WHERE customer_id=$1 AND revoked_at IS NULL`,
    [customerId]
  );
}

const phoneA = { deviceName: "OnePlus OnePlus8Pro", deviceType: "phone", platform: "android", osVersion: "Android 11" };

test("the raw Android ID is never stored, only a hash", () => {
  const info = parseDeviceInfo({ deviceId: "install-1", hardwareId: "a1b2c3d4e5f60718" });
  assert.ok(info?.hardwareId);
  assert.notEqual(info!.hardwareId, "a1b2c3d4e5f60718");
  assert.equal(info!.hardwareId!.length, 64);
});

test("reinstalling on the same phone keeps one entry, under the new install", async () => {
  await registerCustomerDeviceLogin(customerId, parseDeviceInfo({ ...phoneA, deviceId: "install-1", appVersion: "1.10.15", hardwareId: "phone-a" }));
  await query(
    `INSERT INTO refresh_tokens (id, subject_id, subject_role, token_hash, expires_at, device_id)
     VALUES ($1,$2,'customer',$3, now() + interval '1 day', 'install-1')`,
    [randomUUID(), customerId, `hash-${randomUUID()}`]
  );
  await registerCustomerDeviceLogin(customerId, parseDeviceInfo({ ...phoneA, deviceId: "install-2", appVersion: "1.10.16", hardwareId: "phone-a" }));
  await registerCustomerDeviceLogin(customerId, parseDeviceInfo({ ...phoneA, deviceId: "install-3", appVersion: "1.10.16", hardwareId: "phone-a" }));

  const rows = await listed();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_id, "install-3");
  assert.equal(rows[0].app_version, "1.10.16");
  // The phone's session moved with it, so "Remove device" still signs it out.
  const tokens = await query<{ device_id: string }>(`SELECT device_id FROM refresh_tokens WHERE subject_id=$1`, [customerId]);
  assert.deepEqual(tokens.map((t) => t.device_id), ["install-3"]);
  const notices = await query(`SELECT id FROM notifications WHERE customer_id=$1 AND type='new_device_login'`, [customerId]);
  assert.equal(notices.length, 0, "a reinstall is not announced as a new device");
});

test("a different phone of the same model is still its own entry", async () => {
  await registerCustomerDeviceLogin(customerId, parseDeviceInfo({ ...phoneA, deviceId: "install-9", hardwareId: "phone-b" }));
  assert.equal((await listed()).length, 2);
});

test("an older app build without a hardware id behaves as before", async () => {
  await registerCustomerDeviceLogin(customerId, parseDeviceInfo({ ...phoneA, deviceId: "old-build-install" }));
  assert.equal((await listed()).length, 3);
});

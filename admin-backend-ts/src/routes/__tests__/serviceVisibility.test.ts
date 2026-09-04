// Run against a real local Postgres test database (see matchTemplateByName.test.ts
// header for the exact command). Proves the Internet/eBadal/Reseller/Shop/VIP
// Number visibility toggles work through the REAL HTTP routes (PUT
// /admin/settings/:key and GET /settings/public), not just as isolated logic
// -- specifically that each of the five flags is genuinely independent
// (flipping one never affects the others, in any of the 32 possible ON/OFF
// combinations), and that the default (before an admin ever touches this
// page) is "all visible".
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { settingsRouter } from "../settings.routes.js";

const app = express();
app.use(express.json());
app.use(settingsRouter);

let server: http.Server;
let baseUrl: string;
let superAdminToken: string;

const SERVICE_KEYS = [
  "service_internet_enabled",
  "service_ebadal_enabled",
  "service_reseller_enabled",
  "service_shop_enabled",
  "service_vip_numbers_enabled",
] as const;

// system_settings.updated_by is a real FK into admin_users -- PUT
// /admin/settings/:key fails with a foreign-key violation unless the
// token's sub actually exists there, same requirement every other test
// that writes through an admin-authenticated route already satisfies (see
// e.g. somlinkDelivery.test.ts).
const ADMIN_ID = randomUUID();

before(async () => {
  await query(`DELETE FROM system_settings WHERE key = ANY($1)`, [SERVICE_KEYS]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [ADMIN_ID]);
  await query(
    `INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'service-visibility-test-admin@example.com','x','super_admin')`,
    [ADMIN_ID]
  );
  superAdminToken = signAccessToken(ADMIN_ID, "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await query(`DELETE FROM system_settings WHERE key = ANY($1)`, [SERVICE_KEYS]);
  await query(`DELETE FROM admin_users WHERE id=$1`, [ADMIN_ID]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(async () => {
  await query(`DELETE FROM system_settings WHERE key = ANY($1)`, [SERVICE_KEYS]);
});

function authed(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${superAdminToken}`, "Content-Type": "application/json" },
  });
}

async function setService(key: (typeof SERVICE_KEYS)[number], value: boolean) {
  const res = await authed(`/admin/settings/${key}`, { method: "PUT", body: JSON.stringify({ value: value ? "true" : "false" }) });
  assert.equal(res.status, 200, `PUT ${key}=${value} failed: ${await res.text()}`);
}

async function getPublicServices(): Promise<{
  internetEnabled: boolean;
  ebadalEnabled: boolean;
  resellerEnabled: boolean;
  shopEnabled: boolean;
  vipNumbersEnabled: boolean;
}> {
  const res = await fetch(`${baseUrl}/settings/public`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as any;
  return json.services;
}

test("default (no admin has ever touched this setting): every service is visible", async () => {
  const services = await getPublicServices();
  assert.deepEqual(services, {
    internetEnabled: true,
    ebadalEnabled: true,
    resellerEnabled: true,
    shopEnabled: true,
    vipNumbersEnabled: true,
  });
});

test("GET /settings/public requires no authentication -- the Customer App calls this before/without login", async () => {
  const res = await fetch(`${baseUrl}/settings/public`);
  assert.equal(res.status, 200);
});

test("turning Internet off hides only Internet -- eBadal, Reseller, Shop, and VIP Number stay visible", async () => {
  await setService("service_internet_enabled", false);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: false,
    ebadalEnabled: true,
    resellerEnabled: true,
    shopEnabled: true,
    vipNumbersEnabled: true,
  });
});

test("turning Internet back on makes it visible again, with no effect on the others", async () => {
  await setService("service_internet_enabled", false);
  await setService("service_internet_enabled", true);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: true,
    ebadalEnabled: true,
    resellerEnabled: true,
    shopEnabled: true,
    vipNumbersEnabled: true,
  });
});

test("turning eBadal off hides only eBadal", async () => {
  await setService("service_ebadal_enabled", false);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: true,
    ebadalEnabled: false,
    resellerEnabled: true,
    shopEnabled: true,
    vipNumbersEnabled: true,
  });
});

test("turning Reseller off hides only Reseller -- it is not permanently hidden, and toggling it never touches the others", async () => {
  await setService("service_reseller_enabled", false);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: true,
    ebadalEnabled: true,
    resellerEnabled: false,
    shopEnabled: true,
    vipNumbersEnabled: true,
  });
});

test("turning Reseller back on restores it -- proves the ON path, not just OFF", async () => {
  await setService("service_reseller_enabled", false);
  await setService("service_reseller_enabled", true);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: true,
    ebadalEnabled: true,
    resellerEnabled: true,
    shopEnabled: true,
    vipNumbersEnabled: true,
  });
});

test("turning Shop off hides only Shop -- Internet, eBadal, Reseller, and VIP Number stay visible and working", async () => {
  await setService("service_shop_enabled", false);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: true,
    ebadalEnabled: true,
    resellerEnabled: true,
    shopEnabled: false,
    vipNumbersEnabled: true,
  });
});

test("turning Shop back on restores it -- proves the ON path, not just OFF", async () => {
  await setService("service_shop_enabled", false);
  await setService("service_shop_enabled", true);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: true,
    ebadalEnabled: true,
    resellerEnabled: true,
    shopEnabled: true,
    vipNumbersEnabled: true,
  });
});

test("turning VIP Number off hides only VIP Number -- Internet, eBadal, Reseller, and Shop stay visible and working", async () => {
  await setService("service_vip_numbers_enabled", false);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: true,
    ebadalEnabled: true,
    resellerEnabled: true,
    shopEnabled: true,
    vipNumbersEnabled: false,
  });
});

test("turning VIP Number back on restores it -- proves the ON path, not just OFF", async () => {
  await setService("service_vip_numbers_enabled", false);
  await setService("service_vip_numbers_enabled", true);
  assert.deepEqual(await getPublicServices(), {
    internetEnabled: true,
    ebadalEnabled: true,
    resellerEnabled: true,
    shopEnabled: true,
    vipNumbersEnabled: true,
  });
});

// All 32 possible ON/OFF combinations of the five independent flags,
// verified as one table-driven pass -- exactly the coverage asked for
// ("test all ON/OFF combinations"), not just a few hand-picked cases.
const ALL_COMBINATIONS: Array<[boolean, boolean, boolean, boolean, boolean]> = [];
for (const internet of [true, false]) {
  for (const ebadal of [true, false]) {
    for (const reseller of [true, false]) {
      for (const shop of [true, false]) {
        for (const vipNumbers of [true, false]) {
          ALL_COMBINATIONS.push([internet, ebadal, reseller, shop, vipNumbers]);
        }
      }
    }
  }
}

for (const [internet, ebadal, reseller, shop, vipNumbers] of ALL_COMBINATIONS) {
  test(`combination internet=${internet} ebadal=${ebadal} reseller=${reseller} shop=${shop} vipNumbers=${vipNumbers} resolves exactly as set, independently`, async () => {
    await setService("service_internet_enabled", internet);
    await setService("service_ebadal_enabled", ebadal);
    await setService("service_reseller_enabled", reseller);
    await setService("service_shop_enabled", shop);
    await setService("service_vip_numbers_enabled", vipNumbers);
    assert.deepEqual(await getPublicServices(), {
      internetEnabled: internet,
      ebadalEnabled: ebadal,
      resellerEnabled: reseller,
      shopEnabled: shop,
      vipNumbersEnabled: vipNumbers,
    });
  });
}

test("GET /admin/settings (staff) reflects the same five keys admins actually edit", async () => {
  await setService("service_internet_enabled", false);
  const res = await authed("/admin/settings");
  assert.equal(res.status, 200);
  const json = (await res.json()) as any;
  assert.equal(json.serviceInternetEnabled, "false");
  assert.equal(json.serviceEbadalEnabled, "true");
  assert.equal(json.serviceResellerEnabled, "true");
  assert.equal(json.serviceShopEnabled, "true");
  assert.equal(json.serviceVipNumbersEnabled, "true");
});

test("an unknown settings key is rejected -- the five service keys must be spelled exactly as the backend expects", async () => {
  const res = await authed("/admin/settings/service_reseler_enabled", { method: "PUT", body: JSON.stringify({ value: "false" }) });
  assert.equal(res.status, 400);
});

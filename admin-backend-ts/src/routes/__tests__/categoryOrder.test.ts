// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/categoryOrder.test.ts
//
// The Admin arranges a company's categories by hand. That order is kept on
// the server and is the order the Customer App shows them in: the
// categories list, and packages listed category by category (apps show
// categories in the order they first appear -- existing apps included).
// Never sorted by price or name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { categoriesRouter } from "../categories.routes.js";
import { companiesRouter } from "../companies.routes.js";

const app = express();
app.use(express.json());
app.use(categoriesRouter);
app.use(companiesRouter);

let server: http.Server;
let base: string;
const CO = "test-cat-order-co";
const admin = signAccessToken(randomUUID(), "super_admin");

function call(method: string, path: string, body?: unknown, token: string | null = admin) {
  return fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));
}

let ids: Record<string, string> = {};

before(async () => {
  await query(`INSERT INTO companies (id, name, group_number, color_hex, status) VALUES ($1,'Order Co',1,'#123456','online')`, [CO]);
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Created in this order; names deliberately not alphabetical.
  for (const name of ["Xulmo social", "Abaal GB", "Muraadso"]) {
    const r = await call("POST", "/admin/categories", { companyId: CO, name, serviceTypes: ["wifi"] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids[name] = r.body.id;
  }
  // Packages: the cheapest in the last category, to prove price never decides.
  const pk = [
    ["xulmo-social", "X 1", 5], ["abaal-gb", "A 1", 3], ["muraadso", "M 1", 0.1], ["muraadso", "M 2", 0.2],
  ] as const;
  for (const [cat, name, price] of pk) {
    await query(`INSERT INTO packages (id, company_id, category_id, name, price) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), CO, cat, name, price]);
  }
});

after(async () => {
  await query(`DELETE FROM packages WHERE company_id=$1`, [CO]);
  await query(`DELETE FROM service_categories WHERE company_id=$1`, [CO]);
  await query(`DELETE FROM companies WHERE id=$1`, [CO]);
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

const catNames = async () => (await call("GET", `/companies/${CO}/categories`, undefined, null)).body.map((c: any) => c.name);
/** Category order as the apps see it: first appearance in the package list. */
const pkgCategoryOrder = async () => {
  const rows = (await call("GET", `/companies/${CO}/packages?audience=customer`, undefined, null)).body as any[];
  return [...new Set(rows.map((p) => p.categoryId))];
};

test("new categories keep the order they were added in (each new one goes last)", async () => {
  assert.deepEqual(await catNames(), ["Xulmo social", "Abaal GB", "Muraadso"]);
  assert.deepEqual(await pkgCategoryOrder(), ["xulmo-social", "abaal-gb", "muraadso"]);
});

test("the Admin's order is saved and used everywhere -- never by price or name", async () => {
  const order = [ids["Muraadso"], ids["Xulmo social"], ids["Abaal GB"]];
  const r = await call("PUT", `/admin/companies/${CO}/categories/order`, { categoryIds: order });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((c: any) => c.name), ["Muraadso", "Xulmo social", "Abaal GB"]);
  assert.deepEqual(await catNames(), ["Muraadso", "Xulmo social", "Abaal GB"]);
  assert.deepEqual(await pkgCategoryOrder(), ["muraadso", "xulmo-social", "abaal-gb"]);
  const admin = await call("GET", `/admin/categories?companyId=${CO}`);
  assert.deepEqual(admin.body.map((c: any) => c.name), ["Muraadso", "Xulmo social", "Abaal GB"]);
  assert.deepEqual(admin.body.map((c: any) => c.sortOrder), [1, 2, 3]);
});

test("a partial, duplicated or foreign list is refused, and only staff may reorder", async () => {
  assert.equal((await call("PUT", `/admin/companies/${CO}/categories/order`, { categoryIds: [ids["Muraadso"]] })).status, 400);
  assert.equal((await call("PUT", `/admin/companies/${CO}/categories/order`, { categoryIds: [ids["Muraadso"], ids["Muraadso"], ids["Abaal GB"]] })).status, 400);
  assert.equal((await call("PUT", `/admin/companies/${CO}/categories/order`, { categoryIds: [ids["Muraadso"], ids["Abaal GB"], randomUUID()] })).status, 400);
  const customer = signAccessToken(randomUUID(), "customer");
  const denied = await call("PUT", `/admin/companies/${CO}/categories/order`, { categoryIds: Object.values(ids) }, customer);
  assert.ok(denied.status === 401 || denied.status === 403, String(denied.status));
  assert.deepEqual(await catNames(), ["Muraadso", "Xulmo social", "Abaal GB"], "unchanged");
});

// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/publicPackagesCategoryName.test.ts
//
// Regression coverage for a real reported bug: the Customer App's "Choose
// an internet type" screen showed "Adsl Plu" (a title-cased, truncated
// package.categoryId slug) while the Admin Dashboard's own Category name
// field for the same category correctly said "ADSL Plus" — the public
// GET /companies/:id/packages route never exposed the category's real
// name at all, so the Customer App had no choice but to derive a label
// from the slug itself. Fixed by LEFT JOINing service_categories on
// (company_id, slug) and adding categoryName to each package row, without
// touching category_id/slug, package-category relationships, or USSD
// templates at all -- this test proves exactly that: the real category
// name is now present, categoryId/everything else is untouched, and a
// package whose categoryId doesn't match any current category slug is
// still returned (not dropped) with a null categoryName.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { companiesRouter } from "../companies.routes.js";

const COMPANY_ID = "test-category-name-co";
const CATEGORY_ID = randomUUID();

let packageId: string;
let orphanPackageId: string;
const app = express();
app.use(express.json());
app.use(companiesRouter);
let server: http.Server;
let baseUrl: string;

before(async () => {
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Test Category Name Co',1,'#000000')`, [COMPANY_ID]);
  // The exact real-world shape: the category's slug is truncated/stale
  // ("adsl-plu") while its real display name is correct ("ADSL Plus") --
  // proves the fix reads the name, not a re-derivation of the slug.
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'adsl-plu','ADSL Plus')`, [CATEGORY_ID, COMPANY_ID]);

  packageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, active) VALUES (gen_random_uuid(),$1,'adsl-plu','Test Package',10.00,true) RETURNING id`,
      [COMPANY_ID]
    )
  )!.id;
  // A package whose category_id doesn't match any current category slug --
  // must still be returned (never dropped), just with categoryName null.
  orphanPackageId = (
    await queryOne<{ id: string }>(
      `INSERT INTO packages (id, company_id, category_id, name, price, active) VALUES (gen_random_uuid(),$1,'no-such-slug','Orphan Package',5.00,true) RETURNING id`,
      [COMPANY_ID]
    )
  )!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await query(`DELETE FROM packages WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM service_categories WHERE id=$1`, [CATEGORY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await pool.end();
});

test("GET /companies/:id/packages includes the real category name alongside the untouched category_id/slug", async () => {
  const res = await fetch(`${baseUrl}/companies/${COMPANY_ID}/packages`);
  assert.equal(res.status, 200);
  const body: any = await res.json();

  const pkg = body.find((p: any) => p.id === packageId);
  assert.ok(pkg, "expected the seeded package in the response");
  assert.equal(pkg.categoryId, "adsl-plu", "categoryId (slug) must be completely untouched");
  assert.equal(pkg.categoryName, "ADSL Plus", "categoryName must be the real name, not a derived/title-cased slug");
});

test("a package whose categoryId matches no current category slug is still returned, with categoryName null", async () => {
  const res = await fetch(`${baseUrl}/companies/${COMPANY_ID}/packages`);
  const body: any = await res.json();

  const orphan = body.find((p: any) => p.id === orphanPackageId);
  assert.ok(orphan, "an orphaned-category package must never be dropped from the list");
  assert.equal(orphan.categoryId, "no-such-slug");
  assert.equal(orphan.categoryName, null);
});

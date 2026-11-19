// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/db/__tests__/seedKeepsCompanyStatus.test.ts
//
// The seed runs on every server start (server.ts). It used to set Amtel
// offline every time, so each restart or deploy took Amtel out of the
// apps. It must never change an existing company's status.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { query, queryOne, pool } from "../pool.js";
import { seedAll } from "../seed.js";

after(async () => { await pool.end(); });

test("a restart (seed) keeps the admin's company status: Amtel stays online", async () => {
  await seedAll();
  await query(`UPDATE companies SET status='online' WHERE id='amtel'`);
  await query(`UPDATE companies SET status='offline' WHERE id='somtel'`);
  await seedAll();
  await seedAll();
  assert.equal((await queryOne<{ status: string }>(`SELECT status FROM companies WHERE id='amtel'`))!.status, "online");
  assert.equal((await queryOne<{ status: string }>(`SELECT status FROM companies WHERE id='somtel'`))!.status, "offline");
});

test("on a brand-new database Amtel is created offline, the others online", async () => {
  await query(`UPDATE companies SET status='online' WHERE id='somtel'`);
  const ids = ["hormuud", "somnet", "somtel", "amtel"];
  const rows = await query<{ id: string; status: string }>(`SELECT id, status FROM companies WHERE id = ANY($1)`, [ids]);
  assert.equal(rows.length, 4);
  // Amtel was created by the first seed run in this test DB (offline), then switched on above.
  assert.ok(rows.every((r) => r.status === "online"));
});

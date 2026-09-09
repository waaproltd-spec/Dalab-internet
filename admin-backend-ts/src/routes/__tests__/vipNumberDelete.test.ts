// Run against a real local Postgres test database (see
// vipNumberReservationExpiry.test.ts's own header for the exact command).
//
// Reproduces the exact production scenario reported live: a VIP number
// genuinely status='available' (confirmed directly against the DB) whose
// only order history is fully terminal ('expired'), with no package
// membership -- DELETE was still returning 409 "reserved or sold" instead
// of succeeding, even after the soft-delete fix (097_vip_number_soft_delete.sql).
// This exercises the real HTTP route end-to-end against that exact fixture
// shape to prove (or disprove) the fix actually works, rather than reasoning
// about the code in the abstract.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { vipNumbersRouter } from "../vipNumbers.routes.js";

const app = express();
app.use(express.json());
app.use(vipNumbersRouter);

let server: http.Server;
let baseUrl: string;
let superAdminToken: string;
let companyId: string;
const SUPER_ADMIN_ID = randomUUID();

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'vip-delete-test-super@example.com','x','super_admin')`, [
    SUPER_ADMIN_ID,
  ]);
  superAdminToken = signAccessToken(SUPER_ADMIN_ID, "super_admin");

  const company = await queryOne<{ id: string }>(
    `INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'VIP Delete Test Co',1,'#123456') RETURNING id`,
    [randomUUID()]
  );
  companyId = company!.id;

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // customer_id first (captured before the orders referencing them are
  // deleted below) -- vip_number_orders.customer_id is itself ON DELETE
  // RESTRICT, so deleting customers before their orders would fail the
  // exact same way this whole test file is about.
  const orderedCustomers = await query<{ customer_id: string }>(`SELECT customer_id FROM vip_number_orders WHERE company_id=$1`, [companyId]);
  await query(`DELETE FROM vip_number_orders WHERE company_id=$1`, [companyId]);
  await query(`DELETE FROM vip_numbers WHERE company_id=$1`, [companyId]);
  await query(`DELETE FROM companies WHERE id=$1`, [companyId]);
  if (orderedCustomers.length > 0) {
    await query(`DELETE FROM customers WHERE id = ANY($1)`, [orderedCustomers.map((c) => c.customer_id)]);
  }
  await query(`DELETE FROM admin_users WHERE id=$1`, [SUPER_ADMIN_ID]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function asSuperAdmin(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${superAdminToken}` } });
}

test("DELETE succeeds (soft-delete) for an Available number whose only orders are terminal ('expired')", async () => {
  const vipNumberId = randomUUID();
  await query(
    `INSERT INTO vip_numbers (id, company_id, phone_number, category, price, status) VALUES ($1,$2,'620999999','gold',1.00,'available')`,
    [vipNumberId, companyId]
  );
  // Two directly-inserted terminal orders, exactly mirroring production's
  // real state (both 'expired', not created through the actual reservation
  // flow -- irrelevant here, only their FK reference to vip_numbers matters).
  for (let i = 0; i < 2; i++) {
    const orderId = "VIP" + randomUUID().slice(0, 9).replace(/-/g, "");
    // Phone derived from a fresh UUID each run (not a fixed literal) so a
    // second run against the same DB (a leftover row from an earlier crash,
    // or simply re-running locally) never collides on customers.phone_key.
    const phone = randomUUID().replace(/-/g, "").slice(0, 9);
    const customer = await queryOne<{ id: string }>(
      `INSERT INTO customers (id, phone, name) VALUES ($1,$2,'Delete Test Customer') RETURNING id`,
      [randomUUID(), phone]
    );
    await query(
      `INSERT INTO vip_number_orders
         (id, vip_number_id, customer_id, company_id, phone_number, category, price, customer_full_name, payment_method, sender_phone, status, payment_status)
       VALUES ($1,$2,$3,$4,'620999999','gold',1.00,'Test Customer Full Name','evc',$5,'expired','pending')`,
      [orderId, vipNumberId, customer!.id, companyId, phone]
    );
  }

  const before = await queryOne<{ status: string; deleted_at: string | null }>(`SELECT status, deleted_at FROM vip_numbers WHERE id=$1`, [
    vipNumberId,
  ]);
  assert.equal(before?.status, "available", "sanity check: fixture must genuinely be available before delete");
  assert.equal(before?.deleted_at, null);

  const res = await asSuperAdmin(`/admin/vip-numbers/${vipNumberId}`, { method: "DELETE" });
  const body = (await res.json()) as { softDeleted?: boolean; error?: string };
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.softDeleted, true);

  const after_ = await queryOne<{ status: string; deleted_at: string | null }>(`SELECT status, deleted_at FROM vip_numbers WHERE id=$1`, [
    vipNumberId,
  ]);
  assert.notEqual(after_?.deleted_at, null, "row should be soft-deleted, not hard-deleted (order history references it)");

  // Excluded from the admin list...
  const listRes = await asSuperAdmin(`/admin/vip-numbers?companyId=${companyId}`);
  const list = (await listRes.json()) as Array<{ id: string }>;
  assert.ok(!list.some((n) => n.id === vipNumberId), "soft-deleted number must not appear in the admin Inventory list");

  // ...and from the public customer-facing catalog.
  const publicRes = await fetch(`${baseUrl}/vip-numbers?companyId=${companyId}`);
  const publicList = (await publicRes.json()) as Array<{ id: string }>;
  assert.ok(!publicList.some((n) => n.id === vipNumberId), "soft-deleted number must not appear in the public catalog");
});

test("DELETE still blocks a genuinely Reserved number with the existing 409", async () => {
  const vipNumberId = randomUUID();
  await query(
    `INSERT INTO vip_numbers (id, company_id, phone_number, category, price, status) VALUES ($1,$2,'620999998','gold',1.00,'reserved')`,
    [vipNumberId, companyId]
  );
  const res = await asSuperAdmin(`/admin/vip-numbers/${vipNumberId}`, { method: "DELETE" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /reserved or sold/i);
  await query(`DELETE FROM vip_numbers WHERE id=$1`, [vipNumberId]);
});

// Run against a freshly migrated local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false JWT_SECRET=... \
//     npx tsx --test --test-force-exit src/routes/__tests__/customerPinLogin.test.ts
//
// The Customer App's one Number + PIN screen (POST /auth/customer/enter):
// a registered number needs its own PIN and a wrong PIN never creates an
// account; an unknown number gets a new account; one number is always one
// account, whatever its spelling and however many requests race; wrong
// PINs lock the number; a Super Admin PIN reset lets the customer back in.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { hashPassword, signAccessToken } from "../../auth/crypto.js";
import { authRouter } from "../auth.routes.js";
import { customersRouter } from "../customers.routes.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(authRouter);
app.use(customersRouter);
let server: http.Server;
let base: string;
const SUPER_ADMIN = randomUUID();
let adminToken: string;

before(async () => {
  await query(
    `INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'pinlogin-sa@test.local','x','super_admin')`,
    [SUPER_ADMIN]
  );
  adminToken = signAccessToken(SUPER_ADMIN, "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

async function call(method: string, p: string, body?: unknown, token?: string) {
  const res = await fetch(base + p, {
    method,
    // A fresh client address per call keeps the per-IP limiter out of the
    // way, so the per-number lock is what these tests see.
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const enter = (phone: string, pin: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/auth/customer/enter", { phone, pin, device: { deviceId: `dev-${phone}`, platform: "web" }, ...extra });
const rows = (local: string) =>
  query<any>(`SELECT * FROM customers WHERE phone IN ($1, '252' || $1, '+252' || $1)`, [local]);

test("a new number gets an account automatically; the PIN is stored hashed, never in plain text", async () => {
  const r = await enter("252615000001", "4826");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.ok(r.body.accessToken && r.body.refreshToken);
  assert.equal(r.body.customer.phone, "252615000001");
  const [row] = await rows("615000001");
  assert.ok(row.pin_hash.startsWith("$2"), "bcrypt hash");
  assert.ok(!JSON.stringify(row).includes('"4826"'), "the PIN itself is stored nowhere");
  assert.equal(row.password_hash, null);
});

test("the same number and PIN again signs in to that same account", async () => {
  const first = await enter("252615000002", "1357");
  const again = await enter("252615000002", "1357");
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.customer.id, first.body.customer.id);
  assert.equal((await rows("615000002")).length, 1);
});

test("a registered number with a wrong PIN is refused and no account is created", async () => {
  const first = await enter("252615000003", "2468");
  const wrong = await enter("252615000003", "9999");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, "wrong_pin");
  assert.equal(wrong.body.accessToken, undefined, "no session");
  assert.equal(wrong.body.attemptsLeft, 4);
  const all = await rows("615000003");
  assert.equal(all.length, 1, "still exactly one account");
  assert.equal(all[0].id, first.body.customer.id);
});

test("every spelling of a number is the same account (+252, 252, 9 digits)", async () => {
  const a = await enter("+252615000004", "1111");
  assert.equal(a.status, 201);
  for (const spelling of ["252615000004", "615000004", "+252 61 500 0004"]) {
    const r = await enter(spelling, "1111");
    assert.equal(r.status, 200, spelling);
    assert.equal(r.body.customer.id, a.body.customer.id, spelling);
  }
  assert.equal((await enter("615000004", "2222")).status, 401, "and a wrong PIN under another spelling is still wrong");
  assert.equal((await rows("615000004")).length, 1);
});

test("an existing account stored in another spelling is found, not duplicated", async () => {
  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone, name, pin_hash) VALUES ($1, '+252615000005', 'Old Spelling', $2)`, [id, await hashPassword("5555")]);
  const r = await enter("252615000005", "5555");
  assert.equal(r.status, 200);
  assert.equal(r.body.customer.id, id);
  assert.equal((await enter("252615000005", "1234")).status, 401);
  assert.equal((await rows("615000005")).length, 1);
});

test("the database itself refuses a second row for the same number in another spelling", async () => {
  await enter("252615000006", "6666");
  await assert.rejects(
    query(`INSERT INTO customers (id, phone) VALUES ($1, '615000006')`, [randomUUID()]),
    (err: any) => err.code === "23505"
  );
});

test("10 simultaneous first logins for one new number make exactly one account", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => enter("252615000007", "7777")));
  assert.ok(results.every((r) => r.status === 200 || r.status === 201), JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.status === 201).length, 1, "only one created it");
  assert.equal(new Set(results.map((r) => r.body.customer.id)).size, 1);
  assert.equal((await rows("615000007")).length, 1);
});

test("two people racing to claim a new number with different PINs: one gets it, the other is refused", async () => {
  const [a, b] = await Promise.all([enter("252615000008", "1212"), enter("252615000008", "3434")]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 401]);
  assert.equal((await rows("615000008")).length, 1);
});

test("customers from older app versions keep their accounts: password, recovery PIN, or neither", async () => {
  // Signed up with a password (and the recovery PIN the old Create Account set).
  const both = randomUUID();
  await query(`INSERT INTO customers (id, phone, name, password_hash, pin_hash) VALUES ($1,'252615000009','Both',$2,$3)`, [both, await hashPassword("secret-pass"), await hashPassword("4040")]);
  assert.equal((await enter("252615000009", "4040")).body.customer.id, both, "their PIN works");
  assert.equal((await enter("252615000009", "secret-pass")).body.customer.id, both, "so does their old password");
  assert.equal((await enter("252615000009", "0000")).status, 401);

  // Old phone-only sign-in, never had a PIN or password: the first PIN
  // becomes theirs, history kept; after that it's a normal PIN.
  const legacy = randomUUID();
  await query(`INSERT INTO customers (id, phone, name, macaash_points) VALUES ($1,'252615000010','Legacy',120)`, [legacy]);
  const claimed = await enter("252615000010", "8080");
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.created, false);
  assert.equal(claimed.body.customer.id, legacy);
  assert.equal((await queryOne<any>(`SELECT macaash_points FROM customers WHERE id=$1`, [legacy])).macaash_points, 120);
  assert.equal((await enter("252615000010", "9090")).status, 401, "the claimed PIN is now required");
});

test("5 wrong PINs lock the number for 15 minutes, even with the right PIN; a correct PIN before that resets the count", async () => {
  await enter("252615000011", "1188");
  for (let i = 0; i < 4; i++) assert.equal((await enter("252615000011", "0000")).status, 401);
  assert.equal((await enter("252615000011", "1188")).status, 200, "right PIN before the 5th wrong one still works");
  for (let i = 0; i < 4; i++) assert.equal((await enter("252615000011", "0000")).status, 401, "count restarted");
  const fifth = await enter("252615000011", "0000");
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.code, "pin_locked");
  const locked = await enter("252615000011", "1188");
  assert.equal(locked.status, 429, "locked even with the right PIN");
  assert.equal(locked.body.accessToken, undefined);
  await query(`UPDATE customer_login_failures SET locked_until = now() - interval '1 second' WHERE phone_local='615000011'`);
  assert.equal((await enter("252615000011", "1188")).status, 200, "unlocked after the lock ends");
});

test("a wrong number format or a bad new PIN is refused without creating anything", async () => {
  assert.equal((await enter("12345", "1234")).body.code, "invalid_phone");
  assert.equal((await enter("252615000012", "")).body.code, "pin_required");
  assert.equal((await enter("252615000012", "12")).body.code, "invalid_pin");
  assert.equal((await enter("252615000012", "12ab")).body.code, "invalid_pin");
  assert.equal((await rows("615000012")).length, 0);
});

test("Super Admin PIN reset: the old PIN stops working, the new one works, old sessions end, the lock lifts", async () => {
  const first = await enter("252615000013", "1313");
  for (let i = 0; i < 5; i++) await enter("252615000013", "0000");
  assert.equal((await enter("252615000013", "1313")).status, 429);
  const id = first.body.customer.id;
  const reset = await call("POST", `/admin/customers/${id}/pin/generate`, undefined, adminToken);
  assert.equal(reset.status, 200);
  assert.match(reset.body.pin, /^\d{4}$/);
  assert.equal((await enter("252615000013", "1313")).status, 401, "old PIN no longer works");
  const ok = await enter("252615000013", reset.body.pin);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.customer.id, id, "same account");
  const old = await queryOne<any>(`SELECT revoked FROM refresh_tokens WHERE subject_id=$1 ORDER BY created_at ASC LIMIT 1`, [id]);
  assert.equal(old.revoked, true, "the session from before the reset was ended");

  const set = await call("PUT", `/admin/customers/${id}/pin`, { pin: "246810" }, adminToken);
  assert.equal(set.status, 200);
  assert.equal((await enter("252615000013", "246810")).status, 200);
});

test("a PIN-only account's PIN can't be removed (it would leave the number open to anyone)", async () => {
  const r = await enter("252615000014", "1414");
  const del = await call("DELETE", `/admin/customers/${r.body.customer.id}/pin`, undefined, adminToken);
  assert.equal(del.status, 409);
  assert.equal(del.body.code, "pin_is_login");
  const self = await call("DELETE", "/customer/pin", undefined, r.body.accessToken);
  assert.equal(self.status, 409);
  assert.equal((await enter("252615000014", "1414")).status, 200, "PIN still in place");
});

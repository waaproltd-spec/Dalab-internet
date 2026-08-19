// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test --test-force-exit src/routes/__tests__/resellerWithdrawalInteractivePayout.test.ts
//
// Covers the eDahab-style multi-step Reseller Withdrawal payout config
// (migration 060, reseller_withdrawal_interactive_payout_config): unlike
// Hormuud's one-shot payout_ussd_template, eDahab's carrier menu is
// interactive (*300# -> "3" -> number -> amount -> PIN), so the Agent App
// needs an initial dial string plus an ordered reply sequence instead of one
// combined string. Confirms: the admin config endpoints round-trip
// initialDial/replySteps and keep the PIN write-only; GET
// .../pending-payout attaches a decrypted interactivePayout object only once
// both steps AND a PIN are configured (never partial config, never the raw
// pin_encrypted column); and a plain one-shot (Hormuud-style) company is
// completely unaffected by any of this.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { resellerDepositsWithdrawalsRouter } from "../resellerDepositsWithdrawals.routes.js";
import { resellerPaymentConfigRouter } from "../resellerPaymentConfig.routes.js";

const EDAHAB_ID = "test-interactive-edahab";
const HORMUUD_ID = "test-interactive-hormuud";
const RESELLER_ID = randomUUID();
const AGENT_ID = randomUUID();
const ADMIN_ID = randomUUID();
const DEVICE_ID = "test-interactive-device-1";

const app = express();
app.use(express.json());
app.use(resellerDepositsWithdrawalsRouter);
app.use(resellerPaymentConfigRouter);
let server: http.Server;
let baseUrl: string;
let agentToken: string;
let superAdminToken: string;

before(async () => {
  await query(`DELETE FROM reseller_withdrawal_dial_attempts WHERE withdrawal_id IN (SELECT id FROM reseller_withdrawals WHERE company_id IN ($1,$2))`, [
    EDAHAB_ID,
    HORMUUD_ID,
  ]);
  await query(`DELETE FROM reseller_withdrawals WHERE company_id IN ($1,$2)`, [EDAHAB_ID, HORMUUD_ID]);
  const priorReseller = await queryOne<{ id: string }>(`SELECT id FROM resellers WHERE reseller_login_id='RSLINTERACTIVE'`);
  if (priorReseller) {
    await query(`DELETE FROM reseller_wallets WHERE reseller_id=$1`, [priorReseller.id]);
    await query(`DELETE FROM resellers WHERE id=$1`, [priorReseller.id]);
  }
  await query(`DELETE FROM reseller_withdrawal_interactive_payout_config WHERE company_id IN ($1,$2)`, [EDAHAB_ID, HORMUUD_ID]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2)`, [EDAHAB_ID, HORMUUD_ID]);
  await query(`DELETE FROM agents WHERE device_id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);
  await query(`DELETE FROM admin_users WHERE email='interactive-payout-test-admin@example.com'`);

  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'interactive-payout-test-admin@example.com','x','super_admin')`, [
    ADMIN_ID,
  ]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Interactive Device')`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000066', 'Test Agent', 'x', $2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1, 'eDahab', 2, '#F2C200'), ($2, 'Hormuud', 1, '#16A34A')`, [
    EDAHAB_ID,
    HORMUUD_ID,
  ]);
  await query(`UPDATE companies SET payout_ussd_template='*726*{number}*{amount}*8233#' WHERE id=$1`, [HORMUUD_ID]);
  await query(`INSERT INTO resellers (id, reseller_login_id, name, pin_hash) VALUES ($1, 'RSLINTERACTIVE', 'Test Reseller', 'x')`, [RESELLER_ID]);
  await query(`INSERT INTO reseller_wallets (reseller_id, balance) VALUES ($1, 50)`, [RESELLER_ID]);

  agentToken = signAccessToken(AGENT_ID, "agent");
  superAdminToken = signAccessToken(ADMIN_ID, "super_admin");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

function adminHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${superAdminToken}` };
}

async function createWithdrawal(companyId: string, destinationNumber: string): Promise<string> {
  const id = "WDR" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO reseller_withdrawals (id, reseller_id, company_id, destination_number, amount, status, commission_percentage, bonus_amount, customer_receives_amount)
     VALUES ($1,$2,$3,$4,10,'reserved',0,0,10)`,
    [id, RESELLER_ID, companyId, destinationNumber]
  );
  return id;
}

async function getPendingPayout(): Promise<any[]> {
  const res = await fetch(`${baseUrl}/agent/reseller-withdrawals/pending-payout`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as any[];
}

test("PUT .../payout-interactive-steps sets initialDial/replySteps, never touches the PIN", async () => {
  const res = await fetch(`${baseUrl}/admin/companies/${EDAHAB_ID}/payout-interactive-steps`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ initialDial: "*300#", replySteps: ["3", "{number}", "{amount}"] }),
  });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.initialDial, "*300#");
  assert.deepEqual(body.replySteps, ["3", "{number}", "{amount}"]);

  const listRes = await fetch(`${baseUrl}/admin/reseller-withdrawal-interactive-payout`, { headers: adminHeaders() });
  const list = (await listRes.json()) as any[];
  const row = list.find((r: any) => r.companyId === EDAHAB_ID);
  assert.ok(row, "the new config must appear in the admin list");
  assert.equal(row.pinIsSet, false, "PIN not set yet");
  assert.equal(row.initialDial, "*300#");
});

test("a withdrawal on an interactive-configured company is NOT dialable until the PIN is also set", async () => {
  const withdrawalId = await createWithdrawal(EDAHAB_ID, "620338686");
  const pending = await getPendingPayout();
  assert.ok(
    !pending.some((p) => p.id === withdrawalId),
    "steps alone (no PIN yet) must never surface a dialable pending payout — there'd be no way to finish the transfer"
  );
});

test("PUT .../payout-interactive-pin is write-only — GET never returns the raw PIN, only pinIsSet", async () => {
  const res = await fetch(`${baseUrl}/admin/companies/${EDAHAB_ID}/payout-interactive-pin`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ pin: "8233" }),
  });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.pinIsSet, true);
  assert.equal("pin" in body, false, "the PUT response itself must never echo the PIN back");

  const listRes = await fetch(`${baseUrl}/admin/reseller-withdrawal-interactive-payout`, { headers: adminHeaders() });
  const list = (await listRes.json()) as any[];
  const row = list.find((r: any) => r.companyId === EDAHAB_ID);
  assert.equal(row.pinIsSet, true);
  assert.equal("pinEncrypted" in row, false, "the raw encrypted column must never reach an API response");
});

test("once steps AND a PIN are both configured, GET .../pending-payout attaches a decrypted interactivePayout with {number}/{amount} left for the client to substitute", async () => {
  const withdrawalId = await createWithdrawal(EDAHAB_ID, "620338686");
  const pending = await getPendingPayout();
  const row = pending.find((p) => p.id === withdrawalId);
  assert.ok(row, "now dialable — both steps and PIN are configured");
  assert.equal(row.interactivePayout.initialDial, "*300#");
  assert.deepEqual(row.interactivePayout.replySteps, ["3", "{number}", "{amount}"]);
  assert.equal(row.interactivePayout.pin, "8233", "the real PIN, decrypted server-side for this one live dial");
  assert.equal(row.payoutUssdTemplate, null, "an interactive-only company must never also carry a one-shot template");
});

test("a plain one-shot (Hormuud-style) company is completely unaffected by the interactive config feature", async () => {
  const withdrawalId = await createWithdrawal(HORMUUD_ID, "617080008");
  const pending = await getPendingPayout();
  const row = pending.find((p) => p.id === withdrawalId);
  assert.ok(row, "one-shot payout must still surface exactly as before");
  assert.equal(row.payoutUssdTemplate, "*726*{number}*{amount}*8233#");
  assert.equal("interactivePayout" in row, false, "a one-shot company must never carry an interactivePayout object");
});

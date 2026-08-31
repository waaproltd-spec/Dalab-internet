// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/resellerWithdrawalDialAttemptReport.test.ts
//
// Real HTTP coverage of PUT /agent/reseller-withdrawal-dial-attempts/:attemptId —
// the actual route the Agent App calls, not just the extracted completion
// function (see resellerWithdrawalDialResultCompletion.test.ts for that
// half). Confirms each of the three dial outcomes does exactly what it
// should to the withdrawal: 'success' completes + debits, 'failed' releases
// with no wallet touch (nothing was ever reserved at creation), 'ambiguous'
// touches neither — stays reserved for a human or a later SMS to resolve.
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

const COMPANY_ID = "test-dialreport-hormuud";
const RESELLER_ID = randomUUID();
const AGENT_ID = randomUUID();
const DEVICE_ID = "test-dialreport-device-1";

const app = express();
app.use(express.json());
app.use(resellerDepositsWithdrawalsRouter);
let server: http.Server;
let baseUrl: string;
let agentToken: string;

before(async () => {
  // Scoped by the fixed company_id/login_id/device_id, not the freshly-
  // randomized RESELLER_ID/AGENT_ID — a run killed mid-test (e.g. SIGKILL,
  // no cleanup) leaves rows under a DIFFERENT random id but the SAME fixed
  // company_id, which would otherwise FK-block this file's own
  // `DELETE FROM companies` below. Same fix as
  // resellerWithdrawalDialResultCompletion.test.ts.
  await query(`DELETE FROM reseller_withdrawals WHERE company_id=$1`, [COMPANY_ID]);
  const priorReseller = await queryOne<{ id: string }>(`SELECT id FROM resellers WHERE reseller_login_id='RSLDIALREPORT'`);
  if (priorReseller) {
    await query(`DELETE FROM reseller_wallet_transactions WHERE reseller_id=$1`, [priorReseller.id]);
    await query(`DELETE FROM reseller_wallets WHERE reseller_id=$1`, [priorReseller.id]);
    await query(`DELETE FROM resellers WHERE id=$1`, [priorReseller.id]);
  }
  await query(`DELETE FROM reseller_wallet_transactions WHERE reseller_id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM reseller_wallets WHERE reseller_id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM resellers WHERE id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM agents WHERE device_id=$1 OR id=$2`, [DEVICE_ID, AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Dial Report Device')`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000077', 'Test Agent', 'x', $2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1, 'Hormuud', 1, '#16A34A')`, [COMPANY_ID]);
  await query(`INSERT INTO resellers (id, reseller_login_id, name, pin_hash) VALUES ($1, 'RSLDIALREPORT', 'Test Reseller', 'x')`, [RESELLER_ID]);
  agentToken = signAccessToken(AGENT_ID, "agent");

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

async function fundWallet(amount: number) {
  await query(`INSERT INTO reseller_wallets (reseller_id, balance) VALUES ($1, $2) ON CONFLICT (reseller_id) DO UPDATE SET balance=$2`, [
    RESELLER_ID,
    amount,
  ]);
}

async function walletBalance(): Promise<number> {
  const row = await queryOne<{ balance: string }>(`SELECT balance FROM reseller_wallets WHERE reseller_id=$1`, [RESELLER_ID]);
  return Number(row!.balance);
}

async function createWithdrawal(amount: number, customerReceivesAmount: number): Promise<string> {
  const id = "WDR" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO reseller_withdrawals (id, reseller_id, company_id, destination_number, amount, status, commission_percentage, bonus_amount, customer_receives_amount)
     VALUES ($1,$2,$3,'617080092',$4,'sent',5,$5,$6)`,
    [id, RESELLER_ID, COMPANY_ID, amount, customerReceivesAmount - amount, customerReceivesAmount]
  );
  return id;
}

async function createPendingDialAttempt(withdrawalId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO reseller_withdrawal_dial_attempts (withdrawal_id, ussd_string) VALUES ($1, '*726*617080092*1*05*0000#') RETURNING id`,
    [withdrawalId]
  );
  return row!.id;
}

function reportDialResult(attemptId: string, status: string, responseMessage?: string) {
  return fetch(`${baseUrl}/agent/reseller-withdrawal-dial-attempts/${attemptId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ status, responseMessage }),
  });
}

test("dial result 'success' completes the withdrawal and debits exactly once", async () => {
  await fundWallet(12.5);
  const withdrawalId = await createWithdrawal(1.0, 1.05);
  const attemptId = await createPendingDialAttempt(withdrawalId);

  const res = await reportDialResult(attemptId, "success", "ayaad uwareejisay");
  assert.equal(res.status, 200);

  const withdrawal = await queryOne<{ status: string }>(`SELECT status FROM reseller_withdrawals WHERE id=$1`, [withdrawalId]);
  assert.equal(withdrawal!.status, "completed");
  assert.equal(await walletBalance(), 11.5);
});

test("dial result 'failed' releases the withdrawal with no wallet touch", async () => {
  await fundWallet(12.5);
  const withdrawalId = await createWithdrawal(1.0, 1.05);
  const attemptId = await createPendingDialAttempt(withdrawalId);

  const res = await reportDialResult(attemptId, "failed", "khalad");
  assert.equal(res.status, 200);

  const withdrawal = await queryOne<{ status: string }>(`SELECT status FROM reseller_withdrawals WHERE id=$1`, [withdrawalId]);
  assert.equal(withdrawal!.status, "failed");
  assert.equal(await walletBalance(), 12.5, "nothing was ever reserved at creation, so 'refund' is simply never debiting");
});

test("dial result 'ambiguous' leaves the withdrawal untouched — not completed, not failed, still awaiting resolution", async () => {
  await fundWallet(12.5);
  const withdrawalId = await createWithdrawal(1.0, 1.05);
  const attemptId = await createPendingDialAttempt(withdrawalId);

  const res = await reportDialResult(attemptId, "ambiguous", "unclear response");
  assert.equal(res.status, 200);

  const withdrawal = await queryOne<{ status: string }>(`SELECT status FROM reseller_withdrawals WHERE id=$1`, [withdrawalId]);
  assert.equal(withdrawal!.status, "sent", "must stay exactly as it was — never auto-completed, never auto-failed");
  assert.equal(await walletBalance(), 12.5, "the amount stays safely reserved, neither debited nor refunded");
});

test("a duplicate/retried report of an already-resolved dial attempt is a no-op, not a second debit", async () => {
  await fundWallet(5.0);
  const withdrawalId = await createWithdrawal(1.0, 1.05);
  const attemptId = await createPendingDialAttempt(withdrawalId);

  const first = await reportDialResult(attemptId, "success");
  assert.equal(first.status, 200);
  assert.equal(await walletBalance(), 4.0);

  const second = await reportDialResult(attemptId, "success");
  assert.equal(second.status, 200, "the dial_attempts row's own CAS makes this a safe replay, same as the Internet Store equivalent");
  assert.equal(await walletBalance(), 4.0, "still only one debit");

  const ledgerRows = await query(`SELECT id FROM reseller_wallet_transactions WHERE reference_id=$1`, [withdrawalId]);
  assert.equal(ledgerRows.length, 1);
});

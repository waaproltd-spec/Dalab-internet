// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/resellerWithdrawalCreation.test.ts
//
// Regression coverage for POST /reseller/withdrawals' own balance check —
// the "Agent Balance / Insufficient Balance" investigation traced a report
// of "Agent has ~$5.36 but a withdrawal says insufficient balance" all the
// way to its real source: that message was Hormuud's own live USSD
// response about the AGENT's carrier SIM balance (fixed separately in
// UssdDialer.kt's failure-keyword classification), not this backend's
// wallet check at all. This file exists to pin down, with a real HTTP
// request through the actual route (not a reimplementation of its logic),
// exactly what THIS check does: it compares the requested amount against
// the RESELLER's own wallet balance (reseller_wallets.balance) — a
// completely different number from any Agent's carrier balance — and nothing
// else is added to that comparison (no fee, no commission, no reserve). A
// request at or under that balance must succeed; over it must be rejected
// with the exact "Insufficient wallet balance" message, never anything
// mentioning a different number.
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

const COMPANY_ID = "test-wdcreate-hormuud";
const RESELLER_ID = randomUUID();

const app = express();
app.use(express.json());
app.use(resellerDepositsWithdrawalsRouter);
let server: http.Server;
let baseUrl: string;
let resellerToken: string;

before(async () => {
  // RESELLER_ID is a fresh randomUUID() every run, but the row it creates
  // below has a fixed reseller_login_id — cleanup has to find any leftover
  // row from a PRIOR run by that stable login id (not by this run's new
  // RESELLER_ID, which a prior run's row will never match) or repeated
  // local runs collide on the unique login-id constraint.
  const priorReseller = await queryOne<{ id: string }>(`SELECT id FROM resellers WHERE reseller_login_id='RSLWDCREATE'`);
  if (priorReseller) {
    await query(`DELETE FROM reseller_withdrawals WHERE reseller_id=$1`, [priorReseller.id]);
    await query(`DELETE FROM reseller_wallet_transactions WHERE reseller_id=$1`, [priorReseller.id]);
    await query(`DELETE FROM reseller_wallets WHERE reseller_id=$1`, [priorReseller.id]);
    await query(`DELETE FROM resellers WHERE id=$1`, [priorReseller.id]);
  }
  await query(`DELETE FROM reseller_withdrawal_commission_config WHERE company_id=$1`, [COMPANY_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [COMPANY_ID]);

  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1, 'Hormuud', 1, '#16A34A')`, [COMPANY_ID]);
  // 5% commission, same shape as the real Hormuud config — proves the
  // balance check compares against the raw requested amount, never the
  // commission-inclusive customer_receives_amount.
  await query(`INSERT INTO reseller_withdrawal_commission_config (company_id, commission_percentage) VALUES ($1, 5)`, [COMPANY_ID]);
  await query(`INSERT INTO resellers (id, reseller_login_id, name, pin_hash) VALUES ($1, 'RSLWDCREATE', 'Test Reseller', 'x')`, [RESELLER_ID]);
  resellerToken = signAccessToken(RESELLER_ID, "reseller");

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

type WithdrawalResponse = { status: string; amount: string; customerReceivesAmount: string; error?: string };

function postWithdrawal(body: unknown) {
  return fetch(`${baseUrl}/reseller/withdrawals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${resellerToken}` },
    body: JSON.stringify(body),
  });
}

test("a withdrawal at or under the reseller's actual wallet balance succeeds — the exact regression this investigation asked for (Agent ~$5.36, requesting $2 must not be blocked)", async () => {
  await fundWallet(5.36);
  const res = await postWithdrawal({ companyId: COMPANY_ID, destinationNumber: "617080008", amount: 2.0, clientRequestId: randomUUID() });
  assert.equal(res.status, 201);
  const body = (await res.json()) as WithdrawalResponse;
  assert.equal(body.status, "reserved");
  assert.equal(Number(body.amount), 2.0);
  // 5% commission on $2 = $2.10 to the customer — but the wallet balance
  // check above compared against $2.00 (the raw amount), never $2.10.
  assert.equal(Number(body.customerReceivesAmount), 2.1);
});

test("a withdrawal requesting exactly the full wallet balance succeeds — the boundary is inclusive, not exclusive", async () => {
  await fundWallet(2.0);
  const res = await postWithdrawal({ companyId: COMPANY_ID, destinationNumber: "617080008", amount: 2.0, clientRequestId: randomUUID() });
  assert.equal(res.status, 201);
});

test("a withdrawal over the reseller's actual wallet balance is rejected with exactly 'Insufficient wallet balance' — no other number substituted in", async () => {
  await fundWallet(5.36);
  const res = await postWithdrawal({ companyId: COMPANY_ID, destinationNumber: "617080008", amount: 10.0, clientRequestId: randomUUID() });
  assert.equal(res.status, 400);
  const body = (await res.json()) as WithdrawalResponse;
  assert.equal(body.error, "Insufficient wallet balance");

  const rows = await query(`SELECT id FROM reseller_withdrawals WHERE reseller_id=$1 AND amount=10.00`, [RESELLER_ID]);
  assert.equal(rows.length, 0, "a rejected request must not leave a withdrawal row behind");
});

test("other in-flight (reserved) withdrawals never reduce how much a NEW request can draw against — only the raw wallet balance matters", async () => {
  await fundWallet(5.36);
  const first = await postWithdrawal({ companyId: COMPANY_ID, destinationNumber: "617080008", amount: 4.0, clientRequestId: randomUUID() });
  assert.equal(first.status, 201, "first withdrawal, well within balance, must succeed");

  // A second request that, added to the first, would exceed the wallet if
  // withdrawals still reserved capacity the old way — this backend's
  // current design intentionally allows it (the safety net is entirely at
  // SMS-confirmation time, per resellerSmsMatching.ts), so this must still
  // succeed purely because $2 alone is under the $5.36 raw balance.
  const second = await postWithdrawal({ companyId: COMPANY_ID, destinationNumber: "617080009", amount: 2.0, clientRequestId: randomUUID() });
  assert.equal(second.status, 201);

  const walletRow = await queryOne<{ balance: string }>(`SELECT balance FROM reseller_wallets WHERE reseller_id=$1`, [RESELLER_ID]);
  assert.equal(Number(walletRow!.balance), 5.36, "creating withdrawals must never itself touch the wallet balance");
});

// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/resellerWithdrawalDialResultCompletion.test.ts
//
// Covers the new PRIMARY completion path: the Agent App's USSD dial result,
// not the outgoing confirmation SMS, is what completes a Reseller Withdrawal
// and debits the wallet. Real production evidence for why: several
// same-amount, same-destination withdrawals can be in flight for one
// reseller at once, and the SMS matcher's FIFO-by-creation-time pairing
// completes whichever is OLDEST — a newer, otherwise-identical withdrawal
// sits unmatched indefinitely (confirmed live: WDR321833793 stayed 'sent'
// while a real $1.05 SMS to the same number completed the older
// WDR686135784 instead). Dialing is already 1:1 with a specific withdrawal,
// so completeResellerWithdrawalFromDialResult has no such ambiguity.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { completeResellerWithdrawalFromDialResult } from "../resellerDepositsWithdrawals.routes.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";

const RESELLER_ID = randomUUID();
const HORMUUD_ID = "test-dial-hormuud";
const HORMUUD_SMS_BODY = "[-E-Voucher-] $1.05 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080091), Haraagaagu waa $2.11.";
const HORMUUD_SMS_SENDER = "740";
const AGENT_ID = randomUUID();
const DEVICE_ID = "test-dial-device-1";

before(async () => {
  await query(`DELETE FROM sms_logs`);
  // Scoped by the fixed company_id, not the freshly-randomized RESELLER_ID —
  // a prior run's leftover rows were created under a DIFFERENT random
  // reseller_id but the SAME fixed HORMUUD_ID, so cleaning up only by
  // reseller_id here would leave them behind and break the later
  // `DELETE FROM companies` on this same company id (FK violation).
  await query(`DELETE FROM reseller_withdrawals WHERE company_id=$1`, [HORMUUD_ID]);
  // Same reasoning as above, for the fixed reseller_login_id: a prior run's
  // reseller row has a different random id but the same login_id, which
  // would otherwise collide with this run's INSERT below.
  const priorReseller = await queryOne<{ id: string }>(`SELECT id FROM resellers WHERE reseller_login_id='RSLDIALTEST'`);
  if (priorReseller) {
    await query(`DELETE FROM reseller_wallet_transactions WHERE reseller_id=$1`, [priorReseller.id]);
    await query(`DELETE FROM reseller_wallets WHERE reseller_id=$1`, [priorReseller.id]);
    await query(`DELETE FROM resellers WHERE id=$1`, [priorReseller.id]);
  }
  await query(`DELETE FROM reseller_wallet_transactions WHERE reseller_id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM reseller_wallets WHERE reseller_id=$1`, [RESELLER_ID]);
  await query(`DELETE FROM orders`);
  await query(`DELETE FROM packages WHERE company_id=$1`, [HORMUUD_ID]);
  await query(`DELETE FROM payment_wallets WHERE company_id=$1`, [HORMUUD_ID]);
  await query(`DELETE FROM companies WHERE id=$1`, [HORMUUD_ID]);
  // Scoped by the fixed device_id/phone, not the freshly-randomized
  // AGENT_ID — same collision reasoning as above.
  await query(`DELETE FROM agents WHERE device_id=$1 OR phone='252699000099'`, [DEVICE_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Dial Device')`, [DEVICE_ID]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000099', 'Test Dial Agent', 'x', $2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1, 'Hormuud', 1, '#16A34A')`, [HORMUUD_ID]);
  await query(`INSERT INTO resellers (id, reseller_login_id, name, pin_hash) VALUES ($1, 'RSLDIALTEST', 'Test Reseller', 'x')`, [RESELLER_ID]);
});

after(async () => {
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

async function createWithdrawal(
  destinationNumber: string,
  amount: number,
  customerReceivesAmount: number,
  status: "reserved" | "sent" = "sent"
): Promise<string> {
  const id = "WDR" + Math.floor(100000000 + Math.random() * 900000000);
  await query(
    `INSERT INTO reseller_withdrawals (id, reseller_id, company_id, destination_number, amount, status, commission_percentage, bonus_amount, customer_receives_amount)
     VALUES ($1,$2,$3,$4,$5,$6,5,$7,$8)`,
    [id, RESELLER_ID, HORMUUD_ID, destinationNumber, amount, status, customerReceivesAmount - amount, customerReceivesAmount]
  );
  return id;
}

test("dial SUCCESS completes the withdrawal and debits exactly the base amount, once", async () => {
  await fundWallet(12.5);
  const withdrawalId = await createWithdrawal("617080091", 1.0, 1.05);

  const result = await completeResellerWithdrawalFromDialResult(withdrawalId);
  assert.equal(result.completed, true);

  const withdrawal = await queryOne<{ status: string; completed_at: Date | null }>(
    `SELECT status, completed_at FROM reseller_withdrawals WHERE id=$1`,
    [withdrawalId]
  );
  assert.equal(withdrawal!.status, "completed");
  assert.ok(withdrawal!.completed_at, "completed_at must be set");
  assert.equal(await walletBalance(), 11.5, "wallet debits exactly the base amount (1.00), never customer_receives_amount (1.05)");

  const ledgerRows = await query<{ change_amount: string; source: string }>(
    `SELECT change_amount, source FROM reseller_wallet_transactions WHERE reference_id=$1`,
    [withdrawalId]
  );
  assert.equal(ledgerRows.length, 1, "exactly one ledger row");
  assert.equal(Number(ledgerRows[0].change_amount), -1.0);
  assert.equal(ledgerRows[0].source, "ussd_dial");
});

test("a duplicate/retried dial SUCCESS report never double-debits", async () => {
  await fundWallet(5.0);
  const withdrawalId = await createWithdrawal("617080091", 1.0, 1.05);

  const first = await completeResellerWithdrawalFromDialResult(withdrawalId);
  assert.equal(first.completed, true);
  assert.equal(await walletBalance(), 4.0);

  const second = await completeResellerWithdrawalFromDialResult(withdrawalId);
  assert.equal(second.completed, false, "already completed — the CAS finds nothing left to claim");
  assert.equal(await walletBalance(), 4.0, "still only debited once");

  const ledgerRows = await query(`SELECT id FROM reseller_wallet_transactions WHERE reference_id=$1`, [withdrawalId]);
  assert.equal(ledgerRows.length, 1);
});

test("the wallet is never debited twice when the SMS matcher and the dial result race for the same withdrawal", async () => {
  await fundWallet(5.0);
  const withdrawalId = await createWithdrawal("617080091", 1.0, 1.05);

  // Dial result wins the race first.
  const dialResult = await completeResellerWithdrawalFromDialResult(withdrawalId);
  assert.equal(dialResult.completed, true);
  assert.equal(await walletBalance(), 4.0);

  // The real confirmation SMS arrives afterward — must be a safe no-op, not
  // a second deduction, since dial-based completion already claimed it.
  const smsResult = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: HORMUUD_SMS_SENDER,
    body: HORMUUD_SMS_BODY,
    parsedProvider: "Hormuud",
    parsedAmount: 1.05,
    parsedPhone: "617080091",
    receivedAt: "2026-08-19T02:00:00Z",
  });
  assert.equal(smsResult.body.matchedResellerWithdrawalId, null, "already-completed withdrawal is no longer an in-flight candidate to match");
  assert.equal(await walletBalance(), 4.0, "the wallet must still show exactly one debit total");

  const ledgerRows = await query(`SELECT id FROM reseller_wallet_transactions WHERE reference_id=$1`, [withdrawalId]);
  assert.equal(ledgerRows.length, 1);
});

test("an insufficient-balance edge case rolls back cleanly — the withdrawal is not left stuck 'completed' with no matching deduction", async () => {
  await fundWallet(0.5);
  const withdrawalId = await createWithdrawal("617080091", 1.0, 1.05);

  const result = await completeResellerWithdrawalFromDialResult(withdrawalId);
  assert.equal(result.completed, false);

  const withdrawal = await queryOne<{ status: string }>(`SELECT status FROM reseller_withdrawals WHERE id=$1`, [withdrawalId]);
  assert.equal(withdrawal!.status, "sent", "the CAS rolled back — must not be stuck 'completed' with an uncovered debit");
  assert.equal(await walletBalance(), 0.5, "the floor must never be crossed");

  const ledgerRows = await query(`SELECT id FROM reseller_wallet_transactions WHERE reference_id=$1`, [withdrawalId]);
  assert.equal(ledgerRows.length, 0);
});

test("real production case: two identical-amount withdrawals to the same number — dialing each one individually resolves both, unlike SMS-only FIFO matching", async () => {
  // Reproduces WDR321833793/WDR686135784: two withdrawals, same destination,
  // same customer_receives_amount, both still 'sent'. SMS-only matching
  // would always resolve the older one first (FIFO), leaving the newer one
  // stuck no matter how many further SMS arrive with that same amount. Since
  // each dial attempt is tied to one specific withdrawal_id, both resolve.
  await fundWallet(10.0);
  const older = await createWithdrawal("617080091", 1.0, 1.05);
  const newer = await createWithdrawal("617080091", 1.0, 1.05);

  const newerResult = await completeResellerWithdrawalFromDialResult(newer);
  assert.equal(newerResult.completed, true, "the newer withdrawal completes on its own dial result, not blocked by the older one");

  const olderStatus = await queryOne<{ status: string }>(`SELECT status FROM reseller_withdrawals WHERE id=$1`, [older]);
  assert.equal(olderStatus!.status, "sent", "the older one is untouched by the newer one's dial result");

  const olderResult = await completeResellerWithdrawalFromDialResult(older);
  assert.equal(olderResult.completed, true, "the older withdrawal completes independently on its own dial result");

  assert.equal(await walletBalance(), 8.0, "both debited exactly once each — 10.00 - 1.00 - 1.00");
  const totalLedgerRows = await query(`SELECT id FROM reseller_wallet_transactions WHERE reference_id IN ($1,$2)`, [older, newer]);
  assert.equal(totalLedgerRows.length, 2, "one ledger row per withdrawal, never merged or duplicated");
});

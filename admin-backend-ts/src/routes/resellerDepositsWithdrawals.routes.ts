import { randomUUID } from "node:crypto";
import { Router } from "express";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { adjustResellerWallet } from "../utils/resellerWallet.js";
import { broadcast } from "../realtime/orderEvents.js";

export const resellerDepositsWithdrawalsRouter = Router();

const PAYMENT_NUMBER_RE = /^\d{6,15}$/;

// payout_ussd_template carries the payout company's PIN inlined (the Agent
// App needs the real string to dial automatically — see GET
// /agent/reseller-withdrawals/pending-payout below). Withdraw is now a fully
// automatic Agent-device payout (no reseller/agent manual dial), so the
// Reseller-facing app has no use for this field any more and must never
// receive the PIN over the wire — masked out here the same way orders.
// routes.ts's maskOrder() keeps ussd_generated off every non-agent response.
function maskWithdrawalForReseller<T extends Record<string, any> | undefined | null>(withdrawal: T): T {
  if (!withdrawal) return withdrawal;
  return { ...withdrawal, payout_ussd_template: null };
}
function maskWithdrawalsForReseller<T extends Record<string, any>>(withdrawals: T[]): T[] {
  return withdrawals.map(maskWithdrawalForReseller);
}

function depositRef(): string {
  return "DEP" + Math.floor(100000000 + Math.random() * 900000000);
}
function withdrawalRef(): string {
  return "WDR" + Math.floor(100000000 + Math.random() * 900000000);
}

// ==================== Deposit ("Lacag Ku Shub", Req. 8) ====================

const DEPOSIT_SELECT = `
  SELECT d.*, m.label AS method_label
  FROM reseller_deposits d
  JOIN reseller_deposit_methods m ON m.method = d.method
`;

// Shows Dalab's own collection number for the chosen payment method
// (reseller_deposit_methods, managed from Admin -> Resellers -> Payment —
// see migration 053's header comment for why deposits moved off companies.
// payment_number: the wallet has no per-company split, so neither should
// its deposit collection number). Does NOT touch the wallet — "must not be
// increased simply because the Reseller submits a Deposit request" (spec,
// Req. 8).
resellerDepositsWithdrawalsRouter.post("/reseller/deposits", requireAuth("reseller"), async (req, res) => {
  const method = String(req.body.method ?? "");
  const fromNumber = String(req.body.fromNumber ?? "").trim();
  const amount = Number(req.body.amount);
  const clientRequestId = req.body.clientRequestId ? String(req.body.clientRequestId) : null;

  if (!method || !fromNumber || !Number.isFinite(amount) || amount <= 0) {
    return sendJson(res, 400, { error: "method, fromNumber, and a positive amount are required" });
  }
  if (!PAYMENT_NUMBER_RE.test(fromNumber)) return sendJson(res, 400, { error: "fromNumber must be 6-15 digits" });

  const depositMethod = await queryOne<{ payment_number: string }>(
    `SELECT payment_number FROM reseller_deposit_methods WHERE method=$1`,
    [method]
  );
  if (!depositMethod) return sendJson(res, 404, { error: "Unknown payment method" });

  const id = depositRef();
  try {
    await query(
      `INSERT INTO reseller_deposits (id, reseller_id, method, to_number, from_number, amount, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, req.auth!.sub, method, depositMethod.payment_number, fromNumber, amount, clientRequestId]
    );
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === "23505" && pgErr.constraint === "idx_reseller_deposits_client_request_id") {
      return sendJson(res, 200, await queryOne(`${DEPOSIT_SELECT} WHERE d.client_request_id=$1`, [clientRequestId]));
    }
    throw err;
  }
  sendJson(res, 201, await queryOne(`${DEPOSIT_SELECT} WHERE d.id=$1`, [id]));
});

resellerDepositsWithdrawalsRouter.get("/reseller/deposits", requireAuth("reseller"), async (req, res) => {
  sendJson(res, 200, await query(`${DEPOSIT_SELECT} WHERE d.reseller_id=$1 ORDER BY d.created_at DESC`, [req.auth!.sub]));
});

resellerDepositsWithdrawalsRouter.get("/reseller/deposits/:id", requireAuth("reseller"), async (req, res) => {
  const deposit = await queryOne(`${DEPOSIT_SELECT} WHERE d.id=$1 AND d.reseller_id=$2`, [req.params.id, req.auth!.sub]);
  if (!deposit) return sendJson(res, 404, { error: "Deposit not found" });
  sendJson(res, 200, deposit);
});

resellerDepositsWithdrawalsRouter.get("/admin/reseller-deposits", requireStaff(), async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const params: unknown[] = [];
  let sql = `SELECT d.*, m.label AS method_label, r.reseller_login_id, r.name AS reseller_name, rw.balance AS reseller_wallet_balance
             FROM reseller_deposits d
             JOIN reseller_deposit_methods m ON m.method = d.method
             JOIN resellers r ON r.id = d.reseller_id
             LEFT JOIN reseller_wallets rw ON rw.reseller_id = d.reseller_id`;
  if (status) {
    params.push(status);
    sql += ` WHERE d.status=$1`;
  }
  sendJson(res, 200, await query(sql + ` ORDER BY d.created_at DESC`, params));
});

// Manual verification path (Stage 4 scope — automatic SMS matching against
// this deposit's from_number/amount is a follow-up, not built here). "After
// SMS verification: Wallet Balance $500 -> $600" (spec, Req. 8 example) —
// the credit happens exactly at this step, atomically with the status
// flip, mirroring reseller_orders' confirm step crediting instead of
// debiting. CAS from 'pending' only, so a double-click can never
// double-credit.
//
// Deposit is a plain 1:1 credit — no commission or bonus applies here, and
// the payment method used (EVC Plus/eDahab) never determines the Withdraw
// commission (product instruction). The company-specific commission
// applies only to Withdraw — see reseller_withdrawal_commission_config /
// POST /reseller/withdrawals.
resellerDepositsWithdrawalsRouter.put("/admin/reseller-deposits/:id/verify", requirePermission("resellers.manage"), async (req, res) => {
  const deposit = await queryOne(`SELECT * FROM reseller_deposits WHERE id=$1`, [req.params.id]);
  if (!deposit) return sendJson(res, 404, { error: "Deposit not found" });
  if (deposit.status !== "pending") return sendJson(res, 409, { error: `Deposit is '${deposit.status}', not 'pending' — cannot verify` });

  const walletResult = await adjustResellerWallet({
    resellerId: deposit.reseller_id,
    changeAmount: Number(deposit.amount),
    referenceType: "deposit",
    referenceId: deposit.id,
    source: "admin_manual",
    changedByAdminId: req.auth!.sub,
  });

  const rows = await query(
    `UPDATE reseller_deposits SET status='verified', verified_at=now(), verified_by_admin_id=$1, updated_at=now()
     WHERE id=$2 AND status='pending' RETURNING id`,
    [req.auth!.sub, req.params.id]
  );
  if (rows.length === 0) {
    return sendJson(res, 500, { error: "Wallet was credited but the deposit status change lost a race — check admin activity log" });
  }
  sendJson(res, 200, { id: req.params.id, status: "verified", wallet: walletResult });
});

resellerDepositsWithdrawalsRouter.put("/admin/reseller-deposits/:id/complete", requirePermission("resellers.manage"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_deposits SET status='completed', completed_at=now(), updated_at=now()
     WHERE id=$1 AND status='verified' RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Deposit not found or not in a verified state" });
  sendJson(res, 200, { id: req.params.id, status: "completed" });
});

resellerDepositsWithdrawalsRouter.put("/admin/reseller-deposits/:id/fail", requirePermission("resellers.manage"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_deposits SET status='failed', updated_at=now() WHERE id=$1 AND status='pending' RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Deposit not found or already resolved" });
  sendJson(res, 200, { id: req.params.id, status: "failed" });
});

// ==================== Withdrawal ("Lacag Bixi", Req. 9) ====================

// payout_ussd_template travels with every withdrawal read so the app can
// build the "Dial to Pay" (send-money) USSD code itself — see
// utils/ussd.dart's buildPayoutUssdDialUri, substituting {number} (the
// destination_number on this same row) and {amount}.
const WITHDRAWAL_SELECT = `
  SELECT w.*, c.name AS company_name, c.color_hex AS company_color, c.payout_ussd_template
  FROM reseller_withdrawals w
  JOIN companies c ON c.id = w.company_id
`;

// "The reseller's wallet must NOT be locked or deducted just because a
// withdrawal is created or is Reserved/Sent — only a successfully sent
// payout with a matching real outgoing SMS deducts anything" (product
// instruction). So a Reserved/Sent withdrawal no longer reserves any
// capacity at all: creating one only checks against the wallet's current
// raw balance, never against other in-flight withdrawals, and never
// touches reseller_wallets.balance itself. A reseller can have several
// withdrawals open at once that collectively exceed the wallet balance —
// that's intentional now, not a bug.
//
// The actual safety net moved entirely to settlement time:
// adjustResellerWallet (utils/resellerWallet.ts) locks the wallet row and
// throws "Insufficient wallet balance" if a completion's debit would ever
// take it negative, so the ledger itself can never go negative no matter
// how many withdrawals were left open. The tradeoff this accepts: if two
// withdrawals are both genuinely paid out by an Agent but together exceed
// the wallet, the SMS confirmation for whichever completes second will
// fail at that floor — a real-money-sent-but-uncredited edge case that
// needs an admin's manual reconciliation, which this product instruction
// explicitly chose over blocking withdrawal creation up front.
//
// The Withdraw Commission (Admin -> Resellers -> Payment, per company) is
// resolved and snapshotted right here, at request time, based on the payout
// company the customer selected — never on the Deposit payment method. The
// Wallet will only ever be deducted by `amount`, but the customer must be
// sent MORE than that (amount + amount x commission%), and the app needs
// that customer_receives_amount immediately after creation to dial the
// correct payout USSD amount. Once snapshotted the commission never
// changes for this withdrawal even if Admin edits the company's percentage
// afterward (same "don't mutate history" principle as the rest of this
// feature).
resellerDepositsWithdrawalsRouter.post("/reseller/withdrawals", requireAuth("reseller"), async (req, res) => {
  const companyId = String(req.body.companyId ?? "");
  const destinationNumber = String(req.body.destinationNumber ?? "").trim();
  const amount = Number(req.body.amount);
  const clientRequestId = req.body.clientRequestId ? String(req.body.clientRequestId) : null;

  if (!companyId || !destinationNumber || !Number.isFinite(amount) || amount <= 0) {
    return sendJson(res, 400, { error: "companyId, destinationNumber, and a positive amount are required" });
  }
  if (!PAYMENT_NUMBER_RE.test(destinationNumber)) {
    return sendJson(res, 400, { error: "destinationNumber must be 6-15 digits" });
  }
  if (!(await queryOne(`SELECT id FROM companies WHERE id=$1 AND deleted_at IS NULL`, [companyId]))) {
    return sendJson(res, 404, { error: "Company not found" });
  }

  const commissionCfg = await queryOne<{ commission_percentage: string }>(
    `SELECT commission_percentage FROM reseller_withdrawal_commission_config WHERE company_id=$1`,
    [companyId]
  );
  const commissionPercentage = commissionCfg ? Number(commissionCfg.commission_percentage) : 0;
  const bonusAmount = Math.round(amount * commissionPercentage) / 100;
  const customerReceivesAmount = Math.round((amount + bonusAmount) * 100) / 100;

  const id = withdrawalRef();
  try {
    await withTransaction(async (client) => {
      // Checked against the wallet's current raw balance only — no
      // subtraction for other Reserved/Sent withdrawals, and this lock is
      // released without ever writing to reseller_wallets (see this
      // route's doc comment above for why).
      const walletRow = await client.query<{ balance: string }>(
        `SELECT balance FROM reseller_wallets WHERE reseller_id=$1 FOR UPDATE`,
        [req.auth!.sub]
      );
      if (walletRow.rows.length === 0) throw new Error(`No wallet row for reseller ${req.auth!.sub}`);
      if (amount > Number(walletRow.rows[0].balance)) throw new Error("Insufficient wallet balance");

      await client.query(
        `INSERT INTO reseller_withdrawals
           (id, reseller_id, company_id, destination_number, amount, status, client_request_id,
            commission_percentage, bonus_amount, customer_receives_amount)
         VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9)`,
        [id, req.auth!.sub, companyId, destinationNumber, amount, clientRequestId,
          commissionPercentage, bonusAmount, customerReceivesAmount]
      );
    });
    // Wakes the Agent App's self-heal sweep immediately (same generic
    // subscribe/broadcast stream its /agent/orders/stream connection is
    // already listening on — see AgentBackgroundService.kt's
    // AgentEventBus.orderEvents collector) instead of waiting for its ~60s
    // periodic backstop poll to pick up this new 'reserved' withdrawal.
    broadcast({ type: "reseller_withdrawal.updated", withdrawalId: id });
    sendJson(res, 201, maskWithdrawalForReseller(await queryOne(`${WITHDRAWAL_SELECT} WHERE w.id=$1`, [id])));
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string; message?: string };
    if (pgErr.code === "23505" && pgErr.constraint === "idx_reseller_withdrawals_client_request_id") {
      return sendJson(res, 200, maskWithdrawalForReseller(await queryOne(`${WITHDRAWAL_SELECT} WHERE w.client_request_id=$1`, [clientRequestId])));
    }
    if (pgErr.message === "Insufficient wallet balance") {
      return sendJson(res, 400, { error: "Insufficient wallet balance" });
    }
    throw err;
  }
});

resellerDepositsWithdrawalsRouter.get("/reseller/withdrawals", requireAuth("reseller"), async (req, res) => {
  sendJson(res, 200, maskWithdrawalsForReseller(await query(`${WITHDRAWAL_SELECT} WHERE w.reseller_id=$1 ORDER BY w.created_at DESC`, [req.auth!.sub])));
});

resellerDepositsWithdrawalsRouter.get("/reseller/withdrawals/:id", requireAuth("reseller"), async (req, res) => {
  const withdrawal = await queryOne(`${WITHDRAWAL_SELECT} WHERE w.id=$1 AND w.reseller_id=$2`, [req.params.id, req.auth!.sub]);
  if (!withdrawal) return sendJson(res, 404, { error: "Withdrawal not found" });
  sendJson(res, 200, maskWithdrawalForReseller(withdrawal));
});

// Reseller backs out before the payout is confirmed. No wallet adjustment
// needed — nothing was deducted at creation (see POST /reseller/withdrawals'
// doc comment), so cancelling just needs to move the row out of the
// "in-flight" set that route's availability check sums over.
resellerDepositsWithdrawalsRouter.put("/reseller/withdrawals/:id/cancel", requireAuth("reseller"), async (req, res) => {
  const withdrawal = await queryOne(`SELECT * FROM reseller_withdrawals WHERE id=$1 AND reseller_id=$2`, [req.params.id, req.auth!.sub]);
  if (!withdrawal) return sendJson(res, 404, { error: "Withdrawal not found" });
  if (withdrawal.status !== "reserved") {
    return sendJson(res, 409, { error: `Withdrawal is '${withdrawal.status}', not 'reserved' — cannot cancel` });
  }

  const rows = await query(
    `UPDATE reseller_withdrawals SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1 AND status='reserved' RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Withdrawal is no longer in a reserved state" });
  sendJson(res, 200, { id: req.params.id, status: "cancelled" });
});

resellerDepositsWithdrawalsRouter.get("/admin/reseller-withdrawals", requireStaff(), async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const params: unknown[] = [];
  let sql = `SELECT w.*, c.name AS company_name, r.reseller_login_id, r.name AS reseller_name,
                    rw.balance AS reseller_wallet_balance, au.email AS confirmed_by_admin_email,
                    sl.body AS sms_confirmation_text, sl.received_at AS sms_confirmed_at,
                    da.sim_mobile_number, da.sim_device_id, d.name AS sim_device_name, da.status AS dial_attempt_status
             FROM reseller_withdrawals w
             JOIN companies c ON c.id = w.company_id
             JOIN resellers r ON r.id = w.reseller_id
             LEFT JOIN reseller_wallets rw ON rw.reseller_id = w.reseller_id
             LEFT JOIN admin_users au ON au.id = w.confirmed_by_admin_id
             LEFT JOIN sms_logs sl ON sl.id = w.matched_sms_log_id
             LEFT JOIN LATERAL (
               SELECT * FROM reseller_withdrawal_dial_attempts a
               WHERE a.withdrawal_id = w.id ORDER BY a.attempt_number DESC LIMIT 1
             ) da ON true
             LEFT JOIN agent_devices d ON d.id = da.sim_device_id`;
  if (status) {
    params.push(status);
    sql += ` WHERE w.status=$1`;
  }
  sendJson(res, 200, await query(sql + ` ORDER BY w.created_at DESC`, params));
});

// Optional manual bookkeeping step — the automatic SMS matcher (see
// resellerSmsMatching.ts) matches a withdrawal straight from 'reserved' OR
// 'sent' to 'completed', so nothing requires this to run first. Still
// useful for admin visibility ("this one's been dialed, just waiting on
// the SMS"). No balance change either way — nothing is deducted until
// Complete.
resellerDepositsWithdrawalsRouter.put("/admin/reseller-withdrawals/:id/mark-sent", requirePermission("resellers.manage"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_withdrawals SET status='sent', sent_at=now(), confirmed_by_admin_id=$1, updated_at=now()
     WHERE id=$2 AND status='reserved' RETURNING id`,
    [req.auth!.sub, req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Withdrawal not found or not in a reserved state" });
  sendJson(res, 200, { id: req.params.id, status: "sent" });
});

// Manual fallback for the (currently common, until real "money sent" SMS
// samples exist to build a mobile-side parser for — see resellerSmsMatching.ts's
// header comment) case where the automatic SMS match never fires. This is
// the only place besides the automatic matcher that actually deducts the
// wallet — "the Wallet amount is deducted only after the outgoing payment
// is successfully confirmed" (product instruction) — via the exact same
// claim-before-deduct ordering confirmResellerWithdrawalViaSms uses: the
// CAS (status IN ('reserved','sent') in the WHERE) runs first, and only a
// successful claim is allowed to touch the wallet, so a race between this
// endpoint and the automatic matcher can never double-deduct.
resellerDepositsWithdrawalsRouter.put("/admin/reseller-withdrawals/:id/complete", requirePermission("resellers.manage"), async (req, res) => {
  const smsLogId = req.body.smsLogId ? String(req.body.smsLogId) : null;
  if (smsLogId && !(await queryOne(`SELECT id FROM sms_logs WHERE id=$1`, [smsLogId]))) {
    return sendJson(res, 404, { error: "SMS log not found" });
  }

  try {
    const walletResult = await withTransaction(async (client) => {
      const claimed = await client.query<{ id: string; amount: string; reseller_id: string }>(
        `UPDATE reseller_withdrawals SET status='completed', completed_at=now(), confirmed_by_admin_id=$1,
           matched_sms_log_id=COALESCE($2, matched_sms_log_id), updated_at=now()
         WHERE id=$3 AND status IN ('reserved','sent') RETURNING id, amount, reseller_id`,
        [req.auth!.sub, smsLogId, req.params.id]
      );
      if (claimed.rows.length === 0) throw new Error("WITHDRAWAL_NOT_CLAIMABLE");

      // Wrapped in the same transaction as the status CAS above: if this
      // throws (e.g. a true insufficient-balance edge case), the status
      // flip rolls back with it rather than leaving the withdrawal stuck
      // 'completed' with no money actually moved.
      return adjustResellerWallet({
        resellerId: claimed.rows[0].reseller_id,
        changeAmount: -Number(claimed.rows[0].amount),
        referenceType: "withdrawal",
        referenceId: req.params.id,
        source: "admin_manual",
        changedByAdminId: req.auth!.sub,
        client,
      });
    });
    sendJson(res, 200, { id: req.params.id, status: "completed", smsLogId, wallet: walletResult });
  } catch (err) {
    if (err instanceof Error && err.message === "WITHDRAWAL_NOT_CLAIMABLE") {
      return sendJson(res, 409, { error: "Withdrawal not found or already resolved" });
    }
    throw err;
  }
});

// No wallet adjustment needed — nothing was deducted for a withdrawal still
// 'reserved' or 'sent' (see POST /reseller/withdrawals' doc comment), so
// failing one just needs to move it out of the "in-flight" set.
resellerDepositsWithdrawalsRouter.put("/admin/reseller-withdrawals/:id/fail", requirePermission("resellers.manage"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_withdrawals SET status='failed', updated_at=now() WHERE id=$1 AND status IN ('reserved','sent') RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Withdrawal not found or already resolved" });
  sendJson(res, 200, { id: req.params.id, status: "failed" });
});

// ==================== Automatic payout (Agent App) ====================
// Withdraw is now fully automatic end-to-end: Reserved -> the Agent App
// dials the payout with no human entering or triggering the USSD itself ->
// the real outgoing SMS confirms it (resellerSmsMatching.ts) -> Completed.
// This section is the Agent-facing half of that pipeline — mirrors
// UssdOrchestrator's Internet Store shape (GET .../self-heal-candidates,
// POST .../dial-attempts, PUT /agent/dial-attempts/:id) exactly, since
// payout_ussd_template is the same one-shot combined-string dial Internet
// Store recharge already automates (TelephonyManager.sendUssdRequest via
// UssdDialer.kt) — not Money Exchange's two-step interactive PIN flow, which
// needs its AccessibilityService for a reason that doesn't apply here.
//
// Deliberately never marks the withdrawal 'completed' from a dial result —
// unlike Internet Store's PUT /agent/dial-attempts/:attemptId, which
// completes the order on a 'success' report. A USSD callback firing only
// means the OS/carrier accepted the request; it is not proof the customer
// was actually paid. Only the real outgoing SMS (matched via
// resellerSmsMatching.ts) or an admin's manual Complete ever moves this
// withdrawal to 'completed' or touches the wallet — see this file's other
// routes above.

// Self-heal target list: 'reserved' withdrawals with no dial attempt yet.
// Once ANY attempt exists for a withdrawal — success, failure, or ambiguous —
// it must never be auto-dialed again, so a failed automatic payout stays
// waiting for an admin's manual Complete/mark-sent rather than risking a
// second real payout for the same withdrawal.
resellerDepositsWithdrawalsRouter.get("/agent/reseller-withdrawals/pending-payout", requireAuth("agent"), async (_req, res) => {
  const rows = await query(
    `SELECT w.id, w.company_id, c.name AS company_name, c.payout_ussd_template,
            w.destination_number, w.customer_receives_amount
     FROM reseller_withdrawals w
     JOIN companies c ON c.id = w.company_id
     WHERE w.status = 'reserved'
       AND c.payout_ussd_template IS NOT NULL AND c.payout_ussd_template != ''
       AND NOT EXISTS (SELECT 1 FROM reseller_withdrawal_dial_attempts a WHERE a.withdrawal_id = w.id)
     ORDER BY w.created_at ASC`
  );
  sendJson(res, 200, rows);
});

// Natural key for one logical attempt is (withdrawal_id, attempt_number) —
// same idempotent-insert shape as POST /agent/orders/:id/dial-attempts, so a
// queued/retried audit-log POST after a dropped response returns the
// existing row's id instead of creating a second one. Also best-effort bumps
// the withdrawal reserved -> sent (the same transition
// PUT /admin/reseller-withdrawals/:id/mark-sent makes by hand) purely for
// dashboard visibility — a no-op if it's already 'sent' or was raced by the
// SMS matcher straight to 'completed'.
resellerDepositsWithdrawalsRouter.post("/agent/reseller-withdrawals/:id/dial-attempts", requireAuth("agent"), async (req, res) => {
  const { simSlot, ussdString, attemptNumber } = req.body;
  if (!ussdString) return sendJson(res, 400, { error: "ussdString is required" });
  const withdrawal = await queryOne<{ id: string; company_id: string }>(`SELECT id, company_id FROM reseller_withdrawals WHERE id=$1`, [
    req.params.id,
  ]);
  if (!withdrawal) return sendJson(res, 404, { error: "Withdrawal not found" });

  const agent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [req.auth!.sub]);
  if (agent?.device_id) {
    const device = await queryOne<{ enabled: boolean }>(`SELECT enabled FROM agent_devices WHERE id=$1`, [agent.device_id]);
    if (device && !device.enabled) {
      return sendJson(res, 403, { error: "Your assigned device has been disabled by an admin." });
    }
  }

  // Snapshotted onto the attempt row (not just referenced) so a later Admin
  // edit to the route — a new mobile number, a different device — never
  // rewrites what this specific attempt actually used. Resolved server-side
  // from the agent's own device rather than trusted from the request body,
  // consistent with "backend is the source of truth" for SIM routing.
  const simRoute = agent?.device_id
    ? await queryOne<{ mobile_number: string | null }>(
        `SELECT mobile_number FROM reseller_withdrawal_sim_routing WHERE company_id=$1 AND device_id=$2`,
        [withdrawal.company_id, agent.device_id]
      )
    : null;

  const id = randomUUID();
  try {
    await query(
      `INSERT INTO reseller_withdrawal_dial_attempts (id, withdrawal_id, agent_id, sim_slot, ussd_string, attempt_number, status, sim_device_id, sim_mobile_number)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
      [id, req.params.id, req.auth!.sub, simSlot ?? null, ussdString, attemptNumber ?? 1, agent?.device_id ?? null, simRoute?.mobile_number ?? null]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_reseller_withdrawal_dial_attempts_withdrawal_attempt") throw err;
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM reseller_withdrawal_dial_attempts WHERE withdrawal_id=$1 AND attempt_number=$2`,
      [req.params.id, attemptNumber ?? 1]
    );
    return sendJson(res, 200, { id: existing!.id });
  }
  await query(
    `UPDATE reseller_withdrawals SET status='sent', sent_at=now(), updated_at=now() WHERE id=$1 AND status='reserved'`,
    [req.params.id]
  );
  broadcast({ type: "reseller_withdrawal.updated", withdrawalId: req.params.id });
  sendJson(res, 201, { id });
});

resellerDepositsWithdrawalsRouter.put("/agent/reseller-withdrawal-dial-attempts/:attemptId", requireAuth("agent"), async (req, res) => {
  const { status, responseMessage } = req.body;
  if (!["success", "failed", "ambiguous"].includes(status)) {
    return sendJson(res, 400, { error: "status must be success, failed, or ambiguous" });
  }
  // Atomic compare-and-swap, same as PUT /agent/dial-attempts/:attemptId —
  // a duplicate/retried report of an already-resolved attempt is a no-op.
  const result = await query(
    `UPDATE reseller_withdrawal_dial_attempts SET status=$1, response_message=$2, completed_at=now()
     WHERE id=$3 AND status='pending' RETURNING withdrawal_id`,
    [status, responseMessage ?? null, req.params.attemptId]
  );
  if (result.length === 0) {
    const existing = await queryOne(`SELECT * FROM reseller_withdrawal_dial_attempts WHERE id=$1`, [req.params.attemptId]);
    if (!existing) return sendJson(res, 404, { error: "Dial attempt not found" });
    return sendJson(res, 200, existing);
  }
  const withdrawalId = (result[0] as { withdrawal_id: string }).withdrawal_id;
  broadcast({ type: "reseller_withdrawal.updated", withdrawalId });
  sendJson(res, 200, await queryOne(`SELECT * FROM reseller_withdrawal_dial_attempts WHERE id=$1`, [req.params.attemptId]));
});

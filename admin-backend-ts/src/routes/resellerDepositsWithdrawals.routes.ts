import { Router } from "express";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { adjustResellerWallet } from "../utils/resellerWallet.js";

export const resellerDepositsWithdrawalsRouter = Router();

const PAYMENT_NUMBER_RE = /^\d{6,15}$/;

function depositRef(): string {
  return "DEP" + Math.floor(100000000 + Math.random() * 900000000);
}
function withdrawalRef(): string {
  return "WDR" + Math.floor(100000000 + Math.random() * 900000000);
}

// ==================== Deposit ("Lacag Ku Shub", Req. 8) ====================

const DEPOSIT_SELECT = `
  SELECT d.*, m.label AS method_label, bc.name AS bonus_company_name
  FROM reseller_deposits d
  JOIN reseller_deposit_methods m ON m.method = d.method
  LEFT JOIN companies bc ON bc.id = d.bonus_company_id
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
  let sql = `SELECT d.*, m.label AS method_label, bc.name AS bonus_company_name, r.reseller_login_id, r.name AS reseller_name
             FROM reseller_deposits d
             JOIN reseller_deposit_methods m ON m.method = d.method
             LEFT JOIN companies bc ON bc.id = d.bonus_company_id
             JOIN resellers r ON r.id = d.reseller_id`;
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
// Deposit Bonus (Admin -> Resellers -> Payment) is resolved and snapshotted
// right here, not at request creation — the percentage that applies is
// whatever Admin has configured at the moment the deposit is actually
// processed/credited, and once snapshotted it never changes even if Admin
// edits the percentage afterward (product instruction).
resellerDepositsWithdrawalsRouter.put("/admin/reseller-deposits/:id/verify", requirePermission("resellers.manage"), async (req, res) => {
  const deposit = await queryOne(`SELECT * FROM reseller_deposits WHERE id=$1`, [req.params.id]);
  if (!deposit) return sendJson(res, 404, { error: "Deposit not found" });
  if (deposit.status !== "pending") return sendJson(res, 409, { error: `Deposit is '${deposit.status}', not 'pending' — cannot verify` });

  const method = await queryOne<{ bonus_company_id: string | null }>(
    `SELECT bonus_company_id FROM reseller_deposit_methods WHERE method=$1`,
    [deposit.method]
  );
  const bonusCompanyId = method?.bonus_company_id ?? null;
  let bonusPercentage = 0;
  if (bonusCompanyId) {
    const cfg = await queryOne<{ bonus_percentage: string }>(
      `SELECT bonus_percentage FROM reseller_deposit_bonus_config WHERE company_id=$1`,
      [bonusCompanyId]
    );
    bonusPercentage = cfg ? Number(cfg.bonus_percentage) : 0;
  }
  const depositAmount = Number(deposit.amount);
  const bonusAmount = Math.round(depositAmount * bonusPercentage) / 100;
  const creditedAmount = Math.round((depositAmount + bonusAmount) * 100) / 100;

  const walletResult = await adjustResellerWallet({
    resellerId: deposit.reseller_id,
    changeAmount: creditedAmount,
    referenceType: "deposit",
    referenceId: deposit.id,
    source: "admin_manual",
    changedByAdminId: req.auth!.sub,
  });

  const rows = await query(
    `UPDATE reseller_deposits
     SET status='verified', verified_at=now(), verified_by_admin_id=$1, updated_at=now(),
         bonus_company_id=$2, bonus_percentage=$3, bonus_amount=$4, credited_amount=$5
     WHERE id=$6 AND status='pending' RETURNING id`,
    [req.auth!.sub, bonusCompanyId, bonusPercentage, bonusAmount, creditedAmount, req.params.id]
  );
  if (rows.length === 0) {
    return sendJson(res, 500, { error: "Wallet was credited but the deposit status change lost a race — check admin activity log" });
  }
  sendJson(res, 200, { id: req.params.id, status: "verified", bonusAmount, creditedAmount, wallet: walletResult });
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

// Reserves the amount atomically with row creation — "the amount must be
// reserved/deducted... so the same balance cannot be used for another
// transaction" (spec, Req. 9). Both the wallet debit and the withdrawal
// row happen in one transaction: if either fails, neither is left behind.
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

  const id = withdrawalRef();
  try {
    const created = await withTransaction(async (client) => {
      const walletResult = await adjustResellerWallet({
        resellerId: req.auth!.sub,
        changeAmount: -amount,
        referenceType: "withdrawal_reservation",
        referenceId: id,
        source: "system",
        client,
      });
      const txRow = await client.query(
        `SELECT id FROM reseller_wallet_transactions WHERE reseller_id=$1 AND reference_id=$2 AND reference_type='withdrawal_reservation' ORDER BY created_at DESC LIMIT 1`,
        [req.auth!.sub, id]
      );
      const reservationTxId = txRow.rows[0]?.id ?? null;
      await client.query(
        `INSERT INTO reseller_withdrawals (id, reseller_id, company_id, destination_number, amount, status, reservation_tx_id, client_request_id)
         VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7)`,
        [id, req.auth!.sub, companyId, destinationNumber, amount, reservationTxId, clientRequestId]
      );
      return walletResult;
    });
    sendJson(res, 201, { ...(await queryOne(`${WITHDRAWAL_SELECT} WHERE w.id=$1`, [id])), wallet: created });
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string; message?: string };
    if (pgErr.code === "23505" && pgErr.constraint === "idx_reseller_withdrawals_client_request_id") {
      return sendJson(res, 200, await queryOne(`${WITHDRAWAL_SELECT} WHERE w.client_request_id=$1`, [clientRequestId]));
    }
    if (pgErr.message === "Insufficient wallet balance") {
      return sendJson(res, 400, { error: "Insufficient wallet balance" });
    }
    throw err;
  }
});

resellerDepositsWithdrawalsRouter.get("/reseller/withdrawals", requireAuth("reseller"), async (req, res) => {
  sendJson(res, 200, await query(`${WITHDRAWAL_SELECT} WHERE w.reseller_id=$1 ORDER BY w.created_at DESC`, [req.auth!.sub]));
});

resellerDepositsWithdrawalsRouter.get("/reseller/withdrawals/:id", requireAuth("reseller"), async (req, res) => {
  const withdrawal = await queryOne(`${WITHDRAWAL_SELECT} WHERE w.id=$1 AND w.reseller_id=$2`, [req.params.id, req.auth!.sub]);
  if (!withdrawal) return sendJson(res, 404, { error: "Withdrawal not found" });
  sendJson(res, 200, withdrawal);
});

// Reseller backs out before Admin has sent the payout — releases the
// reservation via a reversing ledger row (never mutates the original).
resellerDepositsWithdrawalsRouter.put("/reseller/withdrawals/:id/cancel", requireAuth("reseller"), async (req, res) => {
  const withdrawal = await queryOne(`SELECT * FROM reseller_withdrawals WHERE id=$1 AND reseller_id=$2`, [req.params.id, req.auth!.sub]);
  if (!withdrawal) return sendJson(res, 404, { error: "Withdrawal not found" });
  if (withdrawal.status !== "reserved") {
    return sendJson(res, 409, { error: `Withdrawal is '${withdrawal.status}', not 'reserved' — cannot cancel` });
  }

  await adjustResellerWallet({
    resellerId: withdrawal.reseller_id,
    changeAmount: Number(withdrawal.amount),
    referenceType: "withdrawal_release",
    referenceId: withdrawal.id,
    source: "system",
  });
  const rows = await query(
    `UPDATE reseller_withdrawals SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1 AND status='reserved' RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) {
    return sendJson(res, 500, { error: "Reservation was released but the withdrawal status change lost a race — check admin activity log" });
  }
  sendJson(res, 200, { id: req.params.id, status: "cancelled" });
});

resellerDepositsWithdrawalsRouter.get("/admin/reseller-withdrawals", requireStaff(), async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const params: unknown[] = [];
  let sql = `SELECT w.*, c.name AS company_name, r.reseller_login_id, r.name AS reseller_name
             FROM reseller_withdrawals w JOIN companies c ON c.id = w.company_id JOIN resellers r ON r.id = w.reseller_id`;
  if (status) {
    params.push(status);
    sql += ` WHERE w.status=$1`;
  }
  sendJson(res, 200, await query(sql + ` ORDER BY w.created_at DESC`, params));
});

// Admin has dialed/sent the payout via that company's configured payment
// method (Agent App / USSD infra, outside this route's scope) and is
// recording that here. No balance change — the amount was already
// reserved at request time.
resellerDepositsWithdrawalsRouter.put("/admin/reseller-withdrawals/:id/mark-sent", requirePermission("resellers.manage"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_withdrawals SET status='sent', sent_at=now(), confirmed_by_admin_id=$1, updated_at=now()
     WHERE id=$2 AND status='reserved' RETURNING id`,
    [req.auth!.sub, req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Withdrawal not found or not in a reserved state" });
  sendJson(res, 200, { id: req.params.id, status: "sent" });
});

resellerDepositsWithdrawalsRouter.put("/admin/reseller-withdrawals/:id/complete", requirePermission("resellers.manage"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_withdrawals SET status='completed', completed_at=now(), updated_at=now()
     WHERE id=$1 AND status='sent' RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Withdrawal not found or not in a sent state" });
  sendJson(res, 200, { id: req.params.id, status: "completed" });
});

// "If a withdrawal is cancelled or fails after the amount was reserved, the
// reserved amount must be returned" (spec, Req. 9) — same release pattern
// as the reseller-initiated cancel above, usable from either 'reserved' or
// 'sent' (a payout attempt that failed after being dialed still needs its
// reservation released).
resellerDepositsWithdrawalsRouter.put("/admin/reseller-withdrawals/:id/fail", requirePermission("resellers.manage"), async (req, res) => {
  const withdrawal = await queryOne(`SELECT * FROM reseller_withdrawals WHERE id=$1`, [req.params.id]);
  if (!withdrawal) return sendJson(res, 404, { error: "Withdrawal not found" });
  if (!["reserved", "sent"].includes(withdrawal.status)) {
    return sendJson(res, 409, { error: `Withdrawal is '${withdrawal.status}' — cannot fail from this state` });
  }

  await adjustResellerWallet({
    resellerId: withdrawal.reseller_id,
    changeAmount: Number(withdrawal.amount),
    referenceType: "withdrawal_release",
    referenceId: withdrawal.id,
    source: "admin_manual",
    changedByAdminId: req.auth!.sub,
  });
  const rows = await query(
    `UPDATE reseller_withdrawals SET status='failed', updated_at=now() WHERE id=$1 AND status=$2 RETURNING id`,
    [req.params.id, withdrawal.status]
  );
  if (rows.length === 0) {
    return sendJson(res, 500, { error: "Reservation was released but the withdrawal status change lost a race — check admin activity log" });
  }
  sendJson(res, 200, { id: req.params.id, status: "failed" });
});

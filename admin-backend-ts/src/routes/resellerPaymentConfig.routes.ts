import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";

// Admin -> Resellers -> Payment: the two admin-managed pieces the mobile
// app's Deposit/Withdraw screens read from instead of anything hard-coded —
// see migration 053's header comment for why deposits moved off per-company
// collection numbers, and Withdrawal's payout template stayed on
// `companies` (it's genuinely per-company, just a different USSD shape than
// the existing customer-facing payment_ussd_template).
export const resellerPaymentConfigRouter = Router();

const DEPOSIT_METHOD_RE = /^(evc|edahab)$/;
const PAYMENT_NUMBER_RE = /^\d{6,15}$/;

// ---------------- Deposit collection methods (EVC Plus / eDahab) ----------------

resellerPaymentConfigRouter.get("/reseller/deposit-methods", requireAuth("reseller"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT method, label, payment_number, ussd_template FROM reseller_deposit_methods ORDER BY method`));
});

resellerPaymentConfigRouter.get("/admin/reseller-deposit-methods", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM reseller_deposit_methods ORDER BY method`));
});

resellerPaymentConfigRouter.put("/admin/reseller-deposit-methods/:method", requirePermission("resellers.manage"), async (req, res) => {
  const method = req.params.method;
  if (!DEPOSIT_METHOD_RE.test(method)) return sendJson(res, 400, { error: "Unknown payment method" });

  const paymentNumber = String(req.body.paymentNumber ?? "").trim();
  const ussdTemplate = String(req.body.ussdTemplate ?? "").trim();
  const label = String(req.body.label ?? "").trim();
  if (!paymentNumber || !PAYMENT_NUMBER_RE.test(paymentNumber)) {
    return sendJson(res, 400, { error: "paymentNumber must be 6-15 digits" });
  }
  if (!ussdTemplate.includes("{amount}")) {
    return sendJson(res, 400, { error: "ussdTemplate must include {amount}" });
  }
  if (!label) return sendJson(res, 400, { error: "label is required" });

  const rows = await query(
    `UPDATE reseller_deposit_methods SET label=$1, payment_number=$2, ussd_template=$3, updated_at=now(), updated_by=$4
     WHERE method=$5 RETURNING method`,
    [label, paymentNumber, ussdTemplate, req.auth!.sub, method]
  );
  if (rows.length === 0) return sendJson(res, 404, { error: "Unknown payment method" });
  sendJson(res, 200, await queryOne(`SELECT * FROM reseller_deposit_methods WHERE method=$1`, [method]));
});

// ---------------- Withdrawal payout template (per company) ----------------

resellerPaymentConfigRouter.put("/admin/companies/:id/payout-ussd-template", requirePermission("resellers.manage"), async (req, res) => {
  const ussdTemplate = String(req.body.payoutUssdTemplate ?? "").trim();
  if (!ussdTemplate.includes("{number}") || !ussdTemplate.includes("{amount}")) {
    return sendJson(res, 400, { error: "payoutUssdTemplate must include both {number} and {amount}" });
  }
  const rows = await query(
    `UPDATE companies SET payout_ussd_template=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL RETURNING id`,
    [ussdTemplate, req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 404, { error: "Company not found" });
  sendJson(res, 200, { id: req.params.id, payoutUssdTemplate: ussdTemplate });
});

// ---------------- Withdraw Commission, per company (migration 054) ----------------
//
// Deliberately its own table/routes, entirely separate from the Internet
// Store's rate/pricing config — see migration 054's header comment. Applies
// only to Withdraw, based on the payout company the customer selects there
// — Deposit is always a plain 1:1 credit, and its payment method (EVC
// Plus/eDahab) never determines the Withdraw commission.

resellerPaymentConfigRouter.get("/admin/reseller-withdrawal-commissions", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT c.id AS company_id, c.name AS company_name, COALESCE(cm.commission_percentage, 0) AS commission_percentage, cm.updated_at
       FROM companies c
       LEFT JOIN reseller_withdrawal_commission_config cm ON cm.company_id = c.id
       WHERE c.deleted_at IS NULL
       ORDER BY c.name`
    )
  );
});

resellerPaymentConfigRouter.put("/admin/reseller-withdrawal-commissions/:companyId", requirePermission("resellers.manage"), async (req, res) => {
  const commissionPercentage = Number(req.body.commissionPercentage);
  if (!Number.isFinite(commissionPercentage) || commissionPercentage < 0) {
    return sendJson(res, 400, { error: "commissionPercentage must be a non-negative number" });
  }
  if (!(await queryOne(`SELECT id FROM companies WHERE id=$1 AND deleted_at IS NULL`, [req.params.companyId]))) {
    return sendJson(res, 404, { error: "Company not found" });
  }
  await query(
    `INSERT INTO reseller_withdrawal_commission_config (company_id, commission_percentage, updated_at, updated_by)
     VALUES ($1,$2,now(),$3)
     ON CONFLICT (company_id) DO UPDATE SET commission_percentage=$2, updated_at=now(), updated_by=$3`,
    [req.params.companyId, commissionPercentage, req.auth!.sub]
  );
  sendJson(res, 200, { companyId: req.params.companyId, commissionPercentage });
});

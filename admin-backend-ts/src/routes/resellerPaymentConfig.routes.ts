import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { encrypt, isValidPin } from "../auth/crypto.js";

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

// ---------------- Withdrawal interactive payout config, per company (migration 060) ----------------
// For a payout provider whose carrier menu is a multi-step interactive
// session (eDahab's Reseller Service -> Transfer -> number -> amount -> PIN)
// rather than Hormuud's single one-shot dial string above. See migration
// 060's header comment for the full shape. The PIN is a separate,
// write-only endpoint — mirrors PUT /admin/exchange/payout-wallets/:id/pin
// exactly: never returned by the GET below, only a pinIsSet flag, and the
// activity log (if any is added here later) must only ever record that it
// changed, never the value.

resellerPaymentConfigRouter.get("/admin/reseller-withdrawal-interactive-payout", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT c.id AS company_id, c.name AS company_name, ic.initial_dial, ic.reply_steps,
              (ic.pin_encrypted IS NOT NULL) AS pin_is_set, ic.updated_at
       FROM companies c
       JOIN reseller_withdrawal_interactive_payout_config ic ON ic.company_id = c.id
       WHERE c.deleted_at IS NULL
       ORDER BY c.name`
    )
  );
});

resellerPaymentConfigRouter.put(
  "/admin/companies/:id/payout-interactive-steps",
  requirePermission("resellers.manage"),
  async (req, res) => {
    const initialDial = String(req.body.initialDial ?? "").trim();
    const replySteps = req.body.replySteps;
    if (!initialDial) return sendJson(res, 400, { error: "initialDial is required" });
    if (!Array.isArray(replySteps) || replySteps.length === 0 || !replySteps.every((s) => typeof s === "string" && s.trim())) {
      return sendJson(res, 400, { error: "replySteps must be a non-empty array of non-empty strings" });
    }
    if (!(await queryOne(`SELECT id FROM companies WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]))) {
      return sendJson(res, 404, { error: "Company not found" });
    }
    await query(
      `INSERT INTO reseller_withdrawal_interactive_payout_config (company_id, initial_dial, reply_steps, updated_at, updated_by)
       VALUES ($1,$2,$3,now(),$4)
       ON CONFLICT (company_id) DO UPDATE SET initial_dial=$2, reply_steps=$3, updated_at=now(), updated_by=$4`,
      [req.params.id, initialDial, JSON.stringify(replySteps), req.auth!.sub]
    );
    sendJson(res, 200, { companyId: req.params.id, initialDial, replySteps });
  }
);

resellerPaymentConfigRouter.put(
  "/admin/companies/:id/payout-interactive-pin",
  requireAuth("super_admin"),
  async (req, res) => {
    const { pin } = req.body ?? {};
    if (!isValidPin(String(pin ?? ""))) return sendJson(res, 400, { error: "PIN must be 4-8 digits" });
    const existing = await queryOne(`SELECT company_id FROM reseller_withdrawal_interactive_payout_config WHERE company_id=$1`, [
      req.params.id,
    ]);
    if (!existing) {
      return sendJson(res, 409, { error: "Set initialDial/replySteps for this company before setting its PIN" });
    }
    await query(
      `UPDATE reseller_withdrawal_interactive_payout_config SET pin_encrypted=$1, updated_at=now(), updated_by=$2 WHERE company_id=$3`,
      [encrypt(String(pin)), req.auth!.sub, req.params.id]
    );
    sendJson(res, 200, { companyId: req.params.id, pinIsSet: true });
  }
);

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

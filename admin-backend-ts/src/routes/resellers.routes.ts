import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { hashPassword, generateOtp } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";
import { adjustResellerWallet } from "../utils/resellerWallet.js";

const PAYMENT_NUMBER_RE = /^\d{6,15}$/;

export const resellersRouter = Router();

const RESELLER_LIST_SELECT = `
  SELECT r.id, r.reseller_login_id, r.name, r.status, r.phone, r.notes, r.last_login_at, r.created_at,
         COALESCE(w.balance, 0) AS wallet_balance
  FROM resellers r
  LEFT JOIN reseller_wallets w ON w.reseller_id = r.id
`;

async function generateUniqueResellerLoginId(): Promise<string> {
  // Small collision space (6 digits) but this is an infrequent, admin-only
  // action — a couple of retries on a 23505-equivalent pre-check is enough,
  // matching this codebase's general tolerance for a cheap retry over a
  // more elaborate ID scheme (see orderRef()/exchangeOrderRef()).
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = "RSL" + generateOtp(6);
    if (!(await queryOne(`SELECT id FROM resellers WHERE reseller_login_id=$1`, [candidate]))) {
      return candidate;
    }
  }
  throw new Error("Could not generate a unique reseller ID — try again");
}

// ---------------- Reseller-facing (requireAuth("reseller")) ----------------

resellersRouter.get("/reseller/me", requireAuth("reseller"), async (req, res) => {
  const reseller = await queryOne(
    `SELECT r.id, r.reseller_login_id, r.name, r.status, COALESCE(w.balance, 0) AS wallet_balance
     FROM resellers r LEFT JOIN reseller_wallets w ON w.reseller_id = r.id
     WHERE r.id=$1`,
    [req.auth!.sub]
  );
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  sendJson(res, 200, reseller);
});

// ---------------- Admin-facing (requirePermission("resellers.manage"), PIN reset is super_admin-only) ----------------

resellersRouter.get("/admin/resellers", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`${RESELLER_LIST_SELECT} ORDER BY r.created_at DESC`));
});

resellersRouter.get("/admin/resellers/:id", requireStaff(), async (req, res) => {
  const reseller = await queryOne(`${RESELLER_LIST_SELECT} WHERE r.id=$1`, [req.params.id]);
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  sendJson(res, 200, reseller);
});

// Creates the reseller, its wallet row, and a fresh 8-digit PIN in one go.
// The plaintext PIN is returned exactly once here — same one-time-reveal UX
// as resetCustomerPassword — and never retrievable again after this response.
resellersRouter.post("/admin/resellers", requirePermission("resellers.manage"), async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  const notes = req.body.notes ? String(req.body.notes).trim() : null;
  if (!name) return sendJson(res, 400, { error: "name is required" });

  const resellerLoginId = await generateUniqueResellerLoginId();
  const pin = generateOtp(8);
  const id = randomUUID();

  await query(
    `INSERT INTO resellers (id, reseller_login_id, name, pin_hash, phone, notes, created_by_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, resellerLoginId, name, await hashPassword(pin), phone, notes, req.auth!.sub]
  );
  await query(`INSERT INTO reseller_wallets (reseller_id) VALUES ($1)`, [id]);

  sendJson(res, 201, { id, resellerLoginId, name, status: "active", tempPin: pin });
});

resellersRouter.put("/admin/resellers/:id/status", requirePermission("resellers.manage"), async (req, res) => {
  const reseller = await queryOne(`SELECT * FROM resellers WHERE id=$1`, [req.params.id]);
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  const next = reseller.status === "active" ? "suspended" : "active";
  await query(`UPDATE resellers SET status=$1, updated_at=now() WHERE id=$2`, [next, req.params.id]);
  sendJson(res, 200, { id: reseller.id, status: next });
});

// Hard-restricted to super_admin regardless of the resellers.manage grant —
// same carve-out already established for customer PINs and the exchange
// payout-wallet PIN (see auth/permissions.ts's requirePermission doc and the
// equivalent checks in customers.routes.ts / exchange.routes.ts).
resellersRouter.put("/admin/resellers/:id/pin", requireAuth("super_admin"), async (req, res) => {
  const reseller = await queryOne(`SELECT id FROM resellers WHERE id=$1`, [req.params.id]);
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  const pin = generateOtp(8);
  await query(`UPDATE resellers SET pin_hash=$1, updated_at=now() WHERE id=$2`, [await hashPassword(pin), req.params.id]);
  sendJson(res, 200, { id: reseller.id, tempPin: pin });
});

// Manual balance correction/top-up — the only wallet-adjustment path in
// Stage 1 (order/exchange/deposit/withdrawal debits and SMS-verified
// deposit credits land in later stages, all through the same
// adjustResellerWallet helper).
resellersRouter.put("/admin/resellers/:id/wallet/adjust", requirePermission("resellers.manage"), async (req, res) => {
  const reseller = await queryOne(`SELECT id FROM resellers WHERE id=$1`, [req.params.id]);
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  const changeAmount = Number(req.body.changeAmount);
  if (!Number.isFinite(changeAmount) || changeAmount === 0) {
    return sendJson(res, 400, { error: "changeAmount must be a non-zero number" });
  }
  try {
    const result = await adjustResellerWallet({
      resellerId: req.params.id,
      changeAmount,
      referenceType: "admin_adjustment",
      referenceId: null,
      source: "admin_manual",
      changedByAdminId: req.auth!.sub,
    });
    sendJson(res, 200, { id: req.params.id, ...result });
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
  }
});

// ---------------- Companies, rates, and payment numbers (Stage 2) ----------------

// Reseller-facing: every company + its current order rate. There is a
// single overall reseller wallet balance (see GET /reseller/me), not a
// per-company balance, so no balance is joined in here. All existing
// companies are reseller-visible (no separate curated subset) — same
// catalog Internet Store customers see, minus the visible_customer_app
// filter, since that flag is specific to that app's own audience gating,
// not a general on/off switch.
resellersRouter.get("/reseller/companies", requireAuth("reseller"), async (_req, res) => {
  const rows = await query(
    `SELECT c.id, c.name, c.color_hex, c.logo_url, (c.logo_data IS NOT NULL) AS has_logo,
            cr.rate, COALESCE(cm.commission_percentage, 0) AS withdraw_commission_percentage
     FROM companies c
     LEFT JOIN reseller_company_rates cr ON cr.company_id = c.id
     LEFT JOIN reseller_withdrawal_commission_config cm ON cm.company_id = c.id
     WHERE c.deleted_at IS NULL AND c.status = 'online'
     ORDER BY c.group_number, c.sort_order, c.name`
  );
  sendJson(res, 200, rows);
});

// Reseller-facing: this reseller's own enabled numbers for one company,
// optionally filtered by role ('sending' = pay for orders with this number,
// 'receiving' = Dalab's collection number shown during Deposit).
resellersRouter.get("/reseller/payment-numbers", requireAuth("reseller"), async (req, res) => {
  const companyId = String(req.query.companyId ?? "");
  const role = req.query.role ? String(req.query.role) : null;
  if (!companyId) return sendJson(res, 400, { error: "companyId is required" });
  const params: unknown[] = [req.auth!.sub, companyId];
  let sql = `SELECT id, company_id, role, payment_number, label FROM reseller_payment_numbers WHERE reseller_id=$1 AND company_id=$2 AND enabled=true`;
  if (role) {
    params.push(role);
    sql += ` AND role=$3`;
  }
  sendJson(res, 200, await query(sql + ` ORDER BY label`, params));
});

// Admin-facing: full CRUD over a reseller's registered numbers, mirrors
// companyPaymentMethods.routes.ts's create/update/status/delete shape.
resellersRouter.get("/admin/resellers/:id/payment-numbers", requireStaff(), async (req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT id, company_id, role, payment_number, label, enabled, created_at, updated_at
       FROM reseller_payment_numbers WHERE reseller_id=$1 ORDER BY company_id, role`,
      [req.params.id]
    )
  );
});

resellersRouter.post("/admin/resellers/:id/payment-numbers", requirePermission("resellers.manage"), async (req, res) => {
  if (!(await queryOne(`SELECT id FROM resellers WHERE id=$1`, [req.params.id]))) {
    return sendJson(res, 404, { error: "Reseller not found" });
  }
  const { companyId, role, paymentNumber, label } = req.body;
  if (!companyId || !paymentNumber) return sendJson(res, 400, { error: "companyId and paymentNumber are required" });
  if (!PAYMENT_NUMBER_RE.test(String(paymentNumber))) {
    return sendJson(res, 400, { error: "paymentNumber must be 6-15 digits" });
  }
  const rowRole = role === "receiving" ? "receiving" : "sending";
  if (!(await queryOne(`SELECT id FROM companies WHERE id=$1 AND deleted_at IS NULL`, [companyId]))) {
    return sendJson(res, 404, { error: "Company not found" });
  }

  const id = randomUUID();
  try {
    await query(
      `INSERT INTO reseller_payment_numbers (id, reseller_id, company_id, role, payment_number, label)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.params.id, companyId, rowRole, paymentNumber, label || null]
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return sendJson(res, 409, { error: "This reseller already has a number registered for that company and role" });
    }
    throw err;
  }
  sendJson(res, 201, await queryOne(`SELECT id, company_id, role, payment_number, label, enabled FROM reseller_payment_numbers WHERE id=$1`, [id]));
});

resellersRouter.put("/admin/payment-numbers/:numberId", requirePermission("resellers.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM reseller_payment_numbers WHERE id=$1`, [req.params.numberId]);
  if (!existing) return sendJson(res, 404, { error: "Payment number not found" });
  const paymentNumber = req.body.paymentNumber ?? existing.payment_number;
  if (!PAYMENT_NUMBER_RE.test(String(paymentNumber))) {
    return sendJson(res, 400, { error: "paymentNumber must be 6-15 digits" });
  }
  const label = req.body.label !== undefined ? req.body.label : existing.label;
  await query(`UPDATE reseller_payment_numbers SET payment_number=$1, label=$2, updated_at=now() WHERE id=$3`, [
    paymentNumber,
    label,
    req.params.numberId,
  ]);
  sendJson(res, 200, await queryOne(`SELECT id, company_id, role, payment_number, label, enabled FROM reseller_payment_numbers WHERE id=$1`, [req.params.numberId]));
});

resellersRouter.put("/admin/payment-numbers/:numberId/status", requirePermission("resellers.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM reseller_payment_numbers WHERE id=$1`, [req.params.numberId]);
  if (!existing) return sendJson(res, 404, { error: "Payment number not found" });
  const next = !existing.enabled;
  await query(`UPDATE reseller_payment_numbers SET enabled=$1, updated_at=now() WHERE id=$2`, [next, req.params.numberId]);
  sendJson(res, 200, { id: existing.id, enabled: next });
});

resellersRouter.delete("/admin/payment-numbers/:numberId", requirePermission("resellers.manage"), async (req, res) => {
  const result = await query(`DELETE FROM reseller_payment_numbers WHERE id=$1 RETURNING id`, [req.params.numberId]);
  if (result.length === 0) return sendJson(res, 404, { error: "Payment number not found" });
  sendJson(res, 200, { deleted: true });
});

// ---------------- Company order rates (Stage 2) ----------------

resellersRouter.get("/admin/reseller-company-rates", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT c.id AS company_id, c.name AS company_name, cr.rate, cr.updated_at
       FROM companies c LEFT JOIN reseller_company_rates cr ON cr.company_id = c.id
       WHERE c.deleted_at IS NULL ORDER BY c.group_number, c.sort_order, c.name`
    )
  );
});

// Upsert — one current rate per company, admin sets/overwrites it directly
// rather than a separate create-vs-update flow.
resellersRouter.put("/admin/reseller-company-rates/:companyId", requirePermission("resellers.manage"), async (req, res) => {
  if (!(await queryOne(`SELECT id FROM companies WHERE id=$1 AND deleted_at IS NULL`, [req.params.companyId]))) {
    return sendJson(res, 404, { error: "Company not found" });
  }
  const rate = Number(req.body.rate);
  if (!Number.isFinite(rate) || rate <= 0) return sendJson(res, 400, { error: "rate must be a positive number" });
  await query(
    `INSERT INTO reseller_company_rates (company_id, rate, updated_by_admin_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (company_id) DO UPDATE SET rate=$2, updated_at=now(), updated_by_admin_id=$3`,
    [req.params.companyId, rate, req.auth!.sub]
  );
  sendJson(res, 200, { companyId: req.params.companyId, rate });
});


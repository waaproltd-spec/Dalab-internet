import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";

// Admin -> Offline (Rukumo) -> Payment Methods: the three admin-managed
// numbers (EVC Plus/Jeeb/eDahab) the Customer App's Offline Orders intro
// screen reads instead of the hard-coded `_ussdPayments` list it used to
// carry. See migration 109's header comment for the table shape.
export const offlinePaymentMethodsRouter = Router();

const OFFLINE_METHOD_RE = /^(evc|jeeb|edahab)$/;
const PAYMENT_NUMBER_RE = /^\d{6,15}$/;

// Public like /shop/payment-methods and /reseller/deposit-methods — shown
// on the Offline Orders intro screen before the customer has entered any
// info or signed in, and the payment number/dial code here is meant to be
// dialed by anyone, not a secret.
offlinePaymentMethodsRouter.get("/offline/payment-methods", async (_req, res) => {
  sendJson(res, 200, await query(`SELECT method, label, payment_number, ussd_template FROM offline_payment_methods ORDER BY method`));
});

offlinePaymentMethodsRouter.get("/admin/offline/payment-methods", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM offline_payment_methods ORDER BY method`));
});

// Gated the same as the rest of the Offline (Rukumo) admin section
// (nav-level "orders.manage" in the Super Admin App) rather than a new
// dedicated permission key, since this is one small part of that same
// section, not its own dashboard area.
offlinePaymentMethodsRouter.put("/admin/offline/payment-methods/:method", requirePermission("orders.manage"), async (req, res) => {
  const method = req.params.method;
  if (!OFFLINE_METHOD_RE.test(method)) return sendJson(res, 400, { error: "Unknown payment method" });

  const paymentNumber = String(req.body?.paymentNumber ?? "").trim();
  const ussdTemplate = String(req.body?.ussdTemplate ?? "").trim();
  const label = String(req.body?.label ?? "").trim();
  if (!paymentNumber || !PAYMENT_NUMBER_RE.test(paymentNumber)) {
    return sendJson(res, 400, { error: "paymentNumber must be 6-15 digits" });
  }
  if (!ussdTemplate.includes("$")) {
    return sendJson(res, 400, { error: "ussdTemplate must include \"$\" as the amount placeholder" });
  }
  if (!label) return sendJson(res, 400, { error: "label is required" });

  const rows = await query(
    `UPDATE offline_payment_methods SET label=$1, payment_number=$2, ussd_template=$3, updated_at=now(), updated_by=$4
     WHERE method=$5 RETURNING method`,
    [label, paymentNumber, ussdTemplate, req.auth!.sub, method]
  );
  if (rows.length === 0) return sendJson(res, 404, { error: "Unknown payment method" });
  sendJson(res, 200, await queryOne(`SELECT * FROM offline_payment_methods WHERE method=$1`, [method]));
});

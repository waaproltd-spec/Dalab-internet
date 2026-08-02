import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";

export const companyPaymentMethodsRouter = Router();

const METHOD_COLUMNS = `id, company_id, method, label, payment_number, ussd_template, enabled, sort_order, created_at, updated_at`;

// Public — the Customer App's "Select Payment Method" step, scoped to the
// company whose package the customer already picked. Only enabled methods,
// in admin-configured display order.
companyPaymentMethodsRouter.get("/companies/:id/payment-methods", async (req, res) => {
  const rows = await query(
    `SELECT ${METHOD_COLUMNS} FROM company_payment_methods WHERE company_id=$1 AND enabled=true ORDER BY sort_order, label`,
    [req.params.id]
  );
  sendJson(res, 200, rows);
});

companyPaymentMethodsRouter.get("/admin/companies/:id/payment-methods", requireStaff(), async (req, res) => {
  const rows = await query(
    `SELECT ${METHOD_COLUMNS} FROM company_payment_methods WHERE company_id=$1 ORDER BY sort_order, label`,
    [req.params.id]
  );
  sendJson(res, 200, rows);
});

// Super-Admin-exclusive, same reasoning as companies.routes.ts's
// payment-number route — this directly controls what the Customer App
// dials, so it isn't delegable via companies.manage.
companyPaymentMethodsRouter.post("/admin/companies/:id/payment-methods", requireAuth("super_admin"), async (req, res) => {
  const company = await queryOne(`SELECT id FROM companies WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });

  const { method, label, paymentNumber, ussdTemplate, sortOrder } = req.body;
  if (!method || !label) return sendJson(res, 400, { error: "method and label are required" });
  if (paymentNumber && !/^\d{6,15}$/.test(String(paymentNumber))) {
    return sendJson(res, 400, { error: "paymentNumber must be 6-15 digits" });
  }

  const id = randomUUID();
  try {
    await query(
      `INSERT INTO company_payment_methods (id, company_id, method, label, payment_number, ussd_template, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, req.params.id, String(method).trim().toLowerCase(), label, paymentNumber || null, ussdTemplate || null, sortOrder ?? 0]
    );
  } catch (err: any) {
    if (err?.code === "23505") {
      return sendJson(res, 409, { error: `${company.id} already has a payment method with id "${method}"` });
    }
    throw err;
  }
  const created = await queryOne(`SELECT ${METHOD_COLUMNS} FROM company_payment_methods WHERE id=$1`, [id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_payment_method",
    entityType: "company_payment_method",
    entityId: id,
    oldValue: null,
    newValue: created,
  });
  sendJson(res, 201, created);
});

companyPaymentMethodsRouter.put("/admin/payment-methods/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM company_payment_methods WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Payment method not found" });

  const label = req.body.label !== undefined ? req.body.label : existing.label;
  const paymentNumber = req.body.paymentNumber !== undefined ? req.body.paymentNumber : existing.payment_number;
  const ussdTemplate = req.body.ussdTemplate !== undefined ? req.body.ussdTemplate : existing.ussd_template;
  const sortOrder = req.body.sortOrder !== undefined ? req.body.sortOrder : existing.sort_order;
  if (paymentNumber && !/^\d{6,15}$/.test(String(paymentNumber))) {
    return sendJson(res, 400, { error: "paymentNumber must be 6-15 digits" });
  }
  await query(
    `UPDATE company_payment_methods SET label=$1, payment_number=$2, ussd_template=$3, sort_order=$4, updated_at=now() WHERE id=$5`,
    [label, paymentNumber || null, ussdTemplate || null, sortOrder, req.params.id]
  );
  const updated = await queryOne(`SELECT ${METHOD_COLUMNS} FROM company_payment_methods WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_payment_method",
    entityType: "company_payment_method",
    entityId: req.params.id,
    oldValue: existing,
    newValue: updated,
  });
  sendJson(res, 200, updated);
});

companyPaymentMethodsRouter.put("/admin/payment-methods/:id/status", requireAuth("super_admin"), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean" });
  const existing = await queryOne(`SELECT enabled FROM company_payment_methods WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Payment method not found" });
  await query(`UPDATE company_payment_methods SET enabled=$1, updated_at=now() WHERE id=$2`, [enabled, req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_payment_method_status",
    entityType: "company_payment_method",
    entityId: req.params.id,
    oldValue: { enabled: existing.enabled },
    newValue: { enabled },
  });
  sendJson(res, 200, await queryOne(`SELECT ${METHOD_COLUMNS} FROM company_payment_methods WHERE id=$1`, [req.params.id]));
});

companyPaymentMethodsRouter.delete("/admin/payment-methods/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT ${METHOD_COLUMNS} FROM company_payment_methods WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Payment method not found" });
  await query(`DELETE FROM company_payment_methods WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "delete_payment_method",
    entityType: "company_payment_method",
    entityId: req.params.id,
    oldValue: existing,
    newValue: null,
  });
  sendJson(res, 200, { deleted: true });
});

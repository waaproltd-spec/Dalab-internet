import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";

export const companiesRouter = Router();
export const packagesRouter = Router();

// pin_encrypted must never reach any client, including the public endpoint —
// explicit column list rather than SELECT *.
const COMPANY_COLUMNS = `id, name, group_number, color_hex, logo_url, status, gateway, payment_number, payment_ussd_template, ussd_code, visible_customer_app, visible_agent_app, auto_process_enabled, created_at, updated_at`;

companiesRouter.get("/companies", async (_req, res) => {
  const rows = await query(`SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY group_number, name`);
  sendJson(res, 200, rows);
});

companiesRouter.get("/companies/:id/packages", async (req, res) => {
  const rows = await query(
    `SELECT * FROM packages WHERE company_id=$1 AND active=true ORDER BY category_id, price`,
    [req.params.id]
  );
  sendJson(res, 200, rows);
});

companiesRouter.get("/admin/companies", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY group_number, name`));
});

companiesRouter.post("/admin/companies", requirePermission("companies.manage"), async (req, res) => {
  const { id, name, groupNumber, colorHex, gateway } = req.body;
  if (!id || !name || !groupNumber || !colorHex) {
    return sendJson(res, 400, { error: "id, name, groupNumber, colorHex are required" });
  }
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, gateway, status) VALUES ($1,$2,$3,$4,$5,'online')`,
    [id, name, groupNumber, colorHex, gateway ?? "Manual"]
  );
  sendJson(res, 201, await queryOne(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [id]));
});

companiesRouter.put("/admin/companies/:id", requirePermission("companies.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM companies WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Company not found" });
  const merged = { ...existing, ...req.body };
  await query(
    `UPDATE companies SET name=$1, group_number=$2, color_hex=$3, gateway=$4, updated_at=now() WHERE id=$5`,
    [merged.name, merged.group_number, merged.color_hex, merged.gateway, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [req.params.id]));
});

// Payment gateway numbers/templates are Super-Admin-exclusive — unlike most
// other company fields, not delegable via companies.manage, since this
// directly controls where customer money is sent.
companiesRouter.put("/admin/companies/:id/payment-number", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT payment_number, payment_ussd_template FROM companies WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Company not found" });
  const paymentNumber = req.body.paymentNumber ?? existing.payment_number ?? "";
  const paymentUssdTemplate = req.body.paymentUssdTemplate ?? existing.payment_ussd_template ?? "";
  if (paymentNumber && !/^\d{6,15}$/.test(String(paymentNumber))) {
    return sendJson(res, 400, { error: "paymentNumber must be 6-15 digits" });
  }
  await query(
    `UPDATE companies SET payment_number=$1, payment_ussd_template=$2, updated_at=now() WHERE id=$3`,
    [paymentNumber, paymentUssdTemplate, req.params.id]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_payment_number",
    entityType: "company",
    entityId: req.params.id,
    oldValue: { paymentNumber: existing.payment_number, paymentUssdTemplate: existing.payment_ussd_template },
    newValue: { paymentNumber, paymentUssdTemplate },
  });
  sendJson(res, 200, await queryOne(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [req.params.id]));
});

// Also the Active/Inactive toggle shown on the Payment Gateway view — Super
// Admin only, same reasoning as payment-number above.
companiesRouter.put("/admin/companies/:id/status", requireAuth("super_admin"), async (req, res) => {
  const { status } = req.body;
  if (!["online", "offline"].includes(status)) return sendJson(res, 400, { error: "status must be online|offline" });
  const existing = await queryOne(`SELECT status FROM companies WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Company not found" });
  await query(`UPDATE companies SET status=$1, updated_at=now() WHERE id=$2`, [status, req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_status",
    entityType: "company",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status },
  });
  sendJson(res, 200, await queryOne(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [req.params.id]));
});

companiesRouter.put("/admin/companies/:id/visibility", requirePermission("companies.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT visible_customer_app, visible_agent_app FROM companies WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Company not found" });
  const visibleCustomerApp = req.body.visibleCustomerApp ?? existing.visible_customer_app;
  const visibleAgentApp = req.body.visibleAgentApp ?? existing.visible_agent_app;
  await query(
    `UPDATE companies SET visible_customer_app=$1, visible_agent_app=$2, updated_at=now() WHERE id=$3`,
    [Boolean(visibleCustomerApp), Boolean(visibleAgentApp), req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [req.params.id]));
});

// "Configure the automatic processing pipeline" — when off, the matched-SMS
// endpoint tells the Agent App to require manual verification instead of
// auto-dialing (see requiresManualApproval in smsLogs.routes.ts).
companiesRouter.put("/admin/companies/:id/auto-process", requirePermission("devices.manage"), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean" });
  const result = await query(
    `UPDATE companies SET auto_process_enabled=$1, updated_at=now() WHERE id=$2 RETURNING id`,
    [enabled, req.params.id]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Company not found" });
  sendJson(res, 200, await queryOne(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [req.params.id]));
});

// Blocked by ON DELETE RESTRICT from packages/orders if the company is still
// in use — surfaced as a friendly 409 rather than a raw 500, since deleting a
// company with order history would corrupt receipts/reports.
companiesRouter.delete("/admin/companies/:id", requirePermission("companies.manage"), async (req, res) => {
  try {
    const result = await query(`DELETE FROM companies WHERE id=$1 RETURNING id`, [req.params.id]);
    if (result.length === 0) return sendJson(res, 404, { error: "Company not found" });
    sendJson(res, 200, { deleted: true });
  } catch (err: any) {
    if (err?.code === "23503") {
      return sendJson(res, 409, {
        error: "This company has existing packages or orders and can't be deleted. Disable it instead to hide it from the apps.",
      });
    }
    throw err;
  }
});

// Per-provider PIN management (get/set) lives in ussd.routes.ts, grouped
// with the rest of the USSD generation logic that actually uses it.

// ---------------- Packages ----------------

packagesRouter.get("/admin/packages", requireStaff(), async (req, res) => {
  const { companyId } = req.query;
  const rows = companyId
    ? await query(`SELECT * FROM packages WHERE company_id=$1 ORDER BY category_id, price`, [companyId])
    : await query(`SELECT * FROM packages ORDER BY company_id, category_id, price`);
  sendJson(res, 200, rows);
});

packagesRouter.post("/admin/packages", requirePermission("packages.manage"), async (req, res) => {
  const { companyId, categoryId, name, oldPrice, price, mb, minutes, sms, validity, code } = req.body;
  if (!companyId || !categoryId || !name || price == null) {
    return sendJson(res, 400, { error: "companyId, categoryId, name, price are required" });
  }
  const id = randomUUID();
  await query(
    `INSERT INTO packages (id, company_id, category_id, name, old_price, price, mb, minutes, sms, validity, code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, companyId, categoryId, name, oldPrice ?? price, price, mb ?? 0, minutes ?? 0, sms ?? 0, validity ?? "", code ?? null]
  );
  sendJson(res, 201, await queryOne(`SELECT * FROM packages WHERE id=$1`, [id]));
});

packagesRouter.put("/admin/packages/:id", requirePermission("packages.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM packages WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Package not found" });
  const merged = { ...existing, ...req.body };
  await query(
    `UPDATE packages SET name=$1, old_price=$2, price=$3, mb=$4, minutes=$5, sms=$6, validity=$7, active=$8, code=$9 WHERE id=$10`,
    [merged.name, merged.old_price, merged.price, merged.mb, merged.minutes, merged.sms, merged.validity, Boolean(merged.active), merged.code ?? null, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM packages WHERE id=$1`, [req.params.id]));
});

// Soft delete — a package already ordered must stay in history for receipts/reports.
packagesRouter.delete("/admin/packages/:id", requirePermission("packages.manage"), async (req, res) => {
  const result = await query(`UPDATE packages SET active=false WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Package not found" });
  sendJson(res, 200, { deactivated: true });
});

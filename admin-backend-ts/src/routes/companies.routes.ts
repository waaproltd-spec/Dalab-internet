import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { parseDataUri } from "../utils/dataUri.js";

export const companiesRouter = Router();
export const packagesRouter = Router();

// pin_encrypted and logo_data must never reach any client on the list/detail
// routes — logo_data is only ever read by the dedicated .../logo route below
// (raw bytes, not through sendJson); has_logo is a cheap boolean so the
// dashboard/apps know whether to point an <img> at that route at all.
const COMPANY_COLUMNS = `id, name, group_number, color_hex, logo_url, status, gateway, payment_number, payment_ussd_template, ussd_code, visible_customer_app, visible_agent_app, auto_process_enabled, slug, description, sort_order, (logo_data IS NOT NULL) AS has_logo, created_at, updated_at`;

// provider_amount is the internal cost actually requested from the telecom
// via USSD — it can differ from the customer-facing price (e.g. a
// discounted sale), so it's excluded here the same way pin_encrypted is
// excluded from COMPANY_COLUMNS: an implementation detail of the fulfilment
// pipeline, not something the public Customer/Agent App package list needs.
const PUBLIC_PACKAGE_COLUMNS = `id, company_id, category_id, name, old_price, price, mb, minutes, sms, validity, active, code, created_at`;

companiesRouter.get("/companies", async (_req, res) => {
  const rows = await query(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE deleted_at IS NULL ORDER BY group_number, sort_order, name`);
  sendJson(res, 200, rows);
});

// Public — served by company id (not a secret), same reasoning as
// promo-images: an <img src> tag can't send an Authorization header anyway.
companiesRouter.get("/companies/:id/logo", async (req, res) => {
  const row = await queryOne<{ logo_data: Buffer | null; logo_mime_type: string | null }>(
    `SELECT logo_data, logo_mime_type FROM companies WHERE id=$1`,
    [req.params.id]
  );
  if (!row || !row.logo_data) return sendJson(res, 404, { error: "Logo not found" });
  res.setHeader("Content-Type", row.logo_mime_type || "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.logo_data);
});

companiesRouter.get("/companies/:id/packages", async (req, res) => {
  const company = await queryOne(`SELECT id FROM companies WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
  if (!company) return sendJson(res, 200, []);
  const rows = await query(
    `SELECT ${PUBLIC_PACKAGE_COLUMNS} FROM packages WHERE company_id=$1 AND active=true ORDER BY category_id, price`,
    [req.params.id]
  );
  sendJson(res, 200, rows);
});

companiesRouter.get("/admin/companies", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE deleted_at IS NULL ORDER BY group_number, sort_order, name`));
});

companiesRouter.post("/admin/companies", requirePermission("companies.manage"), async (req, res) => {
  const { id, name, groupNumber, colorHex, gateway, slug, description, sortOrder, status, logoBase64 } = req.body;
  if (!id || !name || !groupNumber || !colorHex) {
    return sendJson(res, 400, { error: "id, name, groupNumber, colorHex are required" });
  }
  // The Active/Inactive toggle after creation goes through the dedicated,
  // strict-super_admin /status route (see below) — this is only the initial
  // value on a row the caller is creating themselves, not a later change.
  const initialStatus = status === "offline" ? "offline" : "online";
  const parsedLogo = logoBase64 ? parseDataUri(logoBase64) : null;
  if (logoBase64 && !parsedLogo) {
    return sendJson(res, 400, { error: "logoBase64 must be a data:<mime>;base64,<data> string" });
  }
  try {
    await query(
      `INSERT INTO companies (id, name, group_number, color_hex, gateway, status, slug, description, sort_order, logo_data, logo_mime_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, name, groupNumber, colorHex, gateway ?? "Manual", initialStatus, slug || null, description || null, sortOrder ?? 0, parsedLogo?.data ?? null, parsedLogo?.mimeType ?? null]
    );
  } catch (err: any) {
    if (err?.code === "23505") {
      return sendJson(res, 409, { error: `A company with id "${id}" already exists. Choose a different name.` });
    }
    throw err;
  }
  sendJson(res, 201, await queryOne(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [id]));
});

companiesRouter.put("/admin/companies/:id", requirePermission("companies.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM companies WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Company not found" });
  // Read each field explicitly from the camelCase request body rather than
  // via `{ ...existing, ...req.body }` — existing's keys are snake_case
  // (group_number, color_hex, ...) so that spread silently never picked up
  // a client-sent groupNumber/colorHex update; explicit reads fix that.
  const name = req.body.name !== undefined ? req.body.name : existing.name;
  const groupNumber = req.body.groupNumber !== undefined ? req.body.groupNumber : existing.group_number;
  const colorHex = req.body.colorHex !== undefined ? req.body.colorHex : existing.color_hex;
  const gateway = req.body.gateway !== undefined ? req.body.gateway : existing.gateway;
  const slug = req.body.slug !== undefined ? req.body.slug : existing.slug;
  const description = req.body.description !== undefined ? req.body.description : existing.description;
  const sortOrder = req.body.sortOrder !== undefined ? req.body.sortOrder : existing.sort_order;
  let logoData = existing.logo_data;
  let logoMimeType = existing.logo_mime_type;
  if (req.body.logoBase64) {
    const parsedLogo = parseDataUri(req.body.logoBase64);
    if (!parsedLogo) return sendJson(res, 400, { error: "logoBase64 must be a data:<mime>;base64,<data> string" });
    logoData = parsedLogo.data;
    logoMimeType = parsedLogo.mimeType;
  }
  await query(
    `UPDATE companies SET name=$1, group_number=$2, color_hex=$3, gateway=$4, slug=$5, description=$6, sort_order=$7, logo_data=$8, logo_mime_type=$9, updated_at=now() WHERE id=$10`,
    [name, groupNumber, colorHex, gateway, slug || null, description || null, sortOrder ?? 0, logoData, logoMimeType, req.params.id]
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

// A real company almost always has packages/orders referencing it, which
// ON DELETE RESTRICT blocks a hard delete for (deleting a company with order
// history would corrupt receipts/reports) — so this falls back to a soft
// delete instead of just returning an error: the row and its history stay
// intact, but it's immediately excluded from every company listing (public,
// admin, and everything sourced from those listings), so it disappears from
// the Customer/Agent apps and every dashboard section right away.
companiesRouter.delete("/admin/companies/:id", requirePermission("companies.manage"), async (req, res) => {
  try {
    const result = await query(`DELETE FROM companies WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [req.params.id]);
    if (result.length === 0) return sendJson(res, 404, { error: "Company not found" });
    return sendJson(res, 200, { deleted: true });
  } catch (err: any) {
    if (err?.code !== "23503") throw err;
  }
  const result = await query(
    `UPDATE companies SET deleted_at=now(), status='offline', visible_customer_app=false, visible_agent_app=false, updated_at=now()
     WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
    [req.params.id]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Company not found" });
  sendJson(res, 200, { deleted: true, softDeleted: true });
});

// Per-provider PIN management (get/set) lives in ussd.routes.ts, grouped
// with the rest of the USSD generation logic that actually uses it.

// ---------------- Packages ----------------

packagesRouter.get("/admin/packages", requireStaff(), async (req, res) => {
  const { companyId } = req.query;
  // The "all packages" view excludes packages belonging to a soft-deleted
  // company (same as every other listing) — an explicit ?companyId= lookup
  // is left unfiltered, matching every other by-id route in this file.
  const rows = companyId
    ? await query(`SELECT * FROM packages WHERE company_id=$1 ORDER BY category_id, price`, [companyId])
    : await query(
        `SELECT p.* FROM packages p JOIN companies c ON c.id = p.company_id
         WHERE c.deleted_at IS NULL ORDER BY p.company_id, p.category_id, p.price`
      );
  sendJson(res, 200, rows);
});

packagesRouter.post("/admin/packages", requirePermission("packages.manage"), async (req, res) => {
  const { companyId, categoryId, name, oldPrice, price, providerAmount, mb, minutes, sms, validity, code } = req.body;
  if (!companyId || !categoryId || !name || price == null) {
    return sendJson(res, 400, { error: "companyId, categoryId, name, price are required" });
  }
  const id = randomUUID();
  // "" (an intentionally-cleared/never-filled-in form field) must become
  // NULL, not be sent to Postgres as an empty string literal for a NUMERIC
  // column — unlike price, this field is optional so "" is a valid input.
  const providerAmountValue = providerAmount === "" || providerAmount == null ? null : providerAmount;
  await query(
    `INSERT INTO packages (id, company_id, category_id, name, old_price, price, provider_amount, mb, minutes, sms, validity, code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, companyId, categoryId, name, oldPrice ?? price, price, providerAmountValue, mb ?? 0, minutes ?? 0, sms ?? 0, validity ?? "", code ?? null]
  );
  sendJson(res, 201, await queryOne(`SELECT * FROM packages WHERE id=$1`, [id]));
});

packagesRouter.put("/admin/packages/:id", requirePermission("packages.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM packages WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Package not found" });
  const merged = { ...existing, ...req.body };
  // providerAmount (camelCase, from the request body) is read explicitly
  // rather than via the merged.provider_amount trick above — merged's
  // spread can't bridge the naming mismatch between the client's camelCase
  // body and the DB's snake_case existing row, so merged.provider_amount
  // would only ever reflect the existing value, never an update.
  const rawProviderAmount = req.body.providerAmount !== undefined ? req.body.providerAmount : existing.provider_amount;
  const providerAmount = rawProviderAmount === "" || rawProviderAmount == null ? null : rawProviderAmount;
  await query(
    `UPDATE packages SET name=$1, old_price=$2, price=$3, provider_amount=$4, mb=$5, minutes=$6, sms=$7, validity=$8, active=$9, code=$10 WHERE id=$11`,
    [merged.name, merged.old_price, merged.price, providerAmount, merged.mb, merged.minutes, merged.sms, merged.validity, Boolean(merged.active), merged.code ?? null, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM packages WHERE id=$1`, [req.params.id]));
});

// Soft delete — a package already ordered must stay in history for receipts/reports.
packagesRouter.delete("/admin/packages/:id", requirePermission("packages.manage"), async (req, res) => {
  const result = await query(`UPDATE packages SET active=false WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Package not found" });
  sendJson(res, 200, { deactivated: true });
});

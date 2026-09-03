import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { parseDataUri } from "../utils/dataUri.js";
import { matchTemplateByName, selfHealStuckOrders } from "./ussd.routes.js";
import { broadcast } from "../realtime/orderEvents.js";

export const companiesRouter = Router();
export const packagesRouter = Router();

// pin_encrypted and logo_data must never reach any client on the list/detail
// routes — logo_data is only ever read by the dedicated .../logo route below
// (raw bytes, not through sendJson); has_logo is a cheap boolean so the
// dashboard/apps know whether to point an <img> at that route at all.
const COMPANY_COLUMNS = `id, name, group_number, color_hex, logo_url, status, gateway, payment_number, payment_ussd_template, payout_ussd_template, provider_number, ussd_code, visible_customer_app, visible_agent_app, auto_process_enabled, slug, description, sort_order, fulfillment_method, (logo_data IS NOT NULL) AS has_logo, created_at, updated_at`;

// image_data must never reach any client on the list/detail routes below —
// same "has_X boolean, raw bytes only through their own dedicated route"
// pattern as COMPANY_COLUMNS/has_logo just above. One image (icon) per
// package, not a gallery — mirrors companies.logo_data/logo_mime_type
// exactly rather than shop_product_images' multi-image shape.
const PACKAGE_COLUMNS = `id, company_id, category_id, name, old_price, price, mb, minutes, sms, validity, active, created_at, code, provider_amount, ussd_template_id, somlink_bundle_id, (image_data IS NOT NULL) AS has_image`;
const PACKAGE_COLUMNS_P = `p.id, p.company_id, p.category_id, p.name, p.old_price, p.price, p.mb, p.minutes, p.sms, p.validity, p.active, p.created_at, p.code, p.provider_amount, p.ussd_template_id, p.somlink_bundle_id, (p.image_data IS NOT NULL) AS has_image`;

// Also called by the Agent App (NewSaleScreen/PackagesScreen) for its own
// unrelated "create a sale" flow, so the default (no ?audience=) stays
// unfiltered beyond soft-delete — only an explicit ?audience=customer
// additionally hides a company that's offline or hidden from the Customer
// App specifically, without changing what the Agent App sees.
companiesRouter.get("/companies", async (req, res) => {
  const forCustomer = req.query.audience === "customer";
  const rows = await query(
    forCustomer
      ? `SELECT ${COMPANY_COLUMNS} FROM companies WHERE deleted_at IS NULL AND status='online' AND visible_customer_app=true ORDER BY group_number, sort_order, name`
      : `SELECT ${COMPANY_COLUMNS} FROM companies WHERE deleted_at IS NULL ORDER BY group_number, sort_order, name`
  );
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
  // provider_amount is excluded here (same as pin_encrypted from
  // COMPANY_COLUMNS): an implementation detail of the fulfilment pipeline,
  // not something the public Customer/Agent App package list needs.
  //
  // categoryId (packages.category_id) is the category's slug, not its
  // display name (see the "free text with no DB-level FK" comment on the
  // package-editing routes below) -- it's meant to be a stable grouping
  // key, safe for an admin to rename the category's real name without
  // touching every package. The Customer App previously had no way to
  // reach that real name at all, so it fell back to title-casing the slug
  // itself (e.g. "adsl-plu" -> "Adsl Plu", including a stale slug typo
  // that already dropped a trailing "s"), out of step with whatever the
  // Admin Dashboard's own Category name field says. LEFT JOIN (not INNER)
  // so a package whose category_id doesn't match any current category slug
  // still returns, with category_name simply null -- never dropped from
  // the list over this.
  const rows = await query(
    `SELECT p.id, p.company_id, p.category_id, p.name, p.old_price, p.price, p.mb, p.minutes, p.sms, p.validity, p.active, p.code, p.created_at,
            (p.image_data IS NOT NULL) AS has_image,
            sc.name AS category_name
     FROM packages p
     LEFT JOIN service_categories sc ON sc.company_id = p.company_id AND sc.slug = p.category_id
     WHERE p.company_id=$1 AND p.active=true
     ORDER BY p.category_id, p.price`,
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
  broadcast({ type: "catalog.updated" });
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
  broadcast({ type: "catalog.updated" });
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

// Deliberately a fully independent endpoint/column from payment-number above
// — this is the number embedded in the outgoing USSD request to the telecom
// provider during fulfillment (see generateUssdForOrder's {providerNumber}
// substitution in ussd.routes.ts), never the customer's payment-collection
// number. The two must never share a write path, so a save here can never
// overwrite payment_number and vice versa.
companiesRouter.put("/admin/companies/:id/provider-number", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT provider_number FROM companies WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Company not found" });
  const providerNumber = req.body.providerNumber ?? existing.provider_number ?? "";
  if (providerNumber && !/^\d{6,15}$/.test(String(providerNumber))) {
    return sendJson(res, 400, { error: "providerNumber must be 6-15 digits" });
  }
  await query(`UPDATE companies SET provider_number=$1, updated_at=now() WHERE id=$2`, [providerNumber, req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_provider_number",
    entityType: "company",
    entityId: req.params.id,
    oldValue: { providerNumber: existing.provider_number },
    newValue: { providerNumber },
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
  broadcast({ type: "catalog.updated" });
  sendJson(res, 200, await queryOne(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=$1`, [req.params.id]));
});

// Super-Admin-only, same reasoning as payment-number/provider-number: this
// switches a whole provider from the USSD-dial flow to real-money SOMLINK
// API calls on every future order, so it gets the strictest permission in
// this file rather than the more delegable companies.manage used by the
// general PUT above.
companiesRouter.put("/admin/companies/:id/fulfillment-method", requireAuth("super_admin"), async (req, res) => {
  const { fulfillmentMethod } = req.body;
  if (!["ussd", "somlink"].includes(fulfillmentMethod)) {
    return sendJson(res, 400, { error: "fulfillmentMethod must be ussd|somlink" });
  }
  const existing = await queryOne(`SELECT fulfillment_method FROM companies WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Company not found" });
  await query(`UPDATE companies SET fulfillment_method=$1, updated_at=now() WHERE id=$2`, [fulfillmentMethod, req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_fulfillment_method",
    entityType: "company",
    entityId: req.params.id,
    oldValue: { fulfillmentMethod: existing.fulfillment_method },
    newValue: { fulfillmentMethod },
  });
  broadcast({ type: "catalog.updated" });
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
  broadcast({ type: "catalog.updated" });
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
    broadcast({ type: "catalog.updated" });
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
  broadcast({ type: "catalog.updated" });
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
    ? await query(`SELECT ${PACKAGE_COLUMNS} FROM packages WHERE company_id=$1 ORDER BY category_id, price`, [companyId])
    : await query(
        `SELECT ${PACKAGE_COLUMNS_P} FROM packages p JOIN companies c ON c.id = p.company_id
         WHERE c.deleted_at IS NULL ORDER BY p.company_id, p.category_id, p.price`
      );
  sendJson(res, 200, rows);
});

// A package with no way to resolve a USSD template (neither the real ID
// link nor the legacy name-fallback) will succeed here but silently strand
// the first real customer who buys it — this is the root cause a full
// pipeline audit traced a real stuck-order incident to. Returns a
// non-blocking warning string for the caller to surface, rather than
// failing the save: the Super Admin may be linking the template separately,
// or genuinely wants to save a draft package before USSD Services is set up.
//
// Applies to every future package the same way, regardless of provider --
// this is the one place that decides "can this package actually dial
// today," so a brand-new company/template/package added tomorrow is
// checked by the exact same logic as an existing one, with no
// provider-specific branching. SOMLINK-fulfilled companies are skipped
// entirely: they never use a USSD template at all (somlinkBundleId is
// their equivalent link), so warning about a missing one would be a false
// positive on every single one of their packages.
async function templateWarningFor(companyId: string, packageName: string, ussdTemplateId: string | null): Promise<string | undefined> {
  const company = await queryOne<{ fulfillment_method: string; pin_encrypted: string | null }>(
    `SELECT fulfillment_method, pin_encrypted FROM companies WHERE id=$1`,
    [companyId]
  );
  if (company?.fulfillment_method === "somlink") return undefined;

  let template: { status: string; device_id: string | null } | null = null;
  if (ussdTemplateId) {
    template = await queryOne<{ status: string; device_id: string | null }>(
      `SELECT status, device_id FROM ussd_templates WHERE id=$1`,
      [ussdTemplateId]
    );
  } else {
    // Explicit linking is the primary method going forward -- name-matching
    // is a legacy fallback, not something a new package should silently
    // depend on. Even when the fallback DOES currently resolve a match,
    // that's flagged too (distinctly from "no match at all"), since it's
    // only ever one similarly-named future template away from breaking —
    // exactly the ambiguity class matchTemplateByName's own tie-breaking
    // now fails closed on instead of guessing.
    const match = await matchTemplateByName(companyId, packageName);
    if (!match) {
      return "No USSD template matches this package yet — link one in USSD Services, or a customer paying for it will get stuck.";
    }
    return "This package has no USSD template explicitly linked — it currently resolves one only by matching its name, which can silently break if a similarly-named template is ever added. Link a template explicitly in USSD Services.";
  }

  if (!template) {
    // ussdTemplateId was set but doesn't resolve to a real row -- shouldn't
    // happen for a save that went through validateUssdTemplateId, but a
    // template can be deleted out from under an existing package afterward.
    return "This package's linked USSD template no longer exists — link a new one in USSD Services.";
  }
  if (template.status !== "enabled") {
    return "This package's linked USSD template is currently disabled — it cannot dial until the template is re-enabled in USSD Services.";
  }
  if (!company?.pin_encrypted) {
    return "This provider has no PIN configured yet — set one in USSD Services before a customer can pay for this package.";
  }
  if (!template.device_id) {
    const routing = await queryOne(`SELECT 1 FROM sim_routing WHERE company_id=$1`, [companyId]);
    if (!routing) {
      return "This provider has no device/SIM routing configured, and this template isn't pinned to a specific device either — set one in SIM Routing before a customer can pay for this package.";
    }
  }
  return undefined;
}

async function validateUssdTemplateId(companyId: string, ussdTemplateId: unknown): Promise<string | undefined> {
  if (ussdTemplateId == null || ussdTemplateId === "") return undefined;
  const template = await queryOne(`SELECT id FROM ussd_templates WHERE id=$1 AND company_id=$2`, [ussdTemplateId, companyId]);
  if (!template) return "ussdTemplateId does not match any USSD template for this company";
  return undefined;
}

// "" (an intentionally-blank optional number field, e.g. Old Price/MB/
// Minutes/SMS left empty on the dashboard form) must never reach a
// NUMERIC/INTEGER column as an empty-string literal — Postgres rejects that
// outright with "invalid input syntax for type numeric", and until now that
// rejection became an unhandled promise rejection with no HTTP response ever
// sent (see server.ts's unhandledRejection logger), leaving the client's
// fetch hung forever with zero explanation. Every optional numeric package
// field is normalized through this, matching the pattern already used
// correctly for providerAmount just below.
function numOrDefault(value: unknown, fallback: number | null): number | null {
  return value === "" || value == null ? fallback : (value as number);
}

packagesRouter.post("/admin/packages", requirePermission("packages.manage"), async (req, res) => {
  const { companyId, categoryId, name, oldPrice, price, providerAmount, mb, minutes, sms, validity, code, ussdTemplateId, somlinkBundleId } = req.body;
  if (!companyId || !categoryId || !name || price == null) {
    return sendJson(res, 400, { error: "companyId, categoryId, name, price are required" });
  }
  // categoryId is the category's slug, not its id — packages.category_id is
  // free text with no DB-level FK (a category rename must never risk
  // breaking existing packages), so this is the one place that actually
  // checks it matches a real category for this company, catching a typo'd
  // or stale value before it silently creates an orphan grouping no admin
  // can see or manage.
  if (!(await queryOne(`SELECT id FROM service_categories WHERE company_id=$1 AND slug=$2`, [companyId, categoryId]))) {
    return sendJson(res, 400, { error: "categoryId does not match any category for this company" });
  }
  const templateError = await validateUssdTemplateId(companyId, ussdTemplateId);
  if (templateError) return sendJson(res, 400, { error: templateError });
  const id = randomUUID();
  // "" (an intentionally-cleared/never-filled-in form field) must become
  // NULL, not be sent to Postgres as an empty string literal for a NUMERIC
  // column — unlike price, this field is optional so "" is a valid input.
  const providerAmountValue = providerAmount === "" || providerAmount == null ? null : providerAmount;
  const ussdTemplateIdValue = ussdTemplateId || null;
  const somlinkBundleIdValue = numOrDefault(somlinkBundleId, null);
  await query(
    `INSERT INTO packages (id, company_id, category_id, name, old_price, price, provider_amount, mb, minutes, sms, validity, code, ussd_template_id, somlink_bundle_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, companyId, categoryId, name, numOrDefault(oldPrice, price), price, providerAmountValue, numOrDefault(mb, 0), numOrDefault(minutes, 0), numOrDefault(sms, 0), validity ?? "", code ?? null, ussdTemplateIdValue, somlinkBundleIdValue]
  );
  const created = await queryOne(`SELECT ${PACKAGE_COLUMNS} FROM packages WHERE id=$1`, [id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_package",
    entityType: "package",
    entityId: id,
    oldValue: null,
    newValue: created,
  });
  const templateWarning = await templateWarningFor(companyId, name, ussdTemplateIdValue);
  if (ussdTemplateIdValue) await selfHealStuckOrders(companyId);
  broadcast({ type: "catalog.updated" });
  sendJson(res, 201, { ...created, templateWarning });
});

packagesRouter.put("/admin/packages/:id", requirePermission("packages.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT ${PACKAGE_COLUMNS} FROM packages WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Package not found" });
  // Every field the client can actually send (oldPrice, categoryId,
  // providerAmount, ...) is camelCase, while `existing`'s keys are the DB's
  // snake_case column names — `{ ...existing, ...req.body }` can't bridge
  // that for any of them, so each is read explicitly here (same fix already
  // applied to companies.routes.ts's PUT /admin/companies/:id for the same
  // reason). Previously this meant oldPrice AND categoryId silently never
  // persisted on edit, no matter what the dashboard's form sent.
  const name = req.body.name !== undefined ? req.body.name : existing.name;
  const categoryId = req.body.categoryId !== undefined ? req.body.categoryId : existing.category_id;
  const price = req.body.price !== undefined ? req.body.price : existing.price;
  const oldPrice = numOrDefault(req.body.oldPrice !== undefined ? req.body.oldPrice : existing.old_price, price);
  const mb = numOrDefault(req.body.mb !== undefined ? req.body.mb : existing.mb, 0);
  const minutes = numOrDefault(req.body.minutes !== undefined ? req.body.minutes : existing.minutes, 0);
  const sms = numOrDefault(req.body.sms !== undefined ? req.body.sms : existing.sms, 0);
  const validity = req.body.validity !== undefined ? req.body.validity : existing.validity;
  const active = req.body.active !== undefined ? req.body.active : existing.active;
  const code = req.body.code !== undefined ? req.body.code : existing.code;
  const rawProviderAmount = req.body.providerAmount !== undefined ? req.body.providerAmount : existing.provider_amount;
  const providerAmount = rawProviderAmount === "" || rawProviderAmount == null ? null : rawProviderAmount;
  const ussdTemplateId = req.body.ussdTemplateId !== undefined ? (req.body.ussdTemplateId || null) : existing.ussd_template_id;
  const rawSomlinkBundleId = req.body.somlinkBundleId !== undefined ? req.body.somlinkBundleId : existing.somlink_bundle_id;
  const somlinkBundleId = numOrDefault(rawSomlinkBundleId, null);
  if (
    req.body.categoryId !== undefined &&
    !(await queryOne(`SELECT id FROM service_categories WHERE company_id=$1 AND slug=$2`, [existing.company_id, categoryId]))
  ) {
    return sendJson(res, 400, { error: "categoryId does not match any category for this company" });
  }
  if (req.body.ussdTemplateId !== undefined) {
    const templateError = await validateUssdTemplateId(existing.company_id, ussdTemplateId);
    if (templateError) return sendJson(res, 400, { error: templateError });
  }
  await query(
    `UPDATE packages SET name=$1, category_id=$2, old_price=$3, price=$4, provider_amount=$5, mb=$6, minutes=$7, sms=$8, validity=$9, active=$10, code=$11, ussd_template_id=$12, somlink_bundle_id=$13 WHERE id=$14`,
    [name, categoryId, oldPrice, price, providerAmount, mb, minutes, sms, validity, Boolean(active), code ?? null, ussdTemplateId, somlinkBundleId, req.params.id]
  );
  const updated = await queryOne(`SELECT ${PACKAGE_COLUMNS} FROM packages WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_package",
    entityType: "package",
    entityId: req.params.id,
    oldValue: existing,
    newValue: updated,
  });
  const templateWarning = await templateWarningFor(existing.company_id, name, ussdTemplateId);
  // Only when this request actually touched the link (not every price/name
  // edit) — covers "the Super Admin fixes the mismatch by linking this
  // package to the right template" the same way adding/enabling a template
  // does above.
  if (req.body.ussdTemplateId !== undefined && ussdTemplateId) await selfHealStuckOrders(existing.company_id);
  broadcast({ type: "catalog.updated" });
  sendJson(res, 200, { ...updated, templateWarning });
});

// Public — served by package id (not a secret), same reasoning as
// companies/:id/logo and promo-images: an <img src> tag can't send an
// Authorization header anyway. A dedicated sub-resource rather than a field
// on POST/PUT /admin/packages, matching how the company logo is managed
// separately from the rest of a company's fields.
packagesRouter.get("/packages/:id/image", async (req, res) => {
  const row = await queryOne<{ image_data: Buffer | null; image_mime_type: string | null }>(
    `SELECT image_data, image_mime_type FROM packages WHERE id=$1`,
    [req.params.id]
  );
  if (!row || !row.image_data) return sendJson(res, 404, { error: "Image not found" });
  res.setHeader("Content-Type", row.image_mime_type || "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.image_data);
});

packagesRouter.put("/admin/packages/:id/image", requirePermission("packages.manage"), async (req, res) => {
  const parsed = parseDataUri(req.body.imageBase64);
  if (!parsed) return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });
  const result = await query(`UPDATE packages SET image_data=$1, image_mime_type=$2 WHERE id=$3 RETURNING id`, [
    parsed.data,
    parsed.mimeType,
    req.params.id,
  ]);
  if (result.length === 0) return sendJson(res, 404, { error: "Package not found" });
  sendJson(res, 200, { id: req.params.id, hasImage: true });
});

packagesRouter.delete("/admin/packages/:id/image", requirePermission("packages.manage"), async (req, res) => {
  const result = await query(`UPDATE packages SET image_data=NULL, image_mime_type=NULL WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Package not found" });
  sendJson(res, 200, { id: req.params.id, hasImage: false });
});

// Soft delete — a package already ordered must stay in history for receipts/reports.
packagesRouter.delete("/admin/packages/:id", requirePermission("packages.manage"), async (req, res) => {
  const result = await query(`UPDATE packages SET active=false WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Package not found" });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "deactivate_package",
    entityType: "package",
    entityId: req.params.id,
    oldValue: { active: true },
    newValue: { active: false },
  });
  broadcast({ type: "catalog.updated" });
  sendJson(res, 200, { deactivated: true });
});

// Proactive: every active package that generateUssdForOrder cannot
// successfully dial today, for ANY reason a Super Admin can actually fix —
// no template match, a disabled linked template, a provider with no PIN
// set, or a template with no device and no company-level SIM routing to
// fall back on — so a Super Admin can find and fix these BEFORE a real
// customer payment hits one, instead of after a stuck order is reported.
// Delegates entirely to templateWarningFor (the same check surfaced inline
// the moment a package is created/edited) rather than a separately
// maintained predicate, so this listing can never drift out of sync with
// what saving a package already warns about, and a brand-new provider or
// package added tomorrow is covered automatically with no separate code
// path to remember to update.
packagesRouter.get("/admin/packages/missing-template", requireStaff(), async (_req, res) => {
  const candidates = await query<any>(
    `SELECT ${PACKAGE_COLUMNS_P}, c.name AS company_name FROM packages p
     JOIN companies c ON c.id = p.company_id AND c.deleted_at IS NULL
     WHERE p.active = true
     ORDER BY c.name, p.name`
  );
  const flagged: any[] = [];
  for (const pkg of candidates) {
    const templateWarning = await templateWarningFor(pkg.company_id, pkg.name, pkg.ussd_template_id);
    if (templateWarning) flagged.push({ ...pkg, templateWarning });
  }
  sendJson(res, 200, flagged);
});

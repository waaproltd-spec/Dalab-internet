import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { broadcast } from "../realtime/orderEvents.js";
import { validateInteractiveTemplate } from "../utils/interactiveUssd.js";

/**
 * Menu (interactive) USSD services such as Somtel Dhameys Plus -- one
 * ussd_templates row with dial_mode='interactive' (migration 118) plus the
 * packages linked to it. Packages themselves are created/edited through
 * the normal /admin/packages routes (packages.manage); this router adds:
 *  - viewing a service with its packages (staff),
 *  - editing its USSD menu settings (Super Admin only, like every other
 *    USSD template -- it controls what is dialed with the provider PIN),
 *  - turning the whole service on/off (packages.manage), which is its
 *    service category's status: a disabled category is never listed and
 *    refuses new orders (utils/packageAvailability.ts).
 */
export const interactiveServicesRouter = Router();

const TEMPLATE_COLUMNS = `t.id, t.company_id, t.service_name, t.ussd_code, t.status, t.notes, t.dial_mode, t.reply_steps, t.success_keywords, t.device_id, t.sim_slot, t.created_at, t.updated_at`;

const PACKAGE_COLUMNS = `id, company_id, category_id, name, description, old_price, price, provider_amount, validity, active, code, ussd_template_id,
  sort_order, visible_customer_app, visible_agent_app, orders_enabled, send_count, created_at, updated_at,
  (SELECT COUNT(*)::int FROM orders o WHERE o.package_id = packages.id) AS order_count`;

/** The service's category: the one its packages are filed under. */
async function categoryFor(templateId: string, companyId: string) {
  const slugRow = await queryOne<{ category_id: string }>(
    `SELECT category_id FROM packages WHERE ussd_template_id=$1 GROUP BY category_id ORDER BY COUNT(*) DESC LIMIT 1`,
    [templateId]
  );
  if (!slugRow) return null;
  return queryOne(`SELECT id, slug, name, status FROM service_categories WHERE company_id=$1 AND slug=$2`, [companyId, slugRow.category_id]);
}

interactiveServicesRouter.get("/admin/interactive-services", requireStaff(), async (_req, res) => {
  const rows = await query(
    `SELECT ${TEMPLATE_COLUMNS}, c.name AS company_name,
            (SELECT COUNT(*)::int FROM packages p WHERE p.ussd_template_id = t.id) AS package_count,
            (SELECT COUNT(*)::int FROM packages p WHERE p.ussd_template_id = t.id AND p.active) AS active_package_count
       FROM ussd_templates t JOIN companies c ON c.id = t.company_id AND c.deleted_at IS NULL
      WHERE t.dial_mode = 'interactive'
      ORDER BY c.name, t.service_name`
  );
  sendJson(res, 200, rows);
});

interactiveServicesRouter.get("/admin/interactive-services/:id", requireStaff(), async (req, res) => {
  const template = await queryOne<any>(
    `SELECT ${TEMPLATE_COLUMNS}, c.name AS company_name FROM ussd_templates t JOIN companies c ON c.id = t.company_id
      WHERE t.id=$1 AND t.dial_mode='interactive'`,
    [req.params.id]
  );
  if (!template) return sendJson(res, 404, { error: "Menu USSD service not found" });
  const packages = await query(
    `SELECT ${PACKAGE_COLUMNS} FROM packages WHERE ussd_template_id=$1 ORDER BY active DESC, sort_order, price`,
    [req.params.id]
  );
  const category = await categoryFor(req.params.id, template.company_id);
  const pin = await queryOne<{ is_set: boolean }>(`SELECT (pin_encrypted IS NOT NULL) AS is_set FROM companies WHERE id=$1`, [template.company_id]);
  sendJson(res, 200, { ...template, category, packages, pinIsSet: Boolean(pin?.is_set) });
});

interactiveServicesRouter.put("/admin/interactive-services/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1 AND dial_mode='interactive'`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Menu USSD service not found" });
  const initialDial = req.body.initialDial !== undefined ? String(req.body.initialDial).trim() : existing.ussd_code;
  const replySteps = req.body.replySteps !== undefined ? req.body.replySteps : existing.reply_steps;
  const successKeywords = req.body.successKeywords !== undefined ? req.body.successKeywords : existing.success_keywords;
  const serviceName = req.body.serviceName !== undefined ? String(req.body.serviceName).trim() : existing.service_name;
  const notes = req.body.notes !== undefined ? String(req.body.notes ?? "") : existing.notes;
  if (!serviceName || serviceName.length > 80) return sendJson(res, 400, { error: "Service name must be 1 to 80 characters" });
  const error = validateInteractiveTemplate(initialDial, replySteps, successKeywords);
  if (error) return sendJson(res, 400, { error });
  const cleanSteps = (replySteps as any[]).map((s) => ({
    reply: String(s.reply).trim(),
    expect: (s.expect ?? []).map((e: string) => e.trim()).filter(Boolean),
    ...(s.checkMenuPrice ? { checkMenuPrice: true } : {}),
    ...(s.checkAmount ? { checkAmount: true } : {}),
    ...(s.checkNumber ? { checkNumber: true } : {}),
  }));
  const cleanKeywords = (successKeywords as string[]).map((k) => k.trim()).filter(Boolean);
  await query(
    `UPDATE ussd_templates SET service_name=$1, ussd_code=$2, reply_steps=$3, success_keywords=$4, notes=$5, updated_at=now() WHERE id=$6`,
    [serviceName, initialDial, JSON.stringify(cleanSteps), cleanKeywords, notes, req.params.id]
  );
  const updated = await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_menu_ussd_settings",
    entityType: "ussd_template",
    entityId: req.params.id,
    oldValue: { serviceName: existing.service_name, initialDial: existing.ussd_code, replySteps: existing.reply_steps, successKeywords: existing.success_keywords },
    newValue: { serviceName, initialDial, replySteps: cleanSteps, successKeywords: cleanKeywords },
  });
  sendJson(res, 200, updated);
});

/** The whole service on/off: its category's status. Existing orders are
 * never affected; new orders are refused while it is off. */
interactiveServicesRouter.put("/admin/interactive-services/:id/active", requirePermission("packages.manage"), async (req, res) => {
  if (typeof req.body.active !== "boolean") return sendJson(res, 400, { error: "active must be true or false" });
  const template = await queryOne<any>(`SELECT id, company_id FROM ussd_templates WHERE id=$1 AND dial_mode='interactive'`, [req.params.id]);
  if (!template) return sendJson(res, 404, { error: "Menu USSD service not found" });
  const category = await categoryFor(req.params.id, template.company_id);
  if (!category) return sendJson(res, 409, { error: "This service has no packages yet, so it has no category to turn on or off." });
  const status = req.body.active ? "enabled" : "disabled";
  await query(`UPDATE service_categories SET status=$1, updated_at=now() WHERE id=$2`, [status, category.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: req.body.active ? "activate_menu_service" : "deactivate_menu_service",
    entityType: "ussd_template",
    entityId: req.params.id,
    oldValue: { categoryStatus: category.status },
    newValue: { categoryStatus: status },
  });
  broadcast({ type: "catalog.updated" });
  sendJson(res, 200, { active: req.body.active });
});

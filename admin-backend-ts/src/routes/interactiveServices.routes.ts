import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { broadcast } from "../realtime/orderEvents.js";
import { validateInteractiveTemplate, type ReplyStepConfig } from "../utils/interactiveUssd.js";
import { WALLET_BALANCE_SOURCES } from "../utils/simBalanceCheck.js";

/**
 * Menu (interactive) USSD services such as Somtel Dhameys Plus -- one
 * ussd_templates row with dial_mode='interactive' (migration 118) plus the
 * packages linked to it. Packages themselves are created/edited through
 * the normal /admin/packages routes (packages.manage); this router adds:
 *  - listing services (provider filter, package and order counts) and
 *    viewing one with its packages (staff),
 *  - creating, duplicating, editing and deleting a service (Super Admin
 *    only, like every other USSD template -- it controls what is dialed
 *    with the provider PIN). Only services made from the dashboard that
 *    were never ordered can be deleted; a built-in one (Dhameys Plus) can
 *    only be turned off,
 *  - turning a whole service on/off (packages.manage), which is its
 *    service category's status: a disabled category is never listed and
 *    refuses new orders (utils/packageAvailability.ts).
 *
 * A service made here owns its own category (ussd_templates.
 * menu_category_slug, migration 126) and starts OFF, so it can be checked
 * before any customer sees it. Orders keep the plan they were created with
 * (orders.ussd_plan), so editing, duplicating or deleting a service never
 * changes an order already placed.
 */
export const interactiveServicesRouter = Router();

const TEMPLATE_COLUMNS = `t.id, t.company_id, t.service_name, t.ussd_code, t.status, t.notes, t.dial_mode, t.reply_steps, t.success_keywords, t.balance_source, t.device_id, t.sim_slot, t.menu_category_slug, t.created_at, t.updated_at`;

const PACKAGE_COLUMNS = `id, company_id, category_id, name, description, old_price, price, provider_amount, validity, active, code, ussd_template_id,
  sort_order, visible_customer_app, visible_agent_app, orders_enabled, send_count, created_at, updated_at,
  (SELECT COUNT(*)::int FROM orders o WHERE o.package_id = packages.id) AS order_count`;

/** Category types a new service's category may have (service_categories.service_types). */
const SERVICE_TYPES = ["data", "call", "wifi", "wireless"] as const;

/** The service's category: the one it owns (made here), or, for a service
 * from before migration 126 (Dhameys Plus), the one its packages are filed
 * under -- found exactly as before. */
async function categoryFor(templateId: string, companyId: string) {
  const own = await queryOne<{ menu_category_slug: string | null }>(`SELECT menu_category_slug FROM ussd_templates WHERE id=$1`, [templateId]);
  if (own?.menu_category_slug) {
    return queryOne(`SELECT id, slug, name, status FROM service_categories WHERE company_id=$1 AND slug=$2`, [companyId, own.menu_category_slug]);
  }
  const slugRow = await queryOne<{ category_id: string }>(
    `SELECT category_id FROM packages WHERE ussd_template_id=$1 GROUP BY category_id ORDER BY COUNT(*) DESC LIMIT 1`,
    [templateId]
  );
  if (!slugRow) return null;
  return queryOne(`SELECT id, slug, name, status FROM service_categories WHERE company_id=$1 AND slug=$2`, [companyId, slugRow.category_id]);
}

/** Reads and validates a service's settings from a request body. Missing
 * fields fall back to `existing` (an edit) or to nothing (a create). */
function readSettings(body: any, existing?: any): { error: string } | {
  serviceName: string; initialDial: string; steps: ReplyStepConfig[]; keywords: string[]; balanceSource: string | null; notes: string | null;
} {
  const initialDial = body.initialDial !== undefined ? String(body.initialDial ?? "").trim() : existing?.ussd_code;
  const replySteps = body.replySteps !== undefined ? body.replySteps : existing?.reply_steps;
  const successKeywords = body.successKeywords !== undefined ? body.successKeywords : existing?.success_keywords ?? [];
  const serviceName = body.serviceName !== undefined ? String(body.serviceName ?? "").trim() : existing?.service_name;
  const notes = body.notes !== undefined ? String(body.notes ?? "") : existing?.notes ?? null;
  // Which balance on the dialing SIM pays (checked before every dial):
  // null = the company's own Send Data balance, or a wallet's key.
  const balanceSource = body.balanceSource !== undefined ? (body.balanceSource || null) : existing?.balance_source ?? null;
  if (balanceSource !== null && !Object.hasOwn(WALLET_BALANCE_SOURCES, balanceSource)) {
    return { error: `Paid from must be the company's own SIM balance or one of: ${Object.keys(WALLET_BALANCE_SOURCES).join(", ")}` };
  }
  if (!serviceName || serviceName.length > 80) return { error: "Service name must be 1 to 80 characters" };
  const error = validateInteractiveTemplate(initialDial, replySteps, successKeywords);
  if (error) return { error };
  const steps = (replySteps as any[]).map((s) => ({
    reply: String(s.reply).trim(),
    ...(s.kind === "text" ? { kind: "text" as const } : {}),
    expect: (s.expect ?? []).map((e: string) => e.trim()).filter(Boolean),
    ...(s.checkMenuPrice ? { checkMenuPrice: true } : {}),
    ...(s.checkAmount ? { checkAmount: true } : {}),
    ...(s.checkNumber ? { checkNumber: true } : {}),
  }));
  const keywords = (successKeywords as string[]).map((k) => k.trim()).filter(Boolean);
  return { serviceName, initialDial, steps, keywords, balanceSource, notes };
}

/** "Dhameys Plus 2" -> "dhameys-plus-2", unique among the company's categories. */
async function freeCategorySlug(client: PoolClient, companyId: string, name: string): Promise<string> {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "menu-service";
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const { rows } = await client.query(`SELECT 1 FROM service_categories WHERE company_id=$1 AND slug=$2`, [companyId, slug]);
    if (rows.length === 0) return slug;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/** A service with this name already exists for this provider. */
async function nameTaken(companyId: string, serviceName: string, exceptId: string | null): Promise<boolean> {
  return Boolean(
    await queryOne(
      `SELECT 1 FROM ussd_templates WHERE company_id=$1 AND LOWER(service_name)=LOWER($2) AND ($3::uuid IS NULL OR id<>$3)`,
      [companyId, serviceName, exceptId]
    )
  );
}

interactiveServicesRouter.get("/admin/interactive-services", requireStaff(), async (req, res) => {
  const companyId = req.query.companyId ? String(req.query.companyId) : null;
  const rows = await query(
    `SELECT ${TEMPLATE_COLUMNS}, c.name AS company_name,
            (SELECT COUNT(*)::int FROM packages p WHERE p.ussd_template_id = t.id) AS package_count,
            (SELECT COUNT(*)::int FROM packages p WHERE p.ussd_template_id = t.id AND p.active) AS active_package_count,
            (SELECT COUNT(*)::int FROM orders o JOIN packages p ON p.id = o.package_id WHERE p.ussd_template_id = t.id) AS order_count
       FROM ussd_templates t JOIN companies c ON c.id = t.company_id AND c.deleted_at IS NULL
      WHERE t.dial_mode = 'interactive' AND ($1::text IS NULL OR t.company_id = $1)
      ORDER BY c.name, t.service_name`,
    [companyId]
  );
  // Each service's on/off state (its category), found the same way as the
  // detail view and the on/off switch.
  const withStatus = await Promise.all(
    rows.map(async (row: any) => {
      const category = await categoryFor(row.id, row.company_id);
      return { ...row, category_status: category?.status ?? null };
    })
  );
  sendJson(res, 200, withStatus);
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

/** Create a new menu USSD service for a provider. It starts OFF with no
 * packages; add packages, check them, then turn it on. */
interactiveServicesRouter.post("/admin/interactive-services", requireAuth("super_admin"), async (req, res) => {
  const companyId = String(req.body.companyId ?? "").trim();
  const company = companyId ? await queryOne<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE id=$1 AND deleted_at IS NULL`, [companyId]) : null;
  if (!company) return sendJson(res, 400, { error: "Choose the provider (company) this service belongs to." });
  const serviceType = req.body.serviceType === undefined ? "data" : String(req.body.serviceType);
  if (!(SERVICE_TYPES as readonly string[]).includes(serviceType)) {
    return sendJson(res, 400, { error: `Service type must be one of: ${SERVICE_TYPES.join(", ")}` });
  }
  const settings = readSettings(req.body);
  if ("error" in settings) return sendJson(res, 400, { error: settings.error });
  if (await nameTaken(company.id, settings.serviceName, null)) {
    return sendJson(res, 409, { error: `${company.name} already has a USSD service named "${settings.serviceName}".` });
  }
  const id = randomUUID();
  await withTransaction(async (client) => {
    const slug = await freeCategorySlug(client, company.id, settings.serviceName);
    await client.query(
      `INSERT INTO service_categories (id, company_id, slug, name, status, service_types) VALUES ($1,$2,$3,$4,'disabled',$5)`,
      [randomUUID(), company.id, slug, settings.serviceName, [serviceType]]
    );
    await client.query(
      `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status, notes, dial_mode, reply_steps, success_keywords, balance_source, menu_category_slug)
       VALUES ($1,$2,$3,$4,'enabled',$5,'interactive',$6,$7,$8,$9)`,
      [id, company.id, settings.serviceName, settings.initialDial, settings.notes, JSON.stringify(settings.steps), settings.keywords, settings.balanceSource, slug]
    );
  });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_menu_service",
    entityType: "ussd_template",
    entityId: id,
    oldValue: null,
    newValue: { companyId: company.id, serviceName: settings.serviceName, initialDial: settings.initialDial, replySteps: settings.steps, successKeywords: settings.keywords, balanceSource: settings.balanceSource },
  });
  const created = await queryOne(`SELECT ${TEMPLATE_COLUMNS} FROM ussd_templates t WHERE t.id=$1`, [id]);
  sendJson(res, 201, created);
});

/** Copy a service: its settings and its packages, all OFF, under a new
 * name and its own new category. The original is not touched. */
interactiveServicesRouter.post("/admin/interactive-services/:id/duplicate", requireAuth("super_admin"), async (req, res) => {
  const source = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1 AND dial_mode='interactive'`, [req.params.id]);
  if (!source) return sendJson(res, 404, { error: "Menu USSD service not found" });
  let serviceName = req.body.serviceName !== undefined ? String(req.body.serviceName ?? "").trim() : "";
  if (!serviceName) {
    const base = `${source.service_name} (copy)`.slice(0, 74);
    serviceName = base;
    for (let n = 2; await nameTaken(source.company_id, serviceName, null); n++) serviceName = `${base} ${n}`;
  }
  if (serviceName.length > 80) return sendJson(res, 400, { error: "Service name must be 1 to 80 characters" });
  if (await nameTaken(source.company_id, serviceName, null)) {
    return sendJson(res, 409, { error: `This provider already has a USSD service named "${serviceName}".` });
  }
  const sourceCategory = await categoryFor(source.id, source.company_id);
  const sourceTypes = sourceCategory
    ? (await queryOne<{ service_types: string[] }>(`SELECT service_types FROM service_categories WHERE id=$1`, [(sourceCategory as any).id]))?.service_types
    : null;
  const id = randomUUID();
  const copied = await withTransaction(async (client) => {
    const slug = await freeCategorySlug(client, source.company_id, serviceName);
    await client.query(
      `INSERT INTO service_categories (id, company_id, slug, name, status, service_types) VALUES ($1,$2,$3,$4,'disabled',$5)`,
      [randomUUID(), source.company_id, slug, serviceName, sourceTypes && sourceTypes.length ? sourceTypes : ["data"]]
    );
    await client.query(
      `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status, notes, dial_mode, reply_steps, success_keywords, balance_source, device_id, sim_slot, menu_category_slug)
       VALUES ($1,$2,$3,$4,'enabled',$5,'interactive',$6,$7,$8,$9,$10,$11)`,
      [id, source.company_id, serviceName, source.ussd_code, source.notes, JSON.stringify(source.reply_steps ?? []), source.success_keywords ?? [], source.balance_source, source.device_id, source.sim_slot, slug]
    );
    // Packages are copied INACTIVE: nothing new can be sold until an admin
    // checks the copy and turns its packages and the service on.
    const { rows: copiedRows } = await client.query(
      `INSERT INTO packages (id, company_id, category_id, name, old_price, price, provider_amount, mb, minutes, sms, validity, code, ussd_template_id, somlink_bundle_id, send_count,
                             sort_order, visible_customer_app, visible_agent_app, orders_enabled, description, active)
       SELECT gen_random_uuid(), company_id, $2, name, old_price, price, provider_amount, mb, minutes, sms, validity, code, $3, somlink_bundle_id, send_count,
              sort_order, visible_customer_app, visible_agent_app, orders_enabled, description, false
         FROM packages WHERE ussd_template_id=$1
       RETURNING id`,
      [source.id, slug, id]
    );
    return copiedRows.length;
  });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "duplicate_menu_service",
    entityType: "ussd_template",
    entityId: id,
    oldValue: { sourceId: source.id, sourceName: source.service_name },
    newValue: { serviceName, packagesCopied: copied },
  });
  broadcast({ type: "catalog.updated" });
  const created = await queryOne(`SELECT ${TEMPLATE_COLUMNS} FROM ussd_templates t WHERE t.id=$1`, [id]);
  sendJson(res, 201, { ...created, packagesCopied: copied });
});

/** Delete a service, only while nothing was ever ordered from it: an
 * ordered service keeps its history and can only be turned off. */
interactiveServicesRouter.delete("/admin/interactive-services/:id", requireAuth("super_admin"), async (req, res) => {
  const template = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1 AND dial_mode='interactive'`, [req.params.id]);
  if (!template) return sendJson(res, 404, { error: "Menu USSD service not found" });
  // Services that existed before services could be added from the dashboard
  // (Somtel Dhameys Plus) are never deleted from here -- turn them off instead.
  if (!template.menu_category_slug) {
    return sendJson(res, 409, {
      error: `${template.service_name} is a built-in service, so it can't be deleted. Turn it off instead.`,
      code: "built_in_service",
    });
  }
  const referenced = await queryOne(
    `SELECT 1 FROM orders o JOIN packages p ON p.id = o.package_id WHERE p.ussd_template_id=$1
     UNION ALL SELECT 1 FROM customers c JOIN packages p ON p.id = c.offline_package_id WHERE p.ussd_template_id=$1
     LIMIT 1`,
    [template.id]
  );
  if (referenced) {
    return sendJson(res, 409, {
      error: `${template.service_name} has orders, so it can't be deleted — its history must stay. Turn it off instead.`,
      code: "service_has_orders",
    });
  }
  let packagesDeleted = 0;
  try {
    packagesDeleted = await withTransaction(async (client) => {
      const { rows: deletedRows } = await client.query(`DELETE FROM packages WHERE ussd_template_id=$1 RETURNING id`, [template.id]);
      await client.query(`DELETE FROM ussd_templates WHERE id=$1`, [template.id]);
      // Only the category this service owns, and only if nothing else is filed under it.
      if (template.menu_category_slug) {
        await client.query(
          `DELETE FROM service_categories sc WHERE sc.company_id=$1 AND sc.slug=$2
             AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.company_id=$1 AND p.category_id=$2)`,
          [template.company_id, template.menu_category_slug]
        );
      }
      return deletedRows.length;
    });
  } catch (e: any) {
    if (e?.code === "23503") {
      return sendJson(res, 409, { error: "This service's packages are still referenced by other records — turn it off instead to keep its history." });
    }
    throw e;
  }
  await recordActivity({
    adminId: req.auth!.sub,
    action: "delete_menu_service",
    entityType: "ussd_template",
    entityId: template.id,
    oldValue: { serviceName: template.service_name, companyId: template.company_id, initialDial: template.ussd_code, replySteps: template.reply_steps, packagesDeleted },
    newValue: null,
  });
  broadcast({ type: "catalog.updated" });
  sendJson(res, 200, { deleted: true, packagesDeleted });
});

interactiveServicesRouter.put("/admin/interactive-services/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne<any>(`SELECT * FROM ussd_templates WHERE id=$1 AND dial_mode='interactive'`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Menu USSD service not found" });
  const settings = readSettings(req.body, existing);
  if ("error" in settings) return sendJson(res, 400, { error: settings.error });
  const { serviceName, initialDial, steps: cleanSteps, keywords: cleanKeywords, balanceSource, notes } = settings;
  if (serviceName.toLowerCase() !== String(existing.service_name).toLowerCase() && (await nameTaken(existing.company_id, serviceName, existing.id))) {
    return sendJson(res, 409, { error: `This provider already has a USSD service named "${serviceName}".` });
  }
  await query(
    `UPDATE ussd_templates SET service_name=$1, ussd_code=$2, reply_steps=$3, success_keywords=$4, notes=$5, balance_source=$7, updated_at=now() WHERE id=$6`,
    [serviceName, initialDial, JSON.stringify(cleanSteps), cleanKeywords, notes, req.params.id, balanceSource]
  );
  const updated = await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_menu_ussd_settings",
    entityType: "ussd_template",
    entityId: req.params.id,
    oldValue: { serviceName: existing.service_name, initialDial: existing.ussd_code, replySteps: existing.reply_steps, successKeywords: existing.success_keywords, balanceSource: existing.balance_source },
    newValue: { serviceName, initialDial, replySteps: cleanSteps, successKeywords: cleanKeywords, balanceSource },
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

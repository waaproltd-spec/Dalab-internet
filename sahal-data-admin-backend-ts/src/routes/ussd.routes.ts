import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { encrypt, decrypt, isValidPin } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";
import { broadcast } from "../realtime/orderEvents.js";
import { recordActivity } from "../utils/activityLog.js";
import { markPaymentProcessing, markPaymentFinal } from "../utils/paymentTransactions.js";
import { creditCommissionIfNeeded } from "../utils/commissions.js";
import { creditReferralBonusIfNeeded } from "../utils/referrals.js";

export const ussdRouter = Router();

// ---------------- Per-Provider PIN Management ----------------
// Each provider's PIN is Super-Admin-exclusive — not delegable via
// devices.manage, since it directly controls what gets dialed on a
// customer's behalf (the PIN itself never leaves the server unencrypted
// regardless of who can set it).

ussdRouter.get("/admin/companies/:id/pin-status", requireStaff(), async (req, res) => {
  const company = await queryOne(`SELECT pin_encrypted FROM companies WHERE id=$1`, [req.params.id]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  sendJson(res, 200, { isSet: Boolean(company.pin_encrypted) });
});

ussdRouter.put("/admin/companies/:id/pin", requireAuth("super_admin"), async (req, res) => {
  const { pin } = req.body;
  if (!isValidPin(String(pin ?? ""))) return sendJson(res, 400, { error: "PIN must be 3-8 digits" });
  const existing = await queryOne(`SELECT pin_encrypted FROM companies WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Company not found" });
  await query(`UPDATE companies SET pin_encrypted=$1, updated_at=now() WHERE id=$2`, [encrypt(pin), req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_pin",
    entityType: "company",
    entityId: req.params.id,
    // Never log the actual PIN value, encrypted or not — only that it changed.
    oldValue: { pinSet: Boolean(existing.pin_encrypted) },
    newValue: { pinSet: true },
  });
  await selfHealStuckOrders(req.params.id);
  sendJson(res, 200, { message: "PIN saved" });
});

// ---------------- USSD Templates: CRUD ----------------

ussdRouter.get("/admin/ussd-templates", requireStaff(), async (req, res) => {
  const { companyId } = req.query;
  const rows = companyId
    ? await query(
        `SELECT t.*, c.name AS company_name, c.color_hex AS company_color
         FROM ussd_templates t JOIN companies c ON c.id=t.company_id
         WHERE t.company_id=$1 ORDER BY c.group_number, c.name, t.service_name`,
        [companyId]
      )
    : await query(
        `SELECT t.*, c.name AS company_name, c.color_hex AS company_color
         FROM ussd_templates t JOIN companies c ON c.id=t.company_id
         ORDER BY c.group_number, c.name, t.service_name`
      );
  sendJson(res, 200, rows);
});

// {customerNumber} is accepted as an alias for {number} (same substitution)
// so a template can be written either way — kept for that one placeholder
// only, since {amount}/{pin} were never ambiguous in how admins referred to them.
function hasRequiredPlaceholders(code: string): boolean {
  return (
    (code.includes("{number}") || code.includes("{customerNumber}") || code.includes("{receiverNumber}")) &&
    code.includes("{amount}") &&
    code.includes("{pin}")
  );
}

function isValidSimSlot(value: unknown): value is number | null {
  return value === null || value === undefined || value === 1 || value === 2;
}

// USSD Template management is Super-Admin-exclusive, not delegable via
// devices.manage — these directly control what gets dialed on a customer's
// behalf, same reasoning as the payment-gateway routes above.
ussdRouter.post("/admin/ussd-templates", requireAuth("super_admin"), async (req, res) => {
  const { companyId, serviceName, ussdCode, notes, deviceId, simSlot } = req.body;
  if (!companyId || !serviceName || !ussdCode) {
    return sendJson(res, 400, { error: "companyId, serviceName, and ussdCode are required" });
  }
  if (!hasRequiredPlaceholders(ussdCode)) {
    return sendJson(res, 400, { error: "ussdCode must contain {number}, {amount}, and {pin} placeholders" });
  }
  if (!isValidSimSlot(simSlot)) return sendJson(res, 400, { error: "simSlot must be 1 or 2" });
  const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  if (deviceId) {
    const device = await queryOne(`SELECT id FROM agent_devices WHERE id=$1`, [deviceId]);
    if (!device) return sendJson(res, 404, { error: "Device not found" });
  }

  const id = randomUUID();
  await query(
    `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, notes, status, device_id, sim_slot) VALUES ($1,$2,$3,$4,$5,'enabled',$6,$7)`,
    [id, companyId, serviceName, ussdCode, notes ?? "", deviceId ?? null, simSlot ?? null]
  );
  const created = await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_ussd_template",
    entityType: "ussd_template",
    entityId: id,
    oldValue: null,
    newValue: created,
  });
  // Always enabled on create (see the INSERT above) — a brand-new template
  // could be exactly what unblocks a currently-stuck order.
  await selfHealStuckOrders(companyId);
  sendJson(res, 201, created);
});

ussdRouter.put("/admin/ussd-templates/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Template not found" });
  const merged = { ...existing, ...req.body };
  if (merged.ussd_code && !hasRequiredPlaceholders(merged.ussd_code)) {
    return sendJson(res, 400, { error: "ussdCode must contain {number}, {amount}, and {pin} placeholders" });
  }
  if (merged.status && !["enabled", "disabled"].includes(merged.status)) {
    return sendJson(res, 400, { error: "status must be 'enabled' or 'disabled'" });
  }
  if (req.body.simSlot !== undefined && !isValidSimSlot(req.body.simSlot)) {
    return sendJson(res, 400, { error: "simSlot must be 1 or 2" });
  }
  if (req.body.deviceId) {
    const device = await queryOne(`SELECT id FROM agent_devices WHERE id=$1`, [req.body.deviceId]);
    if (!device) return sendJson(res, 404, { error: "Device not found" });
  }
  await query(
    `UPDATE ussd_templates SET service_name=$1, ussd_code=$2, notes=$3, status=$4, device_id=$5, sim_slot=$6, updated_at=now() WHERE id=$7`,
    [
      req.body.serviceName ?? merged.service_name,
      req.body.ussdCode ?? merged.ussd_code,
      req.body.notes ?? merged.notes,
      req.body.status ?? merged.status,
      req.body.deviceId !== undefined ? (req.body.deviceId || null) : merged.device_id,
      req.body.simSlot !== undefined ? req.body.simSlot : merged.sim_slot,
      req.params.id,
    ]
  );
  const updated = await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_ussd_template",
    entityType: "ussd_template",
    entityId: req.params.id,
    oldValue: existing,
    newValue: updated,
  });
  if (updated?.status === "enabled") await selfHealStuckOrders(updated.company_id);
  sendJson(res, 200, updated);
});

ussdRouter.put("/admin/ussd-templates/:id/status", requireAuth("super_admin"), async (req, res) => {
  const { status } = req.body;
  if (!["enabled", "disabled"].includes(status)) return sendJson(res, 400, { error: "status must be 'enabled' or 'disabled'" });
  const existing = await queryOne(`SELECT status, company_id FROM ussd_templates WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Template not found" });
  await query(`UPDATE ussd_templates SET status=$1, updated_at=now() WHERE id=$2`, [status, req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_ussd_template_status",
    entityType: "ussd_template",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status },
  });
  if (status === "enabled") await selfHealStuckOrders(existing.company_id);
  sendJson(res, 200, await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]));
});

ussdRouter.delete("/admin/ussd-templates/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Template not found" });
  await query(`DELETE FROM ussd_templates WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "delete_ussd_template",
    entityType: "ussd_template",
    entityId: req.params.id,
    oldValue: existing,
    newValue: null,
  });
  sendJson(res, 200, { deleted: true });
});

// ---------------- Generation + audit log ----------------

// Staff-facing — generated_string is returned with the PIN redacted
// (generated_string_masked); the raw column is never selected here at all.
const USSD_LOG_COLUMNS = `id, order_id, template_id, company_id, admin_id, created_at,
  COALESCE(generated_string_masked, '(masked — regenerate to view)') AS generated_string`;

ussdRouter.get("/admin/ussd-logs", requireStaff(), async (req, res) => {
  const { orderId } = req.query;
  const rows = orderId
    ? await query(`SELECT ${USSD_LOG_COLUMNS} FROM ussd_logs WHERE order_id=$1 ORDER BY created_at DESC`, [orderId])
    : await query(`SELECT ${USSD_LOG_COLUMNS} FROM ussd_logs ORDER BY created_at DESC LIMIT 200`);
  sendJson(res, 200, rows);
});

/**
 * Legacy name-based fallback matcher — the exact logic generateUssdForOrder
 * used exclusively before packages.ussd_template_id existed. Still used for
 * (a) any package never migrated to an ID link, and (b) the missing-template
 * validation/listing in companies.routes.ts, so both stay provably in sync
 * with what generateUssdForOrder will actually do at dial time.
 */
export async function matchTemplateByName(companyId: string, packageName: string): Promise<{ id: string } | null> {
  const exact = await queryOne<{ id: string }>(
    `SELECT id FROM ussd_templates WHERE company_id=$1 AND status='enabled' AND LOWER(service_name)=LOWER($2) LIMIT 1`,
    [companyId, packageName]
  );
  if (exact) return exact;
  const candidates = await query<{ id: string; service_name: string }>(
    `SELECT id, service_name FROM ussd_templates WHERE company_id=$1 AND status='enabled'`,
    [companyId]
  );
  return candidates.find((t) => packageName.toLowerCase().includes(t.service_name.toLowerCase())) ?? null;
}

/**
 * Core generation logic, also called from orders.routes.ts when an order
 * moves to 'in_progress'. Matches a template for the order's package via the
 * real ID link (packages.ussd_template_id) when set; only a package never
 * migrated to that link falls back to matchTemplateByName's free-text
 * matching. Returns { ussd, templateId } or { error }.
 */
export async function generateUssdForOrder(order: any, adminId?: string): Promise<{ ussd?: string; maskedUssd?: string; templateId?: string; error?: string }> {
  const company = await queryOne(`SELECT pin_encrypted, provider_number FROM companies WHERE id=$1`, [order.company_id]);
  if (!company?.pin_encrypted) {
    return { error: "No PIN has been set for this provider yet — go to USSD Services and set its PIN." };
  }

  const orderWithPackage = await queryOne(
    `SELECT o.*, p.name AS package_name, p.code AS package_code, p.ussd_template_id
     FROM orders o JOIN packages p ON p.id=o.package_id WHERE o.id=$1`,
    [order.id]
  );

  let template: any = null;
  let linkedTemplateDisabled = false;

  if (orderWithPackage?.ussd_template_id) {
    // The ID-based link is authoritative once set — deliberately does NOT
    // fall through to name-matching if the linked template is disabled or
    // gone: that's a real misconfiguration to surface and fix, not something
    // to silently paper over by re-guessing from the package name.
    template = await queryOne(
      `SELECT * FROM ussd_templates WHERE id=$1 AND company_id=$2 AND status='enabled'`,
      [orderWithPackage.ussd_template_id, order.company_id]
    );
    if (!template) linkedTemplateDisabled = true;
  } else {
    // Never migrated to an ID link — preserve today's exact behavior.
    const match = await matchTemplateByName(order.company_id, orderWithPackage?.package_name ?? "");
    if (match) template = await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [match.id]);
  }

  if (!template) {
    return {
      error: linkedTemplateDisabled
        ? "This package's linked USSD template is disabled — check USSD Services in the dashboard."
        : "No enabled USSD template matches this order's package or provider.",
    };
  }

  const pin = decrypt(company.pin_encrypted);
  // The data package must be delivered to the RECEIVING phone, not
  // necessarily the one that paid — a customer can buy for someone else,
  // and CheckoutScreen already collects sender/receiver as independent
  // fields. Falls back to sender_phone only for the (pre-existing) rare
  // order that somehow has no receiver_phone recorded.
  const deliverTo = order.receiver_phone ?? order.sender_phone ?? "";
  // order.amount is what the CUSTOMER paid (matched against incoming
  // payment SMS in smsLogs.routes.ts — it must stay the discounted price,
  // or a real payment SMS for the discounted amount would stop matching).
  // The USSD request to the provider must use the full, undiscounted
  // package cost instead — order.provider_amount, snapshotted from
  // packages.provider_amount at order-creation time. Falls back to
  // order.amount for a package that was never given a separate provider
  // amount (provider_amount is nullable — "no discount configured").
  const providerAmount = order.provider_amount ?? order.amount;
  // {packageCode}/{packageName} are optional — a template that doesn't
  // reference them is unaffected, .replace() is a no-op if the placeholder
  // isn't present in the string.
  const ussd = template.ussd_code
    .replace("{number}", deliverTo)
    .replace("{customerNumber}", deliverTo)
    .replace("{receiverNumber}", deliverTo)
    .replace("{amount}", String(providerAmount))
    .replace("{pin}", pin)
    .replace("{packageCode}", orderWithPackage?.package_code ?? "")
    .replace("{packageName}", orderWithPackage?.package_name ?? "")
    .replace("{providerNumber}", company.provider_number ?? "");
  // Same substitution, PIN redacted — this is the only copy of the dial
  // string that should ever reach a customer or admin/staff response; the
  // raw `ussd` above is for the Agent App's eyes (and dial) only.
  const maskedUssd = template.ussd_code
    .replace("{number}", deliverTo)
    .replace("{customerNumber}", deliverTo)
    .replace("{receiverNumber}", deliverTo)
    .replace("{amount}", String(providerAmount))
    .replace("{pin}", "•".repeat(pin.length))
    .replace("{packageCode}", orderWithPackage?.package_code ?? "")
    .replace("{packageName}", orderWithPackage?.package_name ?? "")
    .replace("{providerNumber}", company.provider_number ?? "");

  await query(
    `UPDATE orders SET ussd_generated=$1, ussd_generated_masked=$2, ussd_device_id=$3, ussd_sim_slot=$4 WHERE id=$5`,
    [ussd, maskedUssd, template.device_id ?? null, template.sim_slot ?? null, order.id]
  );
  await query(
    `INSERT INTO ussd_logs (id, order_id, template_id, company_id, admin_id, generated_string, generated_string_masked) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), order.id, template.id, order.company_id, adminId ?? null, ussd, maskedUssd]
  );
  return { ussd, maskedUssd, templateId: template.id };
}

/**
 * Re-attempts generateUssdForOrder for every order this company's Super
 * Admin might have just unblocked (a fixed PIN, a newly-enabled/linked
 * template), and broadcasts order.updated for each one that now succeeds —
 * this is what makes "fix the template/PIN" alone enough, with zero
 * one-off manual retry per stuck order. Reuses the exact same
 * generateUssdForOrder used at verify-payment time, and the same
 * broadcast() every other order mutation already uses — no new pub/sub.
 * Best-effort: never throws, so a bug here can't break the save request
 * that triggered it.
 */
export async function selfHealStuckOrders(companyId: string): Promise<{ healed: number; stillStuck: number }> {
  try {
    const stuck = await query<any>(
      `SELECT * FROM orders WHERE status='in_progress' AND ussd_generated IS NULL AND company_id=$1`,
      [companyId]
    );
    let healed = 0;
    for (const order of stuck) {
      const result = await generateUssdForOrder(order);
      await query(`UPDATE orders SET ussd_generation_failed_reason=$1 WHERE id=$2`, [result.error ?? null, order.id]);
      if (result.ussd) {
        healed++;
        broadcast({ type: "order.updated", orderId: order.id });
      }
    }
    return { healed, stillStuck: stuck.length - healed };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("selfHealStuckOrders failed:", (err as Error).message);
    return { healed: 0, stillStuck: 0 };
  }
}

ussdRouter.post("/admin/orders/:id/generate-ussd", requireStaff(), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  const result = await generateUssdForOrder(order, req.auth!.sub);
  if (result.error) return sendJson(res, 422, { error: result.error });
  // Staff-facing — PIN redacted, same as every other admin/customer response.
  sendJson(res, 200, { ussd: result.maskedUssd, templateId: result.templateId });
});

// ---------------- Multi-Device Configuration ----------------

ussdRouter.get("/admin/agent-devices", requireStaff(), async (_req, res) => {
  const devices = await query(`SELECT * FROM agent_devices ORDER BY name`);
  const routing = await query(
    `SELECT sr.*, c.name AS company_name, c.color_hex AS company_color FROM sim_routing sr JOIN companies c ON c.id=sr.company_id`
  );
  const withSims = devices.map((d: any) => ({
    ...d,
    sims: routing.filter((r: any) => r.device_id === d.id).sort((a: any, b: any) => a.sim_slot - b.sim_slot),
  }));
  sendJson(res, 200, withSims);
});

ussdRouter.post("/admin/agent-devices", requirePermission("devices.manage"), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return sendJson(res, 400, { error: "name is required" });
  if (await queryOne(`SELECT id FROM agent_devices WHERE name=$1`, [name])) {
    return sendJson(res, 409, { error: "A device with this name already exists" });
  }
  const id = randomUUID();
  await query(`INSERT INTO agent_devices (id, name, description) VALUES ($1,$2,$3)`, [id, name, description ?? ""]);
  sendJson(res, 201, await queryOne(`SELECT * FROM agent_devices WHERE id=$1`, [id]));
});

ussdRouter.put("/admin/agent-devices/:id", requirePermission("devices.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM agent_devices WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Device not found" });
  await query(`UPDATE agent_devices SET name=$1, description=$2 WHERE id=$3`, [
    req.body.name ?? existing.name, req.body.description ?? existing.description, req.params.id,
  ]);
  sendJson(res, 200, await queryOne(`SELECT * FROM agent_devices WHERE id=$1`, [req.params.id]));
});

ussdRouter.delete("/admin/agent-devices/:id", requirePermission("devices.manage"), async (req, res) => {
  const result = await query(`DELETE FROM agent_devices WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Device not found" });
  sendJson(res, 200, { deleted: true });
});

// A disabled device is rejected at dial-attempt time (see below) — this just
// flips the flag an admin toggles from the dashboard.
ussdRouter.put("/admin/agent-devices/:id/status", requirePermission("devices.manage"), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean" });
  const result = await query(`UPDATE agent_devices SET enabled=$1 WHERE id=$2 RETURNING id`, [enabled, req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Device not found" });
  sendJson(res, 200, await queryOne(`SELECT * FROM agent_devices WHERE id=$1`, [req.params.id]));
});

// ---------------- SIM Routing ----------------

ussdRouter.get("/admin/sim-routing", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT sr.*, c.name AS company_name, d.name AS device_name
       FROM sim_routing sr JOIN companies c ON c.id=sr.company_id LEFT JOIN agent_devices d ON d.id=sr.device_id
       ORDER BY sr.company_id, sr.priority`
    )
  );
});

// A company can now have more than one routed device (a primary and,
// if the business has actually provisioned a second SIM for the same
// provider, a ranked backup) — device_id is part of the row's identity, so
// assigning a *different* device to a company adds a new row rather than
// replacing the old one; remove a device's route explicitly via DELETE.
ussdRouter.put("/admin/sim-routing/:companyId/:deviceId", requireAuth("super_admin"), async (req, res) => {
  const { simSlot, priority } = req.body;
  if (![1, 2].includes(simSlot)) return sendJson(res, 400, { error: "simSlot must be 1 or 2" });
  const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [req.params.companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  if (!(await queryOne(`SELECT id FROM agent_devices WHERE id=$1`, [req.params.deviceId]))) {
    return sendJson(res, 404, { error: "Device not found" });
  }

  await query(
    `INSERT INTO sim_routing (company_id, device_id, sim_slot, priority, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (company_id, device_id) DO UPDATE SET sim_slot=excluded.sim_slot, priority=excluded.priority, updated_by=excluded.updated_by, updated_at=now()`,
    [req.params.companyId, req.params.deviceId, simSlot, priority ?? 1, req.auth!.sub]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM sim_routing WHERE company_id=$1 AND device_id=$2`, [req.params.companyId, req.params.deviceId]));
});

ussdRouter.delete("/admin/sim-routing/:companyId/:deviceId", requireAuth("super_admin"), async (req, res) => {
  const result = await query(
    `DELETE FROM sim_routing WHERE company_id=$1 AND device_id=$2 RETURNING company_id`,
    [req.params.companyId, req.params.deviceId]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Route not found" });
  sendJson(res, 200, { deleted: true });
});

// Agent App: scoped to its own device via ?deviceId= so it only pulls
// routing relevant to itself.
ussdRouter.get("/agent/sim-routing", requireAuth("agent"), async (req, res) => {
  const { deviceId } = req.query;
  const rows = deviceId
    ? await query(
        `SELECT sr.company_id AS "companyId", sr.device_id AS "deviceId", sr.sim_slot AS "simSlot", c.name AS "companyName"
         FROM sim_routing sr JOIN companies c ON c.id=sr.company_id WHERE sr.device_id=$1`,
        [deviceId]
      )
    : await query(
        `SELECT sr.company_id AS "companyId", sr.device_id AS "deviceId", sr.sim_slot AS "simSlot", c.name AS "companyName"
         FROM sim_routing sr JOIN companies c ON c.id=sr.company_id`
      );
  sendJson(res, 200, rows);
});

// Public: the Agent App has no login screen, so it must be able to list
// devices for its device-setup picker before it has ever authenticated (the
// deviceId chosen there is what auth/device-login uses to find its agent).
// Only non-sensitive labels are returned — no PINs, no health telemetry.
ussdRouter.get("/agent/devices", async (_req, res) => {
  sendJson(res, 200, await query(`SELECT id, name, description FROM agent_devices ORDER BY name`));
});

// Health telemetry from the Agent App's background service — battery,
// connectivity, and per-slot SIM presence, so the dashboard can show which
// of two paired devices is actually healthy right now and a Super Admin can
// react (swap SIMs, investigate) before payments are missed. An agent can
// only report health for the device they're actually assigned to.
ussdRouter.post("/agent/devices/:id/heartbeat", requireAuth("agent"), async (req, res) => {
  const agent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [req.auth!.sub]);
  if (agent?.device_id !== req.params.id) {
    return sendJson(res, 403, { error: "You can only report health for your own assigned device." });
  }
  const { batteryPercent, networkOnline, sim1Present, sim2Present, recentDiagnostics } = req.body;
  const result = await query(
    `UPDATE agent_devices SET battery_percent=$1, network_online=$2, sim1_present=$3, sim2_present=$4, last_heartbeat_at=now() WHERE id=$5 RETURNING id`,
    [batteryPercent ?? null, networkOnline !== false, sim1Present ?? null, sim2Present ?? null, req.params.id]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Device not found" });

  // Reliability Dashboard: diagnostics upload piggybacks on the heartbeat
  // that's already ticking every ~60s, rather than a separate endpoint/call.
  // Best-effort by design — a failure here must never fail the heartbeat
  // itself (the device's own local DiagnosticsLog keeps the entries either
  // way, and the Agent App retries the same unsynced entries next tick).
  if (Array.isArray(recentDiagnostics) && recentDiagnostics.length > 0) {
    try {
      const rows = recentDiagnostics.slice(0, 50) as { tag?: unknown; message?: unknown; isError?: unknown; occurredAt?: unknown }[];
      for (const entry of rows) {
        if (typeof entry.tag !== "string" || typeof entry.message !== "string") continue;
        const occurredAt = typeof entry.occurredAt === "number" ? new Date(entry.occurredAt) : new Date();
        await query(
          `INSERT INTO agent_diagnostics_log (id, device_id, tag, message, is_error, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), req.params.id, entry.tag, entry.message, entry.isError !== false, occurredAt]
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to persist agent diagnostics batch:", (err as Error).message);
    }
  }

  sendJson(res, 200, { received: true });
});

// ---------------- Dial attempts (audit trail + retry tracking) ----------------

ussdRouter.post("/agent/orders/:id/dial-attempts", requireAuth("agent"), async (req, res) => {
  const { simSlot, ussdString, attemptNumber } = req.body;
  if (!ussdString) return sendJson(res, 400, { error: "ussdString is required" });
  const order = await queryOne<{ id: string; ussd_generated_masked: string | null }>(
    `SELECT id, ussd_generated_masked FROM orders WHERE id=$1`,
    [req.params.id]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });

  const agent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [req.auth!.sub]);
  if (agent?.device_id) {
    const device = await queryOne<{ enabled: boolean }>(`SELECT enabled FROM agent_devices WHERE id=$1`, [agent.device_id]);
    if (device && !device.enabled) {
      return sendJson(res, 403, { error: "Your assigned device has been disabled by an admin." });
    }
  }

  // Natural key for one logical attempt is (order_id, attempt_number) — a
  // queued/retried audit-log POST after a dropped response must return the
  // existing row's id, not create a second one.
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO ussd_dial_attempts (id, order_id, agent_id, sim_slot, ussd_string, ussd_string_masked, attempt_number, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
      [id, req.params.id, req.auth!.sub, simSlot ?? null, ussdString, order.ussd_generated_masked ?? null, attemptNumber ?? 1]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_ussd_dial_attempts_order_attempt") throw err;
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM ussd_dial_attempts WHERE order_id=$1 AND attempt_number=$2`,
      [req.params.id, attemptNumber ?? 1]
    );
    return sendJson(res, 200, { id: existing!.id });
  }
  // Records which device/SIM is actually handling this payment — the point
  // requirement 4 asks to answer ("is another job already running for this
  // request"): the guard inside markPaymentProcessing only advances a row
  // that isn't already completed/blocked, so a second concurrent dial start
  // for the same order can't silently overwrite a finished payment's record.
  await markPaymentProcessing({
    orderId: req.params.id,
    agentDeviceId: agent?.device_id ?? null,
    simSlot: simSlot ?? null,
    ussdDialAttemptId: id,
  });
  sendJson(res, 201, { id });
});

ussdRouter.put("/agent/dial-attempts/:attemptId", requireAuth("agent"), async (req, res) => {
  const { status, responseMessage } = req.body;
  if (!["success", "failed"].includes(status)) return sendJson(res, 400, { error: "status must be success or failed" });

  // Atomic compare-and-swap: only the first report of a given attempt ever
  // runs the order-completion side effects below — a duplicate/retried
  // report of an already-resolved attempt is a no-op that just returns the
  // current state.
  const result = await query(
    `UPDATE ussd_dial_attempts SET status=$1, response_message=$2, completed_at=now() WHERE id=$3 AND status='pending' RETURNING *`,
    [status, responseMessage ?? null, req.params.attemptId]
  );
  if (result.length === 0) {
    const existing = await queryOne(`SELECT * FROM ussd_dial_attempts WHERE id=$1`, [req.params.attemptId]);
    if (!existing) return sendJson(res, 404, { error: "Dial attempt not found" });
    return sendJson(res, 200, existing);
  }
  const attempt = result[0] as { order_id: string };

  if (status === "success") {
    const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [attempt.order_id]);
    if (order && order.status !== "completed") {
      const completed = await query(
        `UPDATE orders SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1 AND status != 'completed' RETURNING id`,
        [order.id]
      );
      if (completed.length > 0 && order.macaash_earned > 0) {
        try {
          await query(
            `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason, kind) VALUES ($1,$2,$3,$4,$5,'earn')`,
            [randomUUID(), order.customer_id, order.id, order.macaash_earned, `Earned from order ${order.id}`]
          );
          await query(`UPDATE customers SET macaash_points = macaash_points + $1 WHERE id=$2`, [order.macaash_earned, order.customer_id]);
        } catch (err: any) {
          if (err?.code !== "23505" || err?.constraint !== "idx_macaash_tx_order_earn") throw err;
          // already credited by a concurrent call — no-op
        }
      }
      if (completed.length > 0) {
        await creditCommissionIfNeeded(order);
        await creditReferralBonusIfNeeded(order);
      }
      // Only the call that actually flipped the order (completed.length > 0)
      // logs this — a retried/duplicate dial-attempt report never generates
      // a second "completed" Activity Log entry for the same order.
      if (completed.length > 0) {
        await recordActivity({
          adminId: undefined,
          action: "payment_completed",
          entityType: "payment_transaction",
          entityId: order.id,
          oldValue: null,
          newValue: {
            orderId: order.id,
            senderPhone: order.sender_phone,
            receiverPhone: order.receiver_phone,
            amount: order.amount,
            provider: order.company_id,
            transactionRef: null,
            paymentTimestamp: new Date().toISOString(),
            status: "completed",
          },
        });
      }
    }
    await markPaymentFinal(attempt.order_id, "completed");
  } else {
    await query(`UPDATE orders SET status='failed', updated_at=now() WHERE id=$1 AND status != 'completed'`, [attempt.order_id]);
    // Not necessarily final — UssdOrchestrator may still retry, which calls
    // markPaymentProcessing again and can still move this to 'completed'.
    await markPaymentFinal(attempt.order_id, "failed");
  }
  broadcast({ type: "order.updated", orderId: attempt.order_id });
  sendJson(res, 200, await queryOne(`SELECT * FROM ussd_dial_attempts WHERE id=$1`, [req.params.attemptId]));
});

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { encrypt, decrypt, isValidPin } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";
import { broadcast } from "../realtime/orderEvents.js";
import { recordActivity } from "../utils/activityLog.js";

export const ussdRouter = Router();

// ---------------- Per-Provider PIN Management ----------------
// Each provider has its own PIN — super_admin always, plus any admin the
// Super Admin has explicitly granted 'devices.manage' to (the PIN itself
// never leaves the server unencrypted regardless of who can set it).

ussdRouter.get("/admin/companies/:id/pin-status", requireStaff(), async (req, res) => {
  const company = await queryOne(`SELECT pin_encrypted FROM companies WHERE id=$1`, [req.params.id]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  sendJson(res, 200, { isSet: Boolean(company.pin_encrypted) });
});

ussdRouter.put("/admin/companies/:id/pin", requirePermission("devices.manage"), async (req, res) => {
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
  return (code.includes("{number}") || code.includes("{customerNumber}")) && code.includes("{amount}") && code.includes("{pin}");
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
  sendJson(res, 200, updated);
});

ussdRouter.put("/admin/ussd-templates/:id/status", requireAuth("super_admin"), async (req, res) => {
  const { status } = req.body;
  if (!["enabled", "disabled"].includes(status)) return sendJson(res, 400, { error: "status must be 'enabled' or 'disabled'" });
  const existing = await queryOne(`SELECT status FROM ussd_templates WHERE id=$1`, [req.params.id]);
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

ussdRouter.get("/admin/ussd-logs", requireStaff(), async (req, res) => {
  const { orderId } = req.query;
  const rows = orderId
    ? await query(`SELECT * FROM ussd_logs WHERE order_id=$1 ORDER BY created_at DESC`, [orderId])
    : await query(`SELECT * FROM ussd_logs ORDER BY created_at DESC LIMIT 200`);
  sendJson(res, 200, rows);
});

/**
 * Core generation logic, also called from orders.routes.ts when an order
 * moves to 'in_progress'. Matches a template for the order's company by
 * exact service-name match against the package name first, falling back to
 * a partial match. Returns { ussd, templateId } or { error }.
 */
export async function generateUssdForOrder(order: any, adminId?: string): Promise<{ ussd?: string; templateId?: string; error?: string }> {
  const company = await queryOne(`SELECT pin_encrypted FROM companies WHERE id=$1`, [order.company_id]);
  if (!company?.pin_encrypted) {
    return { error: "No PIN has been set for this provider yet — go to USSD Services and set its PIN." };
  }

  const orderWithPackage = await queryOne(
    `SELECT o.*, p.name AS package_name, p.code AS package_code FROM orders o JOIN packages p ON p.id=o.package_id WHERE o.id=$1`,
    [order.id]
  );

  let template = await queryOne(
    `SELECT * FROM ussd_templates WHERE company_id=$1 AND status='enabled' AND LOWER(service_name)=LOWER($2) LIMIT 1`,
    [order.company_id, orderWithPackage?.package_name ?? ""]
  );

  if (!template) {
    const candidates = await query<{ id: string; service_name: string; ussd_code: string }>(
      `SELECT * FROM ussd_templates WHERE company_id=$1 AND status='enabled'`,
      [order.company_id]
    );
    template = candidates.find((t) => (orderWithPackage?.package_name ?? "").toLowerCase().includes(t.service_name.toLowerCase())) ?? null;
  }
  if (!template) return { error: "No enabled USSD template matches this order's package or provider." };

  const pin = decrypt(company.pin_encrypted);
  // {packageCode}/{packageName} are optional — a template that doesn't
  // reference them is unaffected, .replace() is a no-op if the placeholder
  // isn't present in the string.
  const ussd = template.ussd_code
    .replace("{number}", order.sender_phone ?? "")
    .replace("{customerNumber}", order.sender_phone ?? "")
    .replace("{amount}", String(order.amount))
    .replace("{pin}", pin)
    .replace("{packageCode}", orderWithPackage?.package_code ?? "")
    .replace("{packageName}", orderWithPackage?.package_name ?? "");

  await query(
    `UPDATE orders SET ussd_generated=$1, ussd_device_id=$2, ussd_sim_slot=$3 WHERE id=$4`,
    [ussd, template.device_id ?? null, template.sim_slot ?? null, order.id]
  );
  await query(
    `INSERT INTO ussd_logs (id, order_id, template_id, company_id, admin_id, generated_string) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), order.id, template.id, order.company_id, adminId ?? null, ussd]
  );
  return { ussd, templateId: template.id };
}

ussdRouter.post("/admin/orders/:id/generate-ussd", requireStaff(), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  const result = await generateUssdForOrder(order, req.auth!.sub);
  if (result.error) return sendJson(res, 422, { error: result.error });
  sendJson(res, 200, { ussd: result.ussd, templateId: result.templateId });
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
ussdRouter.put("/admin/sim-routing/:companyId/:deviceId", requirePermission("devices.manage"), async (req, res) => {
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

ussdRouter.delete("/admin/sim-routing/:companyId/:deviceId", requirePermission("devices.manage"), async (req, res) => {
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

ussdRouter.get("/agent/devices", requireAuth("agent"), async (_req, res) => {
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
  const { batteryPercent, networkOnline, sim1Present, sim2Present } = req.body;
  const result = await query(
    `UPDATE agent_devices SET battery_percent=$1, network_online=$2, sim1_present=$3, sim2_present=$4, last_heartbeat_at=now() WHERE id=$5 RETURNING id`,
    [batteryPercent ?? null, networkOnline !== false, sim1Present ?? null, sim2Present ?? null, req.params.id]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Device not found" });
  sendJson(res, 200, { received: true });
});

// ---------------- Dial attempts (audit trail + retry tracking) ----------------

ussdRouter.post("/agent/orders/:id/dial-attempts", requireAuth("agent"), async (req, res) => {
  const { simSlot, ussdString, attemptNumber } = req.body;
  if (!ussdString) return sendJson(res, 400, { error: "ussdString is required" });
  const order = await queryOne(`SELECT id FROM orders WHERE id=$1`, [req.params.id]);
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
      `INSERT INTO ussd_dial_attempts (id, order_id, agent_id, sim_slot, ussd_string, attempt_number, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [id, req.params.id, req.auth!.sub, simSlot ?? null, ussdString, attemptNumber ?? 1]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_ussd_dial_attempts_order_attempt") throw err;
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM ussd_dial_attempts WHERE order_id=$1 AND attempt_number=$2`,
      [req.params.id, attemptNumber ?? 1]
    );
    return sendJson(res, 200, { id: existing!.id });
  }
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
    `UPDATE ussd_dial_attempts SET status=$1, response_message=$2 WHERE id=$3 AND status='pending' RETURNING *`,
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
    }
  } else {
    await query(`UPDATE orders SET status='failed', updated_at=now() WHERE id=$1 AND status != 'completed'`, [attempt.order_id]);
  }
  broadcast({ type: "order.updated", orderId: attempt.order_id });
  sendJson(res, 200, await queryOne(`SELECT * FROM ussd_dial_attempts WHERE id=$1`, [req.params.attemptId]));
});

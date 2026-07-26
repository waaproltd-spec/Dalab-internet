import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";
import { encrypt, decrypt } from "../auth/crypto.js";

const PIN_PATTERN = /^\d{3,8}$/;

export function registerUssdRoutes(app, db) {
  // ---------------- Templates: CRUD ----------------

  app.get("/admin/ussd-templates", requireAuth("super_admin"), async (ctx) => {
    const { companyId } = ctx.query;
    const rows = companyId
      ? db.prepare(
          `SELECT t.*, c.name AS company_name, c.color_hex AS company_color
           FROM ussd_templates t JOIN companies c ON c.id = t.company_id
           WHERE t.company_id = ? ORDER BY c.group_number, c.name, t.service_name`
        ).all(companyId)
      : db.prepare(
          `SELECT t.*, c.name AS company_name, c.color_hex AS company_color
           FROM ussd_templates t JOIN companies c ON c.id = t.company_id
           ORDER BY c.group_number, c.name, t.service_name`
        ).all();
    ctx.json(200, rows);
  });

  app.post("/admin/ussd-templates", requireAuth("super_admin"), async (ctx) => {
    const { companyId, serviceName, ussdCode, notes } = ctx.body;
    if (!companyId || !serviceName || !ussdCode) {
      return ctx.json(400, { error: "companyId, serviceName, and ussdCode are required" });
    }
    if (!ussdCode.includes("{number}") || !ussdCode.includes("{amount}") || !ussdCode.includes("{pin}")) {
      return ctx.json(400, { error: "ussdCode must contain {number}, {amount}, and {pin} placeholders" });
    }
    const company = db.prepare(`SELECT id FROM companies WHERE id = ?`).get(companyId);
    if (!company) return ctx.json(404, { error: "Company not found" });

    const id = randomUUID();
    db.prepare(
      `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, notes, status)
       VALUES (?, ?, ?, ?, ?, 'enabled')`
    ).run(id, companyId, serviceName, ussdCode, notes ?? "");
    ctx.json(201, db.prepare(`SELECT * FROM ussd_templates WHERE id = ?`).get(id));
  });

  app.put("/admin/ussd-templates/:id", requireAuth("super_admin"), async (ctx) => {
    const existing = db.prepare(`SELECT * FROM ussd_templates WHERE id = ?`).get(ctx.params.id);
    if (!existing) return ctx.json(404, { error: "Template not found" });

    const merged = { ...existing, ...ctx.body };
    if (merged.ussd_code && (!merged.ussd_code.includes("{number}") || !merged.ussd_code.includes("{amount}") || !merged.ussd_code.includes("{pin}"))) {
      return ctx.json(400, { error: "ussdCode must contain {number}, {amount}, and {pin} placeholders" });
    }
    if (merged.status && !["enabled", "disabled"].includes(merged.status)) {
      return ctx.json(400, { error: "status must be 'enabled' or 'disabled'" });
    }

    db.prepare(
      `UPDATE ussd_templates SET service_name = ?, ussd_code = ?, notes = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      ctx.body.serviceName ?? merged.service_name,
      ctx.body.ussdCode ?? merged.ussd_code,
      ctx.body.notes ?? merged.notes,
      ctx.body.status ?? merged.status,
      ctx.params.id
    );
    ctx.json(200, db.prepare(`SELECT * FROM ussd_templates WHERE id = ?`).get(ctx.params.id));
  });

  app.put("/admin/ussd-templates/:id/status", requireAuth("super_admin"), async (ctx) => {
    const { status } = ctx.body;
    if (!["enabled", "disabled"].includes(status)) return ctx.json(400, { error: "status must be 'enabled' or 'disabled'" });
    const result = db.prepare(`UPDATE ussd_templates SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, ctx.params.id);
    if (result.changes === 0) return ctx.json(404, { error: "Template not found" });
    ctx.json(200, db.prepare(`SELECT * FROM ussd_templates WHERE id = ?`).get(ctx.params.id));
  });

  app.delete("/admin/ussd-templates/:id", requireAuth("super_admin"), async (ctx) => {
    const result = db.prepare(`DELETE FROM ussd_templates WHERE id = ?`).run(ctx.params.id);
    if (result.changes === 0) return ctx.json(404, { error: "Template not found" });
    ctx.json(200, { deleted: true });
  });

  // ---------------- Per-Provider PIN Management ----------------
  // Each telecom provider has its own PIN now (Hormuud, Somtel, Somnet,
  // Amtel each separately) — replaces the earlier single PIN shared across
  // all four. Never returns the PIN itself, only whether one is set; the
  // PIN is only ever decrypted internally, at USSD generation time.

  app.get("/admin/companies/:id/pin-status", requireAuth("super_admin"), async (ctx) => {
    const company = db.prepare(`SELECT pin_encrypted FROM companies WHERE id = ?`).get(ctx.params.id);
    if (!company) return ctx.json(404, { error: "Company not found" });
    ctx.json(200, { isSet: Boolean(company.pin_encrypted) });
  });

  app.put("/admin/companies/:id/pin", requireAuth("super_admin"), async (ctx) => {
    const { pin } = ctx.body;
    if (!PIN_PATTERN.test(String(pin ?? ""))) {
      return ctx.json(400, { error: "PIN must be 3-8 digits" });
    }
    const result = db.prepare(`UPDATE companies SET pin_encrypted = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(encrypt(pin), ctx.params.id);
    if (result.changes === 0) return ctx.json(404, { error: "Company not found" });
    ctx.json(200, { message: "PIN saved" });
  });

  // ---------------- Agent Devices (Multi-Device Configuration) ----------------

  app.get("/admin/agent-devices", requireAuth("super_admin"), async (ctx) => {
    const devices = db.prepare(`SELECT * FROM agent_devices ORDER BY name`).all();
    const routing = db.prepare(
      `SELECT sr.*, c.name AS company_name, c.color_hex AS company_color FROM sim_routing sr JOIN companies c ON c.id = sr.company_id`
    ).all();
    const withSims = devices.map((d) => ({
      ...d,
      sims: routing.filter((r) => r.device_id === d.id).sort((a, b) => a.sim_slot - b.sim_slot),
    }));
    ctx.json(200, withSims);
  });

  app.post("/admin/agent-devices", requireAuth("super_admin"), async (ctx) => {
    const { name, description } = ctx.body;
    if (!name) return ctx.json(400, { error: "name is required" });
    if (db.prepare(`SELECT id FROM agent_devices WHERE name = ?`).get(name)) {
      return ctx.json(409, { error: "A device with this name already exists" });
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO agent_devices (id, name, description) VALUES (?, ?, ?)`).run(id, name, description ?? "");
    ctx.json(201, db.prepare(`SELECT * FROM agent_devices WHERE id = ?`).get(id));
  });

  app.put("/admin/agent-devices/:id", requireAuth("super_admin"), async (ctx) => {
    const existing = db.prepare(`SELECT * FROM agent_devices WHERE id = ?`).get(ctx.params.id);
    if (!existing) return ctx.json(404, { error: "Device not found" });
    db.prepare(`UPDATE agent_devices SET name = ?, description = ? WHERE id = ?`)
      .run(ctx.body.name ?? existing.name, ctx.body.description ?? existing.description, ctx.params.id);
    ctx.json(200, db.prepare(`SELECT * FROM agent_devices WHERE id = ?`).get(ctx.params.id));
  });

  // Deleting a device un-assigns (not deletes) any providers routed to it —
  // the ON DELETE SET NULL on sim_routing.device_id handles this at the DB
  // level, so a provider never silently loses its whole routing row, just
  // its device assignment (visible as "not routed" in the setup UI).
  app.delete("/admin/agent-devices/:id", requireAuth("super_admin"), async (ctx) => {
    const result = db.prepare(`DELETE FROM agent_devices WHERE id = ?`).run(ctx.params.id);
    if (result.changes === 0) return ctx.json(404, { error: "Device not found" });
    ctx.json(200, { deleted: true });
  });

  // ---------------- Generation + audit log ----------------

  app.get("/admin/ussd-logs", requireAuth("super_admin"), async (ctx) => {
    const { orderId } = ctx.query;
    const rows = orderId
      ? db.prepare(`SELECT * FROM ussd_logs WHERE order_id = ? ORDER BY created_at DESC`).all(orderId)
      : db.prepare(`SELECT * FROM ussd_logs ORDER BY created_at DESC LIMIT 200`).all();
    ctx.json(200, rows);
  });

  // Manually (re)generate the USSD string for a given order — the same logic
  // the automatic path (see generateUssdForOrder below, called from
  // orders.js when an order moves to in_progress) uses, exposed here in case
  // an admin needs to retry after fixing a template or setting the PIN late.
  app.post("/admin/orders/:id/generate-ussd", requireAuth("super_admin"), async (ctx) => {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(ctx.params.id);
    if (!order) return ctx.json(404, { error: "Order not found" });

    const result = generateUssdForOrder(db, order, ctx.auth.sub);
    if (result.error) return ctx.json(422, { error: result.error });
    ctx.json(200, { ussd: result.ussd, templateId: result.templateId });
  });

  // ---------------- SIM Routing (Super Admin config, Agent App reads it) ----------------

  app.get("/admin/sim-routing", requireAuth("super_admin"), async (ctx) => {
    const rows = db.prepare(
      `SELECT sr.*, c.name AS company_name, d.name AS device_name
       FROM sim_routing sr
       JOIN companies c ON c.id = sr.company_id
       LEFT JOIN agent_devices d ON d.id = sr.device_id`
    ).all();
    ctx.json(200, rows);
  });

  app.put("/admin/sim-routing/:companyId", requireAuth("super_admin"), async (ctx) => {
    const { simSlot, deviceId } = ctx.body;
    if (![1, 2].includes(simSlot)) return ctx.json(400, { error: "simSlot must be 1 or 2" });
    const company = db.prepare(`SELECT id FROM companies WHERE id = ?`).get(ctx.params.companyId);
    if (!company) return ctx.json(404, { error: "Company not found" });
    if (deviceId && !db.prepare(`SELECT id FROM agent_devices WHERE id = ?`).get(deviceId)) {
      return ctx.json(404, { error: "Device not found" });
    }

    // A partial update (only simSlot, no deviceId) must not silently clear an
    // already-configured device assignment — that was a real bug caught
    // while testing this: an old call site that only ever set simSlot would
    // have wiped out the device every time. Preserve the existing device_id
    // unless the caller explicitly passes a new one.
    const existing = db.prepare(`SELECT device_id FROM sim_routing WHERE company_id = ?`).get(ctx.params.companyId);
    const resolvedDeviceId = deviceId !== undefined ? deviceId : (existing?.device_id ?? null);

    db.prepare(
      `INSERT INTO sim_routing (company_id, device_id, sim_slot, updated_by, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(company_id) DO UPDATE SET device_id = excluded.device_id, sim_slot = excluded.sim_slot, updated_by = excluded.updated_by, updated_at = datetime('now')`
    ).run(ctx.params.companyId, resolvedDeviceId, simSlot, ctx.auth.sub);

    ctx.json(200, db.prepare(`SELECT * FROM sim_routing WHERE company_id = ?`).get(ctx.params.companyId));
  });

  // Agent App: fetch the full routing table on startup / periodically, so it
  // knows which SIM to dial on for a given order's company without asking
  // the admin every time. Optionally scoped to ?deviceId= so a given physical
  // device only pulls the routing rows that actually apply to it — a device
  // configured as "Mobile 1" has no reason to know about Mobile 2's SIMs.
  app.get("/agent/sim-routing", requireAuth("agent"), async (ctx) => {
    const { deviceId } = ctx.query;
    let sql = `SELECT sr.company_id AS "companyId", sr.device_id AS "deviceId", sr.sim_slot AS "simSlot", c.name AS "companyName"
               FROM sim_routing sr JOIN companies c ON c.id = sr.company_id`;
    const args = [];
    if (deviceId) { sql += ` WHERE sr.device_id = ?`; args.push(deviceId); }
    const rows = db.prepare(sql).all(...args);
    ctx.json(200, rows);
  });

  // Agent App: read-only list of devices, so its first-run setup screen can
  // offer "Which device is this?" as a picker rather than free text.
  app.get("/agent/devices", requireAuth("agent"), async (ctx) => {
    ctx.json(200, db.prepare(`SELECT id, name, description FROM agent_devices ORDER BY name`).all());
  });

  // ---------------- Dial attempts (audit trail + retry tracking) ----------------

  // Agent App calls this once per USSD dial attempt (including retries), so
  // failures are visible to the Super Admin even before a final outcome.
  app.post("/agent/orders/:id/dial-attempts", requireAuth("agent"), async (ctx) => {
    const { simSlot, ussdString, attemptNumber } = ctx.body;
    if (!ussdString) return ctx.json(400, { error: "ussdString is required" });
    const order = db.prepare(`SELECT id FROM orders WHERE id = ?`).get(ctx.params.id);
    if (!order) return ctx.json(404, { error: "Order not found" });

    const id = randomUUID();
    db.prepare(
      `INSERT INTO ussd_dial_attempts (id, order_id, agent_id, sim_slot, ussd_string, attempt_number, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    ).run(id, ctx.params.id, ctx.auth.sub, simSlot ?? null, ussdString, attemptNumber ?? 1);

    ctx.json(201, { id });
  });

  // Agent App calls this once the USSD response is known (or a timeout is
  // hit) — success marks the order completed the same way the admin's
  // manual "Mark Completed" does; failed leaves it in a retryable state
  // rather than silently dropping it.
  app.put("/agent/dial-attempts/:attemptId", requireAuth("agent"), async (ctx) => {
    const { status, responseMessage } = ctx.body;
    if (!["success", "failed"].includes(status)) return ctx.json(400, { error: "status must be success or failed" });

    const attempt = db.prepare(`SELECT * FROM ussd_dial_attempts WHERE id = ?`).get(ctx.params.attemptId);
    if (!attempt) return ctx.json(404, { error: "Dial attempt not found" });

    db.prepare(`UPDATE ussd_dial_attempts SET status = ?, response_message = ? WHERE id = ?`)
      .run(status, responseMessage ?? null, ctx.params.attemptId);

    if (status === "success") {
      const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(attempt.order_id);
      if (order && order.status !== "completed") {
        db.prepare(`UPDATE orders SET status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
          .run(order.id);
        if (order.macaash_earned > 0) {
          const already = db.prepare(`SELECT id FROM macaash_transactions WHERE order_id = ?`).get(order.id);
          if (!already) {
            db.prepare(
              `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason) VALUES (?, ?, ?, ?, ?)`
            ).run(randomUUID(), order.customer_id, order.id, order.macaash_earned, `Earned from order ${order.id}`);
            db.prepare(`UPDATE customers SET macaash_points = macaash_points + ? WHERE id = ?`)
              .run(order.macaash_earned, order.customer_id);
          }
        }
      }
    } else {
      db.prepare(`UPDATE orders SET status='failed', updated_at=datetime('now') WHERE id = ? AND status != 'completed'`)
        .run(attempt.order_id);
    }

    ctx.json(200, db.prepare(`SELECT * FROM ussd_dial_attempts WHERE id = ?`).get(ctx.params.attemptId));
  });
}

/**
 * Core generation logic, also called from routes/orders.js when an order is
 * approved (moved to 'in_progress'). Matches a template for the order's
 * company by exact service-name match against the package name first, then
 * falls back to the first enabled template for that company. Returns
 * { ussd, templateId } on success or { error } if nothing can be generated
 * (no PIN set, or no enabled template exists for the company) — callers
 * decide whether that's fatal or just skipped.
 */
export function generateUssdForOrder(db, order, adminId) {
  const company = db.prepare(`SELECT pin_encrypted FROM companies WHERE id = ?`).get(order.company_id);
  if (!company?.pin_encrypted) {
    return { error: "No PIN has been set for this provider yet — go to USSD Services and set its PIN." };
  }

  const orderWithPackage = db.prepare(
    `SELECT o.*, p.name AS package_name FROM orders o JOIN packages p ON p.id = o.package_id WHERE o.id = ?`
  ).get(order.id);

  let template = db.prepare(
    `SELECT * FROM ussd_templates WHERE company_id = ? AND status = 'enabled' AND LOWER(service_name) = LOWER(?) LIMIT 1`
  ).get(order.company_id, orderWithPackage?.package_name ?? "");

  if (!template) {
    // Fall back to a partial match (e.g. package "Anfac Plus 2GB" vs template "Anfac Plus")
    const candidates = db.prepare(`SELECT * FROM ussd_templates WHERE company_id = ? AND status = 'enabled'`).all(order.company_id);
    template = candidates.find((t) => (orderWithPackage?.package_name ?? "").toLowerCase().includes(t.service_name.toLowerCase()));
  }
  if (!template) {
    return { error: "No enabled USSD template matches this order's package or provider." };
  }

  const pin = decrypt(company.pin_encrypted);
  const ussd = template.ussd_code
    .replace("{number}", order.sender_phone ?? "")
    .replace("{amount}", String(order.amount))
    .replace("{pin}", pin);

  db.prepare(`UPDATE orders SET ussd_generated = ? WHERE id = ?`).run(ussd, order.id);
  const logId = randomUUID();
  db.prepare(
    `INSERT INTO ussd_logs (id, order_id, template_id, company_id, admin_id, generated_string)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(logId, order.id, template.id, order.company_id, adminId ?? null, ussd);

  return { ussd, templateId: template.id };
}

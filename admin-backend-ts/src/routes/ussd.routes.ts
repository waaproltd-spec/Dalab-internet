import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { encrypt, decrypt, isValidPin } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";

export const ussdRouter = Router();

// ---------------- Per-Provider PIN Management ----------------
// Each provider has its own PIN — Super Admin only, since it's more
// sensitive than general company edits (which Admin can also do).

ussdRouter.get("/admin/companies/:id/pin-status", requireAuth("super_admin"), async (req, res) => {
  const company = await queryOne(`SELECT pin_encrypted FROM companies WHERE id=$1`, [req.params.id]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  sendJson(res, 200, { isSet: Boolean(company.pin_encrypted) });
});

ussdRouter.put("/admin/companies/:id/pin", requireAuth("super_admin"), async (req, res) => {
  const { pin } = req.body;
  if (!isValidPin(String(pin ?? ""))) return sendJson(res, 400, { error: "PIN must be 3-8 digits" });
  const result = await query(
    `UPDATE companies SET pin_encrypted=$1, updated_at=now() WHERE id=$2 RETURNING id`,
    [encrypt(pin), req.params.id]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Company not found" });
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

function hasRequiredPlaceholders(code: string): boolean {
  return code.includes("{number}") && code.includes("{amount}") && code.includes("{pin}");
}

ussdRouter.post("/admin/ussd-templates", requireStaff(), async (req, res) => {
  const { companyId, serviceName, ussdCode, notes } = req.body;
  if (!companyId || !serviceName || !ussdCode) {
    return sendJson(res, 400, { error: "companyId, serviceName, and ussdCode are required" });
  }
  if (!hasRequiredPlaceholders(ussdCode)) {
    return sendJson(res, 400, { error: "ussdCode must contain {number}, {amount}, and {pin} placeholders" });
  }
  const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });

  const id = randomUUID();
  await query(
    `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, notes, status) VALUES ($1,$2,$3,$4,$5,'enabled')`,
    [id, companyId, serviceName, ussdCode, notes ?? ""]
  );
  sendJson(res, 201, await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [id]));
});

ussdRouter.put("/admin/ussd-templates/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Template not found" });
  const merged = { ...existing, ...req.body };
  if (merged.ussd_code && !hasRequiredPlaceholders(merged.ussd_code)) {
    return sendJson(res, 400, { error: "ussdCode must contain {number}, {amount}, and {pin} placeholders" });
  }
  if (merged.status && !["enabled", "disabled"].includes(merged.status)) {
    return sendJson(res, 400, { error: "status must be 'enabled' or 'disabled'" });
  }
  await query(
    `UPDATE ussd_templates SET service_name=$1, ussd_code=$2, notes=$3, status=$4, updated_at=now() WHERE id=$5`,
    [
      req.body.serviceName ?? merged.service_name,
      req.body.ussdCode ?? merged.ussd_code,
      req.body.notes ?? merged.notes,
      req.body.status ?? merged.status,
      req.params.id,
    ]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]));
});

ussdRouter.put("/admin/ussd-templates/:id/status", requireStaff(), async (req, res) => {
  const { status } = req.body;
  if (!["enabled", "disabled"].includes(status)) return sendJson(res, 400, { error: "status must be 'enabled' or 'disabled'" });
  const result = await query(`UPDATE ussd_templates SET status=$1, updated_at=now() WHERE id=$2 RETURNING id`, [status, req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Template not found" });
  sendJson(res, 200, await queryOne(`SELECT * FROM ussd_templates WHERE id=$1`, [req.params.id]));
});

ussdRouter.delete("/admin/ussd-templates/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM ussd_templates WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Template not found" });
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
    `SELECT o.*, p.name AS package_name FROM orders o JOIN packages p ON p.id=o.package_id WHERE o.id=$1`,
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
  const ussd = template.ussd_code
    .replace("{number}", order.sender_phone ?? "")
    .replace("{amount}", String(order.amount))
    .replace("{pin}", pin);

  await query(`UPDATE orders SET ussd_generated=$1 WHERE id=$2`, [ussd, order.id]);
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

ussdRouter.post("/admin/agent-devices", requireStaff(), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return sendJson(res, 400, { error: "name is required" });
  if (await queryOne(`SELECT id FROM agent_devices WHERE name=$1`, [name])) {
    return sendJson(res, 409, { error: "A device with this name already exists" });
  }
  const id = randomUUID();
  await query(`INSERT INTO agent_devices (id, name, description) VALUES ($1,$2,$3)`, [id, name, description ?? ""]);
  sendJson(res, 201, await queryOne(`SELECT * FROM agent_devices WHERE id=$1`, [id]));
});

ussdRouter.put("/admin/agent-devices/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM agent_devices WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Device not found" });
  await query(`UPDATE agent_devices SET name=$1, description=$2 WHERE id=$3`, [
    req.body.name ?? existing.name, req.body.description ?? existing.description, req.params.id,
  ]);
  sendJson(res, 200, await queryOne(`SELECT * FROM agent_devices WHERE id=$1`, [req.params.id]));
});

ussdRouter.delete("/admin/agent-devices/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM agent_devices WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Device not found" });
  sendJson(res, 200, { deleted: true });
});

// ---------------- SIM Routing ----------------

ussdRouter.get("/admin/sim-routing", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT sr.*, c.name AS company_name, d.name AS device_name
       FROM sim_routing sr JOIN companies c ON c.id=sr.company_id LEFT JOIN agent_devices d ON d.id=sr.device_id`
    )
  );
});

ussdRouter.put("/admin/sim-routing/:companyId", requireStaff(), async (req, res) => {
  const { simSlot, deviceId } = req.body;
  if (![1, 2].includes(simSlot)) return sendJson(res, 400, { error: "simSlot must be 1 or 2" });
  const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [req.params.companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  if (deviceId && !(await queryOne(`SELECT id FROM agent_devices WHERE id=$1`, [deviceId]))) {
    return sendJson(res, 404, { error: "Device not found" });
  }

  // Partial-update safety: a caller that only sends simSlot must not
  // silently clear an already-configured device assignment (a real bug
  // caught and fixed in the SQLite version of this same endpoint).
  const existing = await queryOne(`SELECT device_id FROM sim_routing WHERE company_id=$1`, [req.params.companyId]);
  const resolvedDeviceId = deviceId !== undefined ? deviceId : (existing?.device_id ?? null);

  await query(
    `INSERT INTO sim_routing (company_id, device_id, sim_slot, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (company_id) DO UPDATE SET device_id=excluded.device_id, sim_slot=excluded.sim_slot, updated_by=excluded.updated_by, updated_at=now()`,
    [req.params.companyId, resolvedDeviceId, simSlot, req.auth!.sub]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM sim_routing WHERE company_id=$1`, [req.params.companyId]));
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

// ---------------- Dial attempts (audit trail + retry tracking) ----------------

ussdRouter.post("/agent/orders/:id/dial-attempts", requireAuth("agent"), async (req, res) => {
  const { simSlot, ussdString, attemptNumber } = req.body;
  if (!ussdString) return sendJson(res, 400, { error: "ussdString is required" });
  const order = await queryOne(`SELECT id FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });

  const id = randomUUID();
  await query(
    `INSERT INTO ussd_dial_attempts (id, order_id, agent_id, sim_slot, ussd_string, attempt_number, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
    [id, req.params.id, req.auth!.sub, simSlot ?? null, ussdString, attemptNumber ?? 1]
  );
  sendJson(res, 201, { id });
});

ussdRouter.put("/agent/dial-attempts/:attemptId", requireAuth("agent"), async (req, res) => {
  const { status, responseMessage } = req.body;
  if (!["success", "failed"].includes(status)) return sendJson(res, 400, { error: "status must be success or failed" });

  const attempt = await queryOne(`SELECT * FROM ussd_dial_attempts WHERE id=$1`, [req.params.attemptId]);
  if (!attempt) return sendJson(res, 404, { error: "Dial attempt not found" });

  await query(`UPDATE ussd_dial_attempts SET status=$1, response_message=$2 WHERE id=$3`, [status, responseMessage ?? null, req.params.attemptId]);

  if (status === "success") {
    const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [attempt.order_id]);
    if (order && order.status !== "completed") {
      await query(`UPDATE orders SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1`, [order.id]);
      if (order.macaash_earned > 0) {
        const already = await queryOne(`SELECT id FROM macaash_transactions WHERE order_id=$1`, [order.id]);
        if (!already) {
          await query(
            `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason) VALUES ($1,$2,$3,$4,$5)`,
            [randomUUID(), order.customer_id, order.id, order.macaash_earned, `Earned from order ${order.id}`]
          );
          await query(`UPDATE customers SET macaash_points = macaash_points + $1 WHERE id=$2`, [order.macaash_earned, order.customer_id]);
        }
      }
    }
  } else {
    await query(`UPDATE orders SET status='failed', updated_at=now() WHERE id=$1 AND status != 'completed'`, [attempt.order_id]);
  }
  sendJson(res, 200, await queryOne(`SELECT * FROM ussd_dial_attempts WHERE id=$1`, [req.params.attemptId]));
});

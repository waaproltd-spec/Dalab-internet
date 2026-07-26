import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { hashPassword } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";

export const agentsRouter = Router();

agentsRouter.get("/admin/agents", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT id, phone, name, status, last_login_at, created_at FROM agents ORDER BY created_at DESC`));
});

agentsRouter.post("/admin/agents", requirePermission("agents.manage"), async (req, res) => {
  const { phone, name, password } = req.body;
  if (!phone || !name || !password) return sendJson(res, 400, { error: "phone, name, password are required" });
  if (await queryOne(`SELECT id FROM agents WHERE phone=$1`, [phone])) {
    return sendJson(res, 409, { error: "An agent with this phone already exists" });
  }
  const id = randomUUID();
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,$3,$4)`, [id, phone, name, await hashPassword(password)]);
  sendJson(res, 201, { id, phone, name, status: "active" });
});

agentsRouter.put("/admin/agents/:id", requirePermission("agents.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM agents WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Agent not found" });
  const name = req.body.name ?? existing.name;
  const phone = req.body.phone ?? existing.phone;
  if (phone !== existing.phone && (await queryOne(`SELECT id FROM agents WHERE phone=$1`, [phone]))) {
    return sendJson(res, 409, { error: "An agent with this phone already exists" });
  }
  await query(`UPDATE agents SET name=$1, phone=$2 WHERE id=$3`, [name, phone, req.params.id]);
  sendJson(res, 200, await queryOne(`SELECT id, phone, name, status, last_login_at, created_at FROM agents WHERE id=$1`, [req.params.id]));
});

agentsRouter.put("/admin/agents/:id/suspend", requirePermission("agents.manage"), async (req, res) => {
  const agent = await queryOne(`SELECT * FROM agents WHERE id=$1`, [req.params.id]);
  if (!agent) return sendJson(res, 404, { error: "Agent not found" });
  const next = agent.status === "active" ? "suspended" : "active";
  await query(`UPDATE agents SET status=$1 WHERE id=$2`, [next, req.params.id]);
  sendJson(res, 200, { id: agent.id, status: next });
});

// Agents/customers/orders reference this agent via ON DELETE SET NULL, so a
// hard delete is safe — no order/history rows get orphaned or removed.
agentsRouter.delete("/admin/agents/:id", requirePermission("agents.manage"), async (req, res) => {
  const result = await query(`DELETE FROM agents WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Agent not found" });
  sendJson(res, 200, { deleted: true });
});

// Empty result = unrestricted (today's default behavior for every agent).
agentsRouter.get("/admin/agents/:id/companies", requireStaff(), async (req, res) => {
  const rows = await query(`SELECT company_id FROM agent_company_assignments WHERE agent_id=$1`, [req.params.id]);
  sendJson(res, 200, rows.map((r: any) => r.company_id));
});

agentsRouter.put("/admin/agents/:id/companies", requirePermission("agents.manage"), async (req, res) => {
  const { companyIds } = req.body;
  if (!Array.isArray(companyIds)) return sendJson(res, 400, { error: "companyIds must be an array" });
  if (!(await queryOne(`SELECT id FROM agents WHERE id=$1`, [req.params.id]))) {
    return sendJson(res, 404, { error: "Agent not found" });
  }
  await query(`DELETE FROM agent_company_assignments WHERE agent_id=$1`, [req.params.id]);
  for (const companyId of companyIds) {
    await query(
      `INSERT INTO agent_company_assignments (agent_id, company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, companyId]
    );
  }
  sendJson(res, 200, { companyIds });
});

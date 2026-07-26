import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { hashPassword } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";

export const agentsRouter = Router();

agentsRouter.get("/admin/agents", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT id, phone, name, status, last_login_at, created_at FROM agents ORDER BY created_at DESC`));
});

agentsRouter.post("/admin/agents", requireStaff(), async (req, res) => {
  const { phone, name, password } = req.body;
  if (!phone || !name || !password) return sendJson(res, 400, { error: "phone, name, password are required" });
  if (await queryOne(`SELECT id FROM agents WHERE phone=$1`, [phone])) {
    return sendJson(res, 409, { error: "An agent with this phone already exists" });
  }
  const id = randomUUID();
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,$2,$3,$4)`, [id, phone, name, await hashPassword(password)]);
  sendJson(res, 201, { id, phone, name, status: "active" });
});

agentsRouter.put("/admin/agents/:id/suspend", requireStaff(), async (req, res) => {
  const agent = await queryOne(`SELECT * FROM agents WHERE id=$1`, [req.params.id]);
  if (!agent) return sendJson(res, 404, { error: "Agent not found" });
  const next = agent.status === "active" ? "suspended" : "active";
  await query(`UPDATE agents SET status=$1 WHERE id=$2`, [next, req.params.id]);
  sendJson(res, 200, { id: agent.id, status: next });
});

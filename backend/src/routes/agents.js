import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";
import { hashPassword } from "../auth/crypto.js";

export function registerAgentRoutes(app, db) {
  app.get("/admin/agents", requireAuth("super_admin"), async (ctx) => {
    const rows = db.prepare(`SELECT id, phone, name, status, last_login_at, created_at FROM agents ORDER BY created_at DESC`).all();
    ctx.json(200, rows);
  });

  app.post("/admin/agents", requireAuth("super_admin"), async (ctx) => {
    const { phone, name, password } = ctx.body;
    if (!phone || !name || !password) return ctx.json(400, { error: "phone, name, password are required" });
    if (db.prepare(`SELECT id FROM agents WHERE phone = ?`).get(phone)) {
      return ctx.json(409, { error: "An agent with this phone already exists" });
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO agents (id, phone, name, password_hash) VALUES (?, ?, ?, ?)`)
      .run(id, phone, name, hashPassword(password));
    ctx.json(201, { id, phone, name, status: "active" });
  });

  app.put("/admin/agents/:id/suspend", requireAuth("super_admin"), async (ctx) => {
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(ctx.params.id);
    if (!agent) return ctx.json(404, { error: "Agent not found" });
    const next = agent.status === "active" ? "suspended" : "active";
    db.prepare(`UPDATE agents SET status = ? WHERE id = ?`).run(next, ctx.params.id);
    ctx.json(200, { id: agent.id, status: next });
  });
}

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

export const notificationsRouter = Router();

notificationsRouter.post("/admin/notifications/send", requireStaff(), async (req, res) => {
  const { type, title, body } = req.body;
  if (!["push", "promotion", "maintenance"].includes(type) || !title) {
    return sendJson(res, 400, { error: "type (push|promotion|maintenance) and title are required" });
  }
  const id = randomUUID();
  await query(`INSERT INTO notifications (id, type, title, body) VALUES ($1,$2,$3,$4)`, [id, type, title, body ?? ""]);
  sendJson(res, 201, { id, type, title, body });
});

notificationsRouter.get("/agent/notifications", requireAuth("agent"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM notifications ORDER BY sent_at DESC LIMIT 50`));
});

notificationsRouter.get("/notifications", requireAuth("customer"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM notifications WHERE type != 'maintenance' ORDER BY sent_at DESC LIMIT 50`));
});

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

notificationsRouter.get("/admin/notifications", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM notifications ORDER BY sent_at DESC LIMIT 100`));
});

notificationsRouter.get("/agent/notifications", requireAuth("agent"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM notifications ORDER BY sent_at DESC LIMIT 50`));
});

// A customer sees every broadcast (customer_id IS NULL, unchanged) plus
// anything targeted specifically at them — e.g. a reply to their own
// feedback/suggestion (POST /admin/feedback/:id sets customer_id when it
// inserts a 'feedback_update' notification).
notificationsRouter.get("/notifications", requireAuth("customer"), async (req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT * FROM notifications
       WHERE type != 'maintenance' AND (customer_id IS NULL OR customer_id = $1)
       ORDER BY sent_at DESC LIMIT 50`,
      [req.auth!.sub]
    )
  );
});

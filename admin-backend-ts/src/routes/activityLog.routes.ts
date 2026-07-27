import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

export const activityLogRouter = Router();

/**
 * Read-only view of every recorded config change (payment gateway numbers/
 * templates, USSD templates, provider PINs) — who changed it, when, and the
 * before/after values. Super Admin only, same as the write routes it audits.
 */
activityLogRouter.get("/admin/activity-log", requireAuth("super_admin"), async (req, res) => {
  const { entityType, limit } = req.query as Record<string, string | undefined>;
  const cappedLimit = Math.min(Number(limit) || 100, 500);
  const args: unknown[] = [];
  let sql = `
    SELECT l.id, l.action, l.entity_type, l.entity_id, l.old_value, l.new_value, l.created_at,
           a.email AS admin_email
    FROM admin_activity_log l
    LEFT JOIN admin_users a ON a.id = l.admin_id
    WHERE 1=1`;
  if (entityType) {
    args.push(entityType);
    sql += ` AND l.entity_type=$${args.length}`;
  }
  args.push(cappedLimit);
  sql += ` ORDER BY l.created_at DESC LIMIT $${args.length}`;
  sendJson(res, 200, await query(sql, args));
});

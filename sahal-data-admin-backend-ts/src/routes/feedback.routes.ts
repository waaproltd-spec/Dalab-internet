import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { broadcast } from "../realtime/orderEvents.js";

export const feedbackRouter = Router();

// Exact category list the Customer App's "Select Issue" sheet offers —
// validated server-side too so the admin dashboard's category filter never
// has to deal with free-text drift.
const FEEDBACK_CATEGORIES = [
  "App Crashes Frequently",
  "Unable to Complete Payment",
  "Internet Package Problem",
  "Payment Verification Issue",
  "Make Suggestion",
  "Feedback",
  "Other",
];

const FEEDBACK_STATUSES = ["pending", "reviewed", "implemented", "rejected"];

const FEEDBACK_SELECT = `
  SELECT f.*, c.name AS customer_name, c.phone AS customer_phone
  FROM feedback f
  JOIN customers c ON c.id = f.customer_id
`;

feedbackRouter.post("/feedback", requireAuth("customer"), async (req, res) => {
  const { category, message, deviceInfo } = req.body ?? {};
  if (!FEEDBACK_CATEGORIES.includes(category)) {
    return sendJson(res, 400, { error: `category must be one of ${FEEDBACK_CATEGORIES.join(", ")}` });
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return sendJson(res, 400, { error: "message is required" });
  }

  const id = randomUUID();
  await query(
    `INSERT INTO feedback (id, customer_id, category, message, device_info) VALUES ($1,$2,$3,$4,$5)`,
    [id, req.auth!.sub, category, message.trim(), deviceInfo ?? null]
  );
  broadcast({ type: "feedback.updated" });
  sendJson(res, 201, { id, category, message: message.trim(), status: "pending" });
});

feedbackRouter.get("/admin/feedback/categories", requireStaff(), async (_req, res) => {
  sendJson(res, 200, FEEDBACK_CATEGORIES);
});

// "New" here means genuinely unactioned — the same bar every other sidebar
// warning badge this dashboard already uses applies (stuck payments,
// low-balance SIMs, missing USSD templates): a real, unresolved item, not a
// running total.
feedbackRouter.get("/admin/feedback/pending-count", requireStaff(), async (_req, res) => {
  const row = await queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM feedback WHERE status='pending'`);
  sendJson(res, 200, { count: Number(row?.count ?? 0) });
});

feedbackRouter.get("/admin/feedback", requireStaff(), async (req, res) => {
  const { category, status, search, dateFrom, dateTo, limit, offset } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `${FEEDBACK_SELECT} WHERE 1=1`;
  if (category) { args.push(category); sql += ` AND f.category=$${args.length}`; }
  if (status) { args.push(status); sql += ` AND f.status=$${args.length}`; }
  if (dateFrom) { args.push(dateFrom); sql += ` AND f.created_at >= $${args.length}`; }
  if (dateTo) { args.push(dateTo); sql += ` AND f.created_at <= $${args.length}`; }
  if (search) {
    args.push(`%${search}%`);
    const p = args.length;
    sql += ` AND (f.message ILIKE $${p} OR c.name ILIKE $${p} OR c.phone ILIKE $${p})`;
  }
  const cappedLimit = Math.min(Number(limit) || 200, 1000);
  args.push(cappedLimit);
  sql += ` ORDER BY f.created_at DESC LIMIT $${args.length}`;
  if (offset) { args.push(Number(offset)); sql += ` OFFSET $${args.length}`; }
  sendJson(res, 200, await query(sql, args));
});

// Status update + reply, combined into one action since an admin almost
// always does both together ("marking implemented" without a word to the
// customer is rarely the intent). Either field alone is still valid — a
// reply-only note doesn't have to also change status, and vice versa.
feedbackRouter.put("/admin/feedback/:id", requirePermission("feedback.manage"), async (req, res) => {
  const existing = await queryOne<any>(`${FEEDBACK_SELECT} WHERE f.id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Feedback not found" });

  const { status, adminReply } = req.body ?? {};
  if (status !== undefined && !FEEDBACK_STATUSES.includes(status)) {
    return sendJson(res, 400, { error: `status must be one of ${FEEDBACK_STATUSES.join(", ")}` });
  }
  if (status === undefined && adminReply === undefined) {
    return sendJson(res, 400, { error: "Provide status and/or adminReply" });
  }

  const nextStatus = status ?? existing.status;
  await query(
    `UPDATE feedback
     SET status=$1,
         admin_reply=COALESCE($2, admin_reply),
         replied_by=CASE WHEN $2 IS NOT NULL THEN $3 ELSE replied_by END,
         replied_at=CASE WHEN $2 IS NOT NULL THEN now() ELSE replied_at END,
         updated_at=now()
     WHERE id=$4`,
    [nextStatus, adminReply ?? null, req.auth!.sub, req.params.id]
  );

  // Every real action the user asked for ("accepted, implemented, or
  // rejected") is a transition away from pending — notify on any of them,
  // not just the terminal ones, so "reviewed" (the closest fit to "accepted"
  // among the four required statuses) tells the customer their submission
  // was actually looked at.
  if (status && status !== "pending" && status !== existing.status) {
    const STATUS_LABEL: Record<string, string> = {
      reviewed: "reviewed",
      implemented: "implemented",
      rejected: "rejected",
    };
    await query(
      `INSERT INTO notifications (id, type, title, body, customer_id)
       VALUES ($1,'feedback_update',$2,$3,$4)`,
      [
        randomUUID(),
        "Update on your feedback",
        `Your "${existing.category}" submission has been ${STATUS_LABEL[status] ?? status}.${adminReply ? ` "${adminReply}"` : ""}`,
        existing.customer_id,
      ]
    );
  }

  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_feedback_status",
    entityType: "feedback",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status: nextStatus, adminReply: adminReply ?? existing.admin_reply },
  });

  broadcast({ type: "feedback.updated" });
  sendJson(res, 200, await queryOne(`${FEEDBACK_SELECT} WHERE f.id=$1`, [req.params.id]));
});

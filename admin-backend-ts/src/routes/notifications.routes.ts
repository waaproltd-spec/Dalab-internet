import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { sendPushToTokens, isPushConfigured } from "../utils/pushNotifications.js";

export const notificationsRouter = Router();

const CUSTOMER_NOTIFICATION_TYPES = ["push", "promotion", "order_update", "exchange_update"];

// Predefined customer segments for targetType='group' — no general-purpose
// customer-tagging system exists yet, so these are the specific, useful
// groupings an admin actually needs today rather than a bigger feature.
// Each must return customer ids only (no other columns) so it can be used
// identically to the single/multiple/all id-list paths below.
const GROUP_QUERIES: Record<string, string> = {
  internet_customers: `SELECT DISTINCT customer_id AS id FROM orders WHERE customer_id IS NOT NULL`,
  exchange_customers: `SELECT DISTINCT customer_id AS id FROM exchange_orders WHERE customer_id IS NOT NULL`,
  new_this_week: `SELECT id FROM customers WHERE created_at >= now() - interval '7 days'`,
};

async function resolveTargetCustomerIds(
  targetType: string,
  customerIds: unknown,
  group: unknown
): Promise<{ ids: string[]; error?: string }> {
  if (targetType === "single" || targetType === "multiple") {
    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      return { ids: [], error: "customerIds must be a non-empty array for targetType 'single'/'multiple'" };
    }
    if (targetType === "single" && customerIds.length !== 1) {
      return { ids: [], error: "targetType 'single' takes exactly one customer id — use 'multiple' for more than one" };
    }
    const rows = await query<{ id: string }>(
      `SELECT id FROM customers WHERE id = ANY($1::uuid[]) AND status != 'blocked'`,
      [customerIds]
    );
    return { ids: rows.map((r) => r.id) };
  }
  if (targetType === "group") {
    const sql = GROUP_QUERIES[group as string];
    if (!sql) {
      return { ids: [], error: `group must be one of: ${Object.keys(GROUP_QUERIES).join(", ")}` };
    }
    const rows = await query<{ id: string }>(
      `SELECT g.id FROM (${sql}) g JOIN customers c ON c.id = g.id WHERE c.status != 'blocked'`
    );
    return { ids: rows.map((r) => r.id) };
  }
  if (targetType === "all") {
    const rows = await query<{ id: string }>(`SELECT id FROM customers WHERE status != 'blocked'`);
    return { ids: rows.map((r) => r.id) };
  }
  return { ids: [], error: "targetType must be one of: single, multiple, group, all" };
}

/**
 * Admin -> Customer notifications, real push included. Extends the
 * pre-existing broadcast-only endpoint rather than replacing it: a
 * 'maintenance' notice (agent/system-facing — customers never see it, see
 * GET /notifications below) still takes the original single
 * customer_id=NULL broadcast row it always has, unchanged. Every other type
 * now fans out to one row per targeted customer (required for accurate
 * per-customer read tracking — see 050_notifications_push.sql) and attempts
 * a real push to each of their registered devices.
 */
notificationsRouter.post("/admin/notifications/send", requireStaff(), async (req, res) => {
  const { type, title, body, targetType, customerIds, group, relatedOrderId, relatedExchangeOrderId } = req.body ?? {};
  if (!title) return sendJson(res, 400, { error: "title is required" });

  if (type === "maintenance") {
    const id = randomUUID();
    await query(`INSERT INTO notifications (id, type, title, body) VALUES ($1,'maintenance',$2,$3)`, [id, title, body ?? ""]);
    await recordActivity({
      adminId: req.auth!.sub,
      action: "notification_sent",
      entityType: "notification",
      entityId: id,
      oldValue: null,
      newValue: { type: "maintenance", title, targetType: "broadcast" },
    });
    return sendJson(res, 201, { id, type, title, body, targetType: "broadcast", customerCount: 0, pushed: 0 });
  }

  if (!CUSTOMER_NOTIFICATION_TYPES.includes(type)) {
    return sendJson(res, 400, { error: `type must be one of: ${CUSTOMER_NOTIFICATION_TYPES.join(", ")}, maintenance` });
  }
  const { ids: customers, error } = await resolveTargetCustomerIds(targetType, customerIds, group);
  if (error) return sendJson(res, 400, { error });
  if (customers.length === 0) return sendJson(res, 400, { error: "No matching customers found for this target." });

  // One INSERT per targeted customer, same content each time — a genuine
  // per-customer fan-out, not a single shared row, so read_at means
  // something and each customer's own push actually reaches their device.
  const ids = customers.map(() => randomUUID());
  const COLS = 9;
  const values = customers.map((_, i) => {
    const base = i * COLS;
    const ph = Array.from({ length: COLS }, (_, j) => `$${base + j + 1}`).join(",");
    return `(${ph})`;
  }).join(",");
  const params: unknown[] = [];
  customers.forEach((customerId, i) => {
    params.push(ids[i], type, title, body ?? "", customerId, relatedOrderId ?? null, relatedExchangeOrderId ?? null, req.auth!.sub, targetType);
  });
  await query(
    `INSERT INTO notifications (id, type, title, body, customer_id, related_order_id, related_exchange_order_id, sent_by_admin_id, target_type)
     VALUES ${values}`,
    params
  );

  const tokenRows = await query<{ token: string }>(
    `SELECT DISTINCT token FROM customer_push_tokens WHERE customer_id = ANY($1::uuid[])`,
    [customers]
  );
  const pushResult = await sendPushToTokens(
    tokenRows.map((r) => r.token),
    {
      title,
      body: body ?? "",
      data: {
        type,
        relatedOrderId: relatedOrderId ?? "",
        relatedExchangeOrderId: relatedExchangeOrderId ?? "",
      },
    }
  );

  await recordActivity({
    adminId: req.auth!.sub,
    action: "notification_sent",
    entityType: "notification",
    entityId: ids[0],
    oldValue: null,
    newValue: {
      type,
      title,
      targetType,
      customerCount: customers.length,
      pushConfigured: isPushConfigured(),
      pushAttempted: pushResult.attempted,
      pushSent: pushResult.sent,
    },
  });

  sendJson(res, 201, {
    type,
    title,
    body,
    targetType,
    customerCount: customers.length,
    pushConfigured: isPushConfigured(),
    pushAttempted: pushResult.attempted,
    pushSent: pushResult.sent,
  });
});

// One send action (e.g. "to all customers") becomes one row per targeted
// customer (see POST /admin/notifications/send above) — grouped back down
// to one row per send action here, since that's what an admin actually
// wants to review, not hundreds/thousands of near-duplicate rows for a
// single broadcast. now() is stable within the single multi-row INSERT
// that created them, so every row from the same send shares an identical
// sent_at and is exactly what this GROUP BY collapses on. customer_name/
// customer_phone are only meaningful when customer_count = 1 (a genuinely
// single-target send) — MIN() picks an arbitrary one otherwise, which the
// dashboard only ever reads in the customer_count = 1 case.
notificationsRouter.get("/admin/notifications", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT MIN(n.id) AS id, n.type, n.title, n.body, n.sent_at, n.target_type, n.sent_by_admin_id,
              au.email AS sent_by_admin_email,
              COUNT(*) FILTER (WHERE n.customer_id IS NOT NULL) AS customer_count,
              COUNT(*) FILTER (WHERE n.read_at IS NOT NULL) AS read_count,
              MIN(c.name) AS customer_name, MIN(c.phone) AS customer_phone
       FROM notifications n
       LEFT JOIN customers c ON c.id = n.customer_id
       LEFT JOIN admin_users au ON au.id = n.sent_by_admin_id
       GROUP BY n.type, n.title, n.body, n.sent_at, n.target_type, n.sent_by_admin_id, au.email
       ORDER BY n.sent_at DESC LIMIT 100`
    )
  );
});

notificationsRouter.get("/agent/notifications", requireAuth("agent"), async (_req, res) => {
  // Broadcasts only (customer_id IS NULL) — a row targeted at a specific
  // customer (see POST /admin/notifications/send above) is never this
  // agent's business to see, same rationale GET /notifications below
  // already applies for the reverse direction.
  sendJson(res, 200, await query(`SELECT * FROM notifications WHERE customer_id IS NULL ORDER BY sent_at DESC LIMIT 50`));
});

// A customer sees every broadcast (customer_id IS NULL, unchanged) plus
// anything targeted specifically at them — e.g. a reply to their own
// feedback/suggestion, an order/exchange update, or an admin-composed
// notification. 'maintenance' stays agent/system-only, as before.
notificationsRouter.get("/notifications", requireAuth("customer"), async (req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT id, type, title, body, sent_at, customer_id, read_at, related_order_id, related_exchange_order_id,
              (customer_id IS NULL OR read_at IS NOT NULL) AS read
       FROM notifications
       WHERE type != 'maintenance' AND (customer_id IS NULL OR customer_id = $1)
       ORDER BY sent_at DESC LIMIT 50`,
      [req.auth!.sub]
    )
  );
});

notificationsRouter.get("/notifications/unread-count", requireAuth("customer"), async (req, res) => {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM notifications WHERE customer_id = $1 AND read_at IS NULL`,
    [req.auth!.sub]
  );
  sendJson(res, 200, { count: Number(row?.count ?? 0) });
});

notificationsRouter.put("/notifications/:id/read", requireAuth("customer"), async (req, res) => {
  await query(
    `UPDATE notifications SET read_at = now() WHERE id = $1 AND customer_id = $2 AND read_at IS NULL`,
    [req.params.id, req.auth!.sub]
  );
  sendJson(res, 200, { ok: true });
});

// Device push-token registration — a customer can be signed in on more than
// one phone, and re-registering the same token (reinstall, re-login, an
// FCM-rotated token) just upserts onto the existing row via the token's
// own UNIQUE constraint rather than accumulating duplicates.
notificationsRouter.post("/notifications/push-token", requireAuth("customer"), async (req, res) => {
  const { token, platform } = req.body ?? {};
  if (!token) return sendJson(res, 400, { error: "token is required" });
  const validPlatform = platform === "ios" ? "ios" : "android";
  await query(
    `INSERT INTO customer_push_tokens (id, customer_id, token, platform)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (token) DO UPDATE SET customer_id = $2, platform = $4, updated_at = now()`,
    [randomUUID(), req.auth!.sub, token, validPlatform]
  );
  sendJson(res, 200, { ok: true });
});

notificationsRouter.delete("/notifications/push-token", requireAuth("customer"), async (req, res) => {
  const { token } = req.body ?? {};
  if (!token) return sendJson(res, 400, { error: "token is required" });
  await query(`DELETE FROM customer_push_tokens WHERE token = $1 AND customer_id = $2`, [token, req.auth!.sub]);
  sendJson(res, 200, { ok: true });
});

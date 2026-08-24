import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { notifyCustomer } from "../services/customerNotify.js";

export const notificationsRouter = Router();

const TARGET_TYPES = ["single", "multiple", "all", "recent"] as const;
type TargetType = (typeof TARGET_TYPES)[number];
const SERVICE_FILTERS = ["all", "internet", "ebadal", "reseller"] as const;
type ServiceFilter = (typeof SERVICE_FILTERS)[number];

// Resolves a broadcast's audience to a concrete list of customer ids.
// 'single'/'multiple' both just mean "exactly the given ids" — the only
// difference is how the sending UI picked them, which doesn't matter once
// they arrive here. serviceFilter narrows by whether the customer has ever
// placed an order of that kind; 'reseller' has no backing data model yet
// (Reseller is a "coming soon" placeholder in the customer app — see
// service_choice_screen.dart), so it deliberately matches nobody until a
// real Reseller order type exists, rather than silently matching everyone.
async function resolveCampaignTargets(
  targetType: TargetType,
  customerIds: string[],
  serviceFilter: ServiceFilter
): Promise<string[]> {
  const conditions: string[] = ["status = 'active'"];
  const params: unknown[] = [];

  if (targetType === "single" || targetType === "multiple") {
    params.push(customerIds);
    conditions.push(`id = ANY($${params.length})`);
  } else if (targetType === "recent") {
    conditions.push(`created_at >= now() - interval '7 days'`);
  }

  if (serviceFilter === "internet") {
    conditions.push(`EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = customers.id)`);
  } else if (serviceFilter === "ebadal") {
    conditions.push(`EXISTS (SELECT 1 FROM exchange_orders e WHERE e.customer_id = customers.id)`);
  } else if (serviceFilter === "reseller") {
    conditions.push("false");
  }

  const rows = await query<{ id: string }>(`SELECT id FROM customers WHERE ${conditions.join(" AND ")}`, params);
  return rows.map((r) => r.id);
}

// The one broadcast/campaign endpoint, reachable identically from the Admin
// dashboard and the Agent app (same targeting options, same service
// filter, same title/body fields) — deliberately requireAuth rather than
// requirePermission so there is no capability gap between a regular Admin
// and an Agent here, per spec. Sends a real push to every resolved
// customer's registered device(s) (see push.ts) and records a per-customer
// row so the History view can show exactly who received it.
notificationsRouter.post("/notifications/broadcast", requireAuth("super_admin", "admin", "agent"), async (req, res) => {
  const { targetType, customerIds, serviceFilter, title, body } = req.body;

  if (!TARGET_TYPES.includes(targetType)) {
    return sendJson(res, 400, { error: `targetType must be one of ${TARGET_TYPES.join(", ")}` });
  }
  if (!title || typeof title !== "string" || !body || typeof body !== "string") {
    return sendJson(res, 400, { error: "title and body are required" });
  }
  const svc: ServiceFilter = SERVICE_FILTERS.includes(serviceFilter) ? serviceFilter : "all";
  if ((targetType === "single" || targetType === "multiple") && (!Array.isArray(customerIds) || customerIds.length === 0)) {
    return sendJson(res, 400, { error: "customerIds is required for single/multiple targeting" });
  }

  const recipientIds = await resolveCampaignTargets(targetType, Array.isArray(customerIds) ? customerIds : [], svc);

  const campaignId = randomUUID();
  await query(
    `INSERT INTO notification_campaigns (id, title, body, target_type, service_filter, recipient_count, created_by_id, created_by_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [campaignId, title, body, targetType, svc, recipientIds.length, req.auth!.sub, req.auth!.role]
  );

  let deliveredCount = 0;
  let failedCount = 0;
  for (const customerId of recipientIds) {
    const result = await notifyCustomer(customerId, "campaign", title, body, { screen: "notifications" });
    if (result.delivered) deliveredCount++;
    else failedCount++;
    await query(
      `INSERT INTO notification_campaign_recipients (id, campaign_id, customer_id, status) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), campaignId, customerId, result.delivered ? "delivered" : "failed"]
    );
  }
  await query(`UPDATE notification_campaigns SET sent_count=$1, delivered_count=$2, failed_count=$3 WHERE id=$4`, [
    recipientIds.length,
    deliveredCount,
    failedCount,
    campaignId,
  ]);

  sendJson(res, 201, {
    id: campaignId,
    recipientCount: recipientIds.length,
    sentCount: recipientIds.length,
    deliveredCount,
    failedCount,
  });
});

// History — every past broadcast with its counts, newest first, identical
// for Admin and Agent (same route, same data). createdByName resolves from
// whichever of admin_users/agents actually holds that id, based on the
// role recorded at send time.
notificationsRouter.get("/notifications/campaigns", requireAuth("super_admin", "admin", "agent"), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT c.*,
         CASE c.created_by_role
           WHEN 'agent' THEN (SELECT name FROM agents WHERE id = c.created_by_id)
           ELSE (SELECT email FROM admin_users WHERE id = c.created_by_id)
         END AS created_by_name
       FROM notification_campaigns c
       ORDER BY c.created_at DESC
       LIMIT 100`
    )
  );
});

// Called once on login/app-start with the device's current FCM token, and
// again whenever Firebase rotates it (onTokenRefresh) — ON CONFLICT moves
// the row to whichever customer most recently registered that token,
// correctly handling both a token refresh (same customer, new token value)
// and a shared/reused device (a different customer logging in later).
notificationsRouter.post("/notifications/register-device", requireAuth("customer"), async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken || typeof fcmToken !== "string") {
    return sendJson(res, 400, { error: "fcmToken is required" });
  }
  await query(
    `INSERT INTO customer_device_tokens (id, customer_id, fcm_token, last_seen_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (fcm_token) DO UPDATE SET customer_id=$2, last_seen_at=now()`,
    [randomUUID(), req.auth!.sub, fcmToken]
  );
  sendJson(res, 200, { ok: true });
});

// Called on logout so a shared/reset device stops receiving this
// customer's pushes — not required for correctness (a stale token just
// gets pruned the next time a send to it fails), but avoids a real window
// where the previous customer's pushes would land after a shared device
// switches accounts.
notificationsRouter.post("/notifications/unregister-device", requireAuth("customer"), async (req, res) => {
  const { fcmToken } = req.body;
  if (fcmToken) {
    await query(`DELETE FROM customer_device_tokens WHERE fcm_token=$1 AND customer_id=$2`, [fcmToken, req.auth!.sub]);
  }
  sendJson(res, 200, { ok: true });
});

// Called once on login/app-start with the device's current FCM token, and
// again on token refresh — same upsert pattern as the customer route above,
// scoped to the agents table (native Agent App logins only; Admin Dashboard
// staff use the browser and never call this). Registered here so an assigned
// support conversation can push straight to the agent's phone even while the
// app is backgrounded/minimized/screen-locked — see support.routes.ts's
// notifyAssignedAgent() and push.ts's sendPushToAgent().
notificationsRouter.post("/agent/notifications/register-device", requireAuth("agent"), async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken || typeof fcmToken !== "string") {
    return sendJson(res, 400, { error: "fcmToken is required" });
  }
  await query(
    `INSERT INTO agent_device_tokens (id, agent_id, fcm_token, last_seen_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (fcm_token) DO UPDATE SET agent_id=$2, last_seen_at=now()`,
    [randomUUID(), req.auth!.sub, fcmToken]
  );
  sendJson(res, 200, { ok: true });
});

notificationsRouter.post("/agent/notifications/unregister-device", requireAuth("agent"), async (req, res) => {
  const { fcmToken } = req.body;
  if (fcmToken) {
    await query(`DELETE FROM agent_device_tokens WHERE fcm_token=$1 AND agent_id=$2`, [fcmToken, req.auth!.sub]);
  }
  sendJson(res, 200, { ok: true });
});

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

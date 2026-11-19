import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
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

// ---------------- Sending: now, or at a set time ----------------

/** Up to this many recipients are sent before answering (the answer has the final counts, as before). */
const SEND_INLINE_MAX = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function campaignJson(row: any) {
  return {
    id: row.id,
    status: row.status,
    scheduledAt: row.scheduled_at ?? null,
    repeat: row.repeat ?? "none",
    recipientCount: row.recipient_count,
    sentCount: row.sent_count,
    deliveredCount: row.delivered_count,
    failedCount: row.failed_count,
  };
}

async function findCampaignByRequestId(createdById: string, requestId: string) {
  const row = await queryOne(`SELECT * FROM notification_campaigns WHERE created_by_id=$1 AND request_id=$2`, [createdById, requestId]);
  return row ? campaignJson(row) : null;
}

/** Counts from the recipient rows; `finished` marks the campaign sent. Also the "still alive" mark. */
async function refreshCampaignCounts(campaignId: string, finished: boolean) {
  await query(
    `UPDATE notification_campaigns c
        SET sent_count = s.total, delivered_count = s.delivered, failed_count = s.failed, claimed_at = now()
            ${finished ? ", status = 'sent', sent_at = now()" : ""}
       FROM (SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
                    count(*) FILTER (WHERE status <> 'delivered')::int AS failed
               FROM notification_campaign_recipients WHERE campaign_id = $1) s
      WHERE c.id = $1`,
    [campaignId]
  );
}

/**
 * Sends a campaign that is in 'sending': resolves its audience now, skips
 * everyone already notified (so an interrupted send resumes without
 * notifying anyone twice), and keeps the counts up to date as it goes.
 */
export async function sendCampaign(campaignId: string): Promise<void> {
  const c = await queryOne<{ id: string; title: string; body: string; target_type: TargetType; service_filter: ServiceFilter; customer_ids: string[] | null }>(
    `SELECT id, title, body, target_type, service_filter, customer_ids FROM notification_campaigns WHERE id=$1 AND status='sending'`,
    [campaignId]
  );
  if (!c) return;
  const recipients = await resolveCampaignTargets(c.target_type, c.customer_ids ?? [], c.service_filter);
  await query(`UPDATE notification_campaigns SET recipient_count=$2, claimed_at=now() WHERE id=$1`, [campaignId, recipients.length]);
  const done = new Set(
    (await query<{ customer_id: string }>(`SELECT customer_id FROM notification_campaign_recipients WHERE campaign_id=$1`, [campaignId])).map((r) => r.customer_id)
  );
  let n = 0;
  for (const customerId of recipients) {
    if (done.has(customerId)) continue;
    const result = await notifyCustomer(customerId, "campaign", c.title, c.body, { screen: "notifications" });
    await query(
      `INSERT INTO notification_campaign_recipients (id, campaign_id, customer_id, status) VALUES ($1,$2,$3,$4)
       ON CONFLICT (campaign_id, customer_id) DO NOTHING`,
      [randomUUID(), campaignId, customerId, result.delivered ? "delivered" : "failed"]
    );
    if (++n % 10 === 0) await refreshCampaignCounts(campaignId, false);
  }
  await refreshCampaignCounts(campaignId, true);
  await scheduleNextDaily(campaignId);
}

/**
 * A daily message: once today's copy is sent, tomorrow's is scheduled at
 * the same time (days the server was down are skipped, never sent late in
 * a burst). Cancelling the waiting copy stops the series.
 */
async function scheduleNextDaily(campaignId: string): Promise<void> {
  await query(
    `INSERT INTO notification_campaigns
       (id, title, body, target_type, service_filter, recipient_count, created_by_id, created_by_role, status, scheduled_at, customer_ids, repeat, series_id)
     SELECT $2, title, body, target_type, service_filter, recipient_count, created_by_id, created_by_role, 'scheduled',
            scheduled_at + (GREATEST(1, CEIL(EXTRACT(EPOCH FROM (now() - scheduled_at)) / 86400.0))::int * interval '1 day'),
            customer_ids, 'daily', COALESCE(series_id, id)
       FROM notification_campaigns c
      WHERE c.id = $1 AND c.repeat = 'daily' AND c.scheduled_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM notification_campaigns n
                         WHERE n.series_id = COALESCE(c.series_id, c.id) AND n.status = 'scheduled')`,
    [campaignId, randomUUID()]
  );
}

let sendingDue = false;
/**
 * Sends what is due: scheduled campaigns whose time has come, and sends a
 * restart interrupted (no progress for 10 minutes). Returns how many.
 */
export async function runDueCampaigns(): Promise<number> {
  if (sendingDue) return 0;
  sendingDue = true;
  try {
    const due = await query<{ id: string }>(
      `UPDATE notification_campaigns SET status = 'sending', claimed_at = now()
        WHERE id IN (SELECT id FROM notification_campaigns
                      WHERE (status = 'scheduled' AND scheduled_at <= now())
                         OR (status = 'sending' AND claimed_at < now() - interval '10 minutes')
                      ORDER BY coalesce(scheduled_at, created_at) LIMIT 5
                      FOR UPDATE SKIP LOCKED)
        RETURNING id`
    );
    for (const d of due) {
      await sendCampaign(d.id).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("Scheduled notification failed (will retry):", (err as Error).message);
      });
    }
    return due.length;
  } finally {
    sendingDue = false;
  }
}

/** Checks for due messages every 30 seconds (started once by server.ts). */
export function startCampaignScheduler(): void {
  const timer = setInterval(() => {
    runDueCampaigns().catch(() => undefined);
  }, 30_000);
  (timer as unknown as { unref?: () => void }).unref?.();
}

// The one broadcast/campaign endpoint, reachable identically from the Admin
// dashboard and the Agent app. Without scheduledAt it sends now: a small
// audience before answering (with the final counts), a large one in the
// background (the answer comes at once, status 'sending'; the history
// shows the counts as they fill in). With scheduledAt (1 minute to 90
// days ahead) it is kept as 'scheduled' and sent then by the scheduler.
// One "Send" tap = one campaign: a repeat of the same requestId returns
// the original.
notificationsRouter.post("/notifications/broadcast", requireAuth("super_admin", "admin", "agent"), async (req, res) => {
  const { targetType, customerIds, serviceFilter, title, body } = req.body;

  if (!TARGET_TYPES.includes(targetType)) {
    return sendJson(res, 400, { error: `targetType must be one of ${TARGET_TYPES.join(", ")}` });
  }
  if (!title || typeof title !== "string" || !body || typeof body !== "string") {
    return sendJson(res, 400, { error: "title and body are required" });
  }
  const svc: ServiceFilter = SERVICE_FILTERS.includes(serviceFilter) ? serviceFilter : "all";
  const ids = targetType === "single" || targetType === "multiple" ? (Array.isArray(customerIds) ? customerIds.map(String).filter((x: string) => UUID_RE.test(x)) : []) : [];
  if ((targetType === "single" || targetType === "multiple") && ids.length === 0) {
    return sendJson(res, 400, { error: "customerIds is required for single/multiple targeting" });
  }
  let scheduledAt: Date | null = null;
  if (req.body.scheduledAt != null && req.body.scheduledAt !== "") {
    const d = new Date(String(req.body.scheduledAt));
    if (Number.isNaN(d.getTime())) return sendJson(res, 400, { error: "scheduledAt must be a date and time.", code: "invalid_schedule" });
    if (d.getTime() < Date.now() + 60_000) return sendJson(res, 400, { error: "Choose a time at least 1 minute from now.", code: "schedule_in_past" });
    if (d.getTime() > Date.now() + 90 * 24 * 3600_000) return sendJson(res, 400, { error: "Choose a time within the next 90 days.", code: "schedule_too_far" });
    scheduledAt = d;
  }
  // "daily": sent at the chosen time every day until cancelled.
  const repeat = req.body.repeat === "daily" ? "daily" : "none";
  if (repeat === "daily" && !scheduledAt) {
    return sendJson(res, 400, { error: "Choose the time of day for a daily message.", code: "repeat_needs_time" });
  }
  const requestId = typeof req.body.requestId === "string" && req.body.requestId.trim() ? req.body.requestId.trim().slice(0, 100) : null;
  if (requestId) {
    const existing = await findCampaignByRequestId(req.auth!.sub, requestId);
    if (existing) return sendJson(res, 200, existing);
  }

  const recipientIds = await resolveCampaignTargets(targetType, ids, svc);
  const campaignId = randomUUID();
  const inserted = await query(
    `INSERT INTO notification_campaigns
       (id, title, body, target_type, service_filter, recipient_count, created_by_id, created_by_role, request_id, status, scheduled_at, customer_ids, claimed_at, repeat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (created_by_id, request_id) WHERE request_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      campaignId, title, body, targetType, svc, recipientIds.length, req.auth!.sub, req.auth!.role, requestId,
      scheduledAt ? "scheduled" : "sending", scheduledAt, ids.length ? ids : null, scheduledAt ? null : new Date(), repeat,
    ]
  );
  if (inserted.length === 0 && requestId) {
    // Lost a race with a concurrent copy of the same request.
    const existing = await findCampaignByRequestId(req.auth!.sub, requestId);
    if (existing) return sendJson(res, 200, existing);
  }
  if (scheduledAt) return sendJson(res, 201, campaignJson(inserted[0]));
  if (recipientIds.length <= SEND_INLINE_MAX) {
    await sendCampaign(campaignId);
    return sendJson(res, 201, campaignJson(await queryOne(`SELECT * FROM notification_campaigns WHERE id=$1`, [campaignId])));
  }
  sendJson(res, 201, campaignJson(inserted[0]));
  void sendCampaign(campaignId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Broadcast send failed (the scheduler resumes it):", (err as Error).message);
  });
});

/** A scheduled message can be cancelled until it goes out (an agent: only their own). */
notificationsRouter.post("/notifications/campaigns/:id/cancel", requireAuth("super_admin", "admin", "agent"), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Message not found" });
  const own = req.auth!.role === "agent";
  const row = await queryOne(
    `UPDATE notification_campaigns SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1 AND status = 'scheduled' ${own ? "AND created_by_id = $2" : ""}
      RETURNING *`,
    own ? [req.params.id, req.auth!.sub] : [req.params.id]
  );
  if (!row) return sendJson(res, 409, { error: "Only a scheduled message that hasn't been sent yet can be cancelled.", code: "not_cancellable" });
  sendJson(res, 200, campaignJson(row));
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

// The agent's inbox: notices sent to everyone (Admin → Notifications →
// Send; customer_id IS NULL). Each customer's own copy of a broadcast, order
// update or feedback reply (notifyCustomer writes one row per customer) is
// that customer's, not the agent's -- listing them showed one broadcast
// once per recipient (same text and time) and leaked customers' private
// updates into the Agent App.
notificationsRouter.get("/agent/notifications", requireAuth("agent"), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT id, type, title, body, sent_at FROM notifications
       WHERE customer_id IS NULL
       ORDER BY sent_at DESC, id LIMIT 50`
    )
  );
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

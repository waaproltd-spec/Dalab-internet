import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { sendPushToTokens } from "../services/push.js";

/**
 * Agent App "today" figures and admin-controlled Maintenance Notices.
 * Read-only on orders/commissions: nothing here changes payment logic or
 * order processing. The same file is used by DALAB, Danwadaag, Fududeeye
 * and Sahal.
 *
 * "Today" is Somalia's today: db/pool.ts pins every connection to
 * Africa/Mogadishu, so date_trunc('day', now()) is Mogadishu midnight --
 * the same rule as the admin dashboard's Daily Sales.
 */
export const agentDailyRouter = Router();

const TODAY = `date_trunc('day', now())`;
// One rule for every bucket, so Completed + Pending + Failed + Cancelled = Created.
const COMPLETED = `o.status = 'completed' AND o.reversed_at IS NULL`;
const FAILED = `o.status = 'failed' AND o.reversed_at IS NULL`;
const CANCELLED = `(o.status IN ('cancelled', 'expired') OR o.reversed_at IS NOT NULL)`;
const PENDING = `o.status NOT IN ('completed', 'failed', 'cancelled', 'expired') AND o.reversed_at IS NULL`;
// Orders this agent took part in: created by them, or dialed by them.
const MINE = `(o.agent_id = $1 OR EXISTS (SELECT 1 FROM ussd_dial_attempts a WHERE a.order_id = o.id AND a.agent_id = $1))`;

type Bucket = { created: string; completed: string; pending: string; failed: string; cancelled: string; volume: string };

const BUCKETS = `
  COUNT(*) AS created,
  COUNT(*) FILTER (WHERE ${COMPLETED}) AS completed,
  COUNT(*) FILTER (WHERE ${PENDING}) AS pending,
  COUNT(*) FILTER (WHERE ${FAILED}) AS failed,
  COUNT(*) FILTER (WHERE ${CANCELLED}) AS cancelled,
  COALESCE(SUM(o.amount) FILTER (WHERE ${COMPLETED}), 0) AS volume`;

const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const counts = (b: Bucket | null) => ({
  created: Number(b?.created ?? 0),
  completed: Number(b?.completed ?? 0),
  pending: Number(b?.pending ?? 0),
  failed: Number(b?.failed ?? 0),
  cancelled: Number(b?.cancelled ?? 0),
});

/** Everything the Agent App's "Today" section shows, from real rows only. */
export async function agentToday(agentId: string) {
  const all = await queryOne<Bucket>(`SELECT ${BUCKETS} FROM orders o WHERE o.created_at >= ${TODAY}`);
  const mine = await queryOne<Bucket>(`SELECT ${BUCKETS} FROM orders o WHERE o.created_at >= ${TODAY} AND ${MINE}`, [agentId]);
  // Commission records from Commission Management (earned minus reversed;
  // a reversal is stored as a negative amount), for today's orders.
  const commission = await queryOne<{ all_total: string; mine_total: string }>(
    `SELECT COALESCE(SUM(cr.commission_amount), 0) AS all_total,
            COALESCE(SUM(cr.commission_amount) FILTER (WHERE ${MINE}), 0) AS mine_total
       FROM commission_records cr JOIN orders o ON o.id = cr.order_id
      WHERE o.created_at >= ${TODAY}`,
    [agentId]
  );
  const attempts = await queryOne<{ total: string; success: string; failed: string; pending: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'success') AS success,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending
       FROM ussd_dial_attempts WHERE agent_id = $1 AND created_at >= ${TODAY}`,
    [agentId]
  );
  const day = await queryOne<{ day: string }>(`SELECT to_char(${TODAY}, 'YYYY-MM-DD') AS day`);
  return {
    date: day!.day,
    timezone: "Africa/Mogadishu",
    orders_today: counts(all),
    my_performance: {
      ...counts(mine),
      dial_attempts: Number(attempts?.total ?? 0),
      dial_success: Number(attempts?.success ?? 0),
      dial_failed: Number(attempts?.failed ?? 0),
      dial_pending: Number(attempts?.pending ?? 0),
    },
    revenue_today: {
      completed_volume: money(all?.volume),
      commission: money(commission?.all_total),
      my_completed_volume: money(mine?.volume),
      my_commission: money(commission?.mine_total),
    },
    generated_at: new Date().toISOString(),
  };
}

agentDailyRouter.get("/agent/today", requireAuth("agent"), async (req, res) => {
  sendJson(res, 200, await agentToday(req.auth!.sub));
});

// ---------------------------------------------------------------- notices

type NoticeRow = {
  id: string;
  title: string;
  message: string;
  kind: string;
  starts_at: Date | null;
  ends_at: Date | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

const KINDS = ["maintenance", "info", "warning"] as const;

/** Where a notice is in its life: scheduled (starts later), active, ended or off. */
export function noticePhase(n: Pick<NoticeRow, "starts_at" | "ends_at" | "enabled">, now = new Date()): "scheduled" | "active" | "ended" | "disabled" {
  if (!n.enabled) return "disabled";
  if (n.ends_at && new Date(n.ends_at) <= now) return "ended";
  if (n.starts_at && new Date(n.starts_at) > now) return "scheduled";
  return "active";
}

const withPhase = (n: NoticeRow) => ({ ...n, phase: noticePhase(n) });

function parseDate(v: unknown): Date | null | "invalid" {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

/** Validates an admin's notice body. Returns the clean fields or an error. */
export function validateNotice(body: any): { error: string } | { title: string; message: string; kind: string; starts_at: Date | null; ends_at: Date | null; enabled: boolean } {
  const title = String(body?.title ?? "").trim();
  const message = String(body?.message ?? "").trim();
  const kind = String(body?.kind ?? "maintenance");
  if (!title || title.length > 120) return { error: "Title is required (up to 120 characters)." };
  if (!message || message.length > 1000) return { error: "Message is required (up to 1000 characters)." };
  if (!(KINDS as readonly string[]).includes(kind)) return { error: "Type must be maintenance, info or warning." };
  const starts = parseDate(body?.startsAt ?? body?.starts_at);
  const ends = parseDate(body?.endsAt ?? body?.ends_at);
  if (starts === "invalid" || ends === "invalid") return { error: "Start and end must be valid dates." };
  if (starts && ends && ends <= starts) return { error: "The end time must be after the start time." };
  return { title, message, kind, starts_at: starts, ends_at: ends, enabled: body?.enabled === undefined ? true : Boolean(body.enabled) };
}

/** Tells every agent phone about a new or changed notice (best effort). */
async function pushNotice(n: NoticeRow): Promise<void> {
  try {
    const rows = await query<{ fcm_token: string }>(`SELECT fcm_token FROM agent_device_tokens`);
    if (rows.length === 0) return;
    const result = await sendPushToTokens(rows.map((r) => r.fcm_token), {
      title: n.title,
      body: n.message.length > 180 ? `${n.message.slice(0, 177)}...` : n.message,
      data: { type: "agent_notice", noticeId: n.id, kind: n.kind },
    }, "agent");
    if (result.invalidTokens.length > 0) {
      await query(`DELETE FROM agent_device_tokens WHERE fcm_token = ANY($1)`, [result.invalidTokens]);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("agent notice push failed:", (err as Error).message);
  }
}

// Agents: every enabled notice that hasn't ended -- active ones first, then
// upcoming scheduled maintenance by start time.
agentDailyRouter.get("/agent/notices", requireAuth("agent"), async (_req, res) => {
  const rows = await query<NoticeRow>(
    `SELECT id, title, message, kind, starts_at, ends_at, enabled, created_at, updated_at
       FROM agent_notices
      WHERE enabled = true AND (ends_at IS NULL OR ends_at > now())
      ORDER BY (starts_at IS NOT NULL AND starts_at > now()), COALESCE(starts_at, created_at)`
  );
  sendJson(res, 200, rows.map(withPhase));
});

agentDailyRouter.get("/admin/agent-notices", requireStaff(), async (_req, res) => {
  const rows = await query<NoticeRow>(
    `SELECT id, title, message, kind, starts_at, ends_at, enabled, created_at, updated_at
       FROM agent_notices ORDER BY created_at DESC LIMIT 200`
  );
  sendJson(res, 200, rows.map(withPhase));
});

agentDailyRouter.post("/admin/agent-notices", requirePermission("agents.manage"), async (req, res) => {
  const v = validateNotice(req.body);
  if ("error" in v) return sendJson(res, 400, { error: v.error });
  const row = await queryOne<NoticeRow>(
    `INSERT INTO agent_notices (title, message, kind, starts_at, ends_at, enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, title, message, kind, starts_at, ends_at, enabled, created_at, updated_at`,
    [v.title, v.message, v.kind, v.starts_at, v.ends_at, v.enabled, req.auth!.sub]
  );
  if (row!.enabled && noticePhase(row!) !== "ended") await pushNotice(row!);
  sendJson(res, 201, withPhase(row!));
});

agentDailyRouter.put("/admin/agent-notices/:id", requirePermission("agents.manage"), async (req, res) => {
  const v = validateNotice(req.body);
  if ("error" in v) return sendJson(res, 400, { error: v.error });
  const row = await queryOne<NoticeRow>(
    `UPDATE agent_notices SET title=$2, message=$3, kind=$4, starts_at=$5, ends_at=$6, enabled=$7, updated_at=now()
      WHERE id=$1
      RETURNING id, title, message, kind, starts_at, ends_at, enabled, created_at, updated_at`,
    [req.params.id, v.title, v.message, v.kind, v.starts_at, v.ends_at, v.enabled]
  );
  if (!row) return sendJson(res, 404, { error: "Notice not found" });
  sendJson(res, 200, withPhase(row));
});

agentDailyRouter.delete("/admin/agent-notices/:id", requirePermission("agents.manage"), async (req, res) => {
  const row = await queryOne<{ id: string }>(`DELETE FROM agent_notices WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!row) return sendJson(res, 404, { error: "Notice not found" });
  sendJson(res, 200, { ok: true });
});

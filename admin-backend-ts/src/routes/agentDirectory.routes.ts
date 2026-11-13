import { Router, Request, Response, NextFunction } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { verifyToken } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * "Other Agents" for the AGENT APP: every other active agent of THIS system
 * with their ONLINE / OFFLINE status.
 *
 * Isolation: each system has its own database and its own token secret, so
 * this list can only ever contain this system's agents, and only a valid
 * agent token of this system can read it (requireAuth("agent")).
 *
 * Online status reuses what every Agent App already does: its live order
 * connection (GET /agent/orders/stream, kept open by the background
 * service) and its ~60s device heartbeat. Any authenticated agent request
 * records agents.last_seen_at (at most every PRESENCE_WRITE_MS per agent),
 * and the open live connection refreshes it every minute. An agent seen
 * within ONLINE_WINDOW_SECONDS is ONLINE. No new table or service.
 *
 * Work phone numbers are shown only while the system setting
 * agent_directory_show_phone is not "false" (admins switch it in the
 * dashboard); when it's off the numbers are never sent and can't be
 * searched.
 */
export const agentDirectoryRouter = Router();

export const ONLINE_WINDOW_SECONDS = 180;
export const PHONE_SETTING_KEY = "agent_directory_show_phone";
let presenceWriteMs = 30_000;
const lastWrite = new Map<string, number>();

/** Test hook: write every touch (no throttle). */
export function setPresenceThrottleForTest(ms: number): void {
  presenceWriteMs = ms;
  lastWrite.clear();
}

/** Records that this agent is connected now. Never throws. */
export async function touchAgentPresence(agentId: string): Promise<void> {
  const now = Date.now();
  const last = lastWrite.get(agentId) ?? 0;
  if (now - last < presenceWriteMs) return;
  lastWrite.set(agentId, now);
  try {
    await query(`UPDATE agents SET last_seen_at = now() WHERE id = $1`, [agentId]);
  } catch (err) {
    lastWrite.delete(agentId);
    // eslint-disable-next-line no-console
    console.error("agent presence update failed:", (err as Error).message);
  }
}

/** App-level: any request with a valid agent token marks that agent seen.
 * Runs after the device-activation check, so a refused install doesn't count. */
export function agentPresenceMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    const payload = verifyToken(header.slice(7));
    if (payload && payload.role === "agent") void touchAgentPresence(payload.sub);
  }
  next();
}

export async function phoneVisible(): Promise<boolean> {
  const row = await queryOne<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [PHONE_SETTING_KEY]);
  return (row?.value ?? "true").trim().toLowerCase() !== "false";
}

/** Phone digits only, for matching "61 234", "+25261234..." etc. */
const digits = (s: string) => s.replace(/\D/g, "");

agentDirectoryRouter.get("/agent/agents", requireAuth("agent"), async (req, res) => {
  const me = req.auth!.sub;
  const showPhone = await phoneVisible();
  const search = String(req.query.search ?? "").trim().slice(0, 60);

  const params: unknown[] = [me, ONLINE_WINDOW_SECONDS];
  let filter = "";
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const nameCond = `a.name ILIKE $${params.length}`;
    const d = digits(search);
    if (showPhone && d.length >= 3) {
      params.push(`%${d}%`);
      filter = `AND (${nameCond} OR regexp_replace(a.phone, '\\D', '', 'g') LIKE $${params.length})`;
    } else {
      filter = `AND ${nameCond}`;
    }
  }

  const rows = await query<{ id: string; name: string; phone: string; last_seen_at: Date | null; online: boolean }>(
    `SELECT a.id, a.name, a.phone, a.last_seen_at,
            (a.last_seen_at IS NOT NULL AND a.last_seen_at > now() - ($2 || ' seconds')::interval) AS online
       FROM agents a
      WHERE a.id <> $1 AND a.status = 'active' ${filter}
      ORDER BY online DESC, lower(a.name), a.id
      LIMIT 500`,
    params
  );
  sendJson(res, 200, {
    agents: rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: showPhone ? r.phone : null,
      online: r.online,
      status: r.online ? "ONLINE" : "OFFLINE",
      last_seen_at: r.last_seen_at,
    })),
    phone_visible: showPhone,
    online_window_seconds: ONLINE_WINDOW_SECONDS,
    online_count: rows.filter((r) => r.online).length,
    server_time: new Date().toISOString(),
  });
});

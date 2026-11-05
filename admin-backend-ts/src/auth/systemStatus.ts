import type { NextFunction, Request, Response } from "express";
import { queryOne } from "../db/pool.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * System Control from the Admin Hub: while the Platform Owner has this
 * system suspended, every API request -- customer app, agent app and admin
 * dashboard alike -- is refused with one clear message. Nothing is deleted or
 * changed; re-enabling lets everything through again. Only the hub's own
 * (signed) endpoints and /health stay open, so the hub can always switch
 * the system back on.
 */
export const SUSPENDED_MESSAGE = "System temporarily suspended. Please contact support.";

let cached = { suspended: false, at: 0 };
const TTL_MS = 3000; // other processes of this API pick a change up within seconds

export async function systemSuspended(): Promise<boolean> {
  if (Date.now() - cached.at < TTL_MS) return cached.suspended;
  try {
    const row = await queryOne<{ suspended: boolean }>(`SELECT suspended FROM hub_system_state WHERE id=1`);
    cached = { suspended: row?.suspended === true, at: Date.now() };
  } catch {
    // Table not there yet (migration not applied) or a DB hiccup: keep the
    // last known state rather than taking the system down.
    cached = { ...cached, at: Date.now() };
  }
  return cached.suspended;
}

export function rememberSystemState(suspended: boolean): void {
  cached = { suspended, at: Date.now() };
}

export async function systemSuspensionMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.method === "OPTIONS" || req.path === "/health" || req.path.startsWith("/admin/hub/")) return next();
  if (!(await systemSuspended())) return next();
  res.setHeader("Retry-After", "300");
  return sendJson(res, 503, { error: SUSPENDED_MESSAGE, code: "SYSTEM_SUSPENDED" });
}

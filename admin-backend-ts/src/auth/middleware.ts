import { Request, Response, NextFunction } from "express";
import { verifyToken } from "./crypto.js";
import { queryOne } from "../db/pool.js";
import { Role } from "../types/index.js";

/**
 * An agent's access is tied to a specific physical device (agents.device_id
 * -> agent_devices.enabled) that an admin can disable at any time from the
 * dashboard's existing Devices panel. Checked live against the database on
 * every agent-authenticated request — not trusted from the JWT — so a
 * revoked device is locked out immediately (the very next request) instead
 * of continuing to work for up to its access token's remaining 15-minute
 * life. Mirrors requirePermission's same "trust the DB, not the token"
 * pattern for admin permission checks.
 */
export async function agentDeviceIsActive(agentId: string): Promise<boolean> {
  const row = await queryOne<{ status: string; enabled: boolean | null }>(
    `SELECT a.status, ad.enabled FROM agents a LEFT JOIN agent_devices ad ON ad.id = a.device_id WHERE a.id=$1`,
    [agentId]
  );
  return !!row && row.status === "active" && !!row.enabled;
}

/**
 * Reads `Authorization: Bearer <token>`, verifies it, and — if roles are
 * given — checks the token's role claim against them. Attaches `req.auth`
 * on success. This is the single enforcement point for every protected
 * route; a customer token can never reach an admin/agent-only route
 * regardless of how the request is otherwise well-formed. For an agent
 * token specifically, also re-verifies the device is still active (see
 * agentDeviceIsActive above) before letting the request through.
 */
export function requireAuth(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }

    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    if (roles.length > 0 && !roles.includes(payload.role)) {
      res.status(403).json({ error: `Role '${payload.role}' cannot access this route` });
      return;
    }

    req.auth = payload;

    if (payload.role === "agent") {
      agentDeviceIsActive(payload.sub)
        .then((active) => {
          if (!active) {
            res.status(403).json({ error: "Your device access has been disabled. Contact your administrator.", code: "DEVICE_DISABLED" });
            return;
          }
          next();
        })
        .catch(() => {
          // A security gate should fail closed on an unexpected error, not open.
          res.status(503).json({ error: "Could not verify device access. Please try again." });
        });
      return;
    }

    next();
  };
}

/** super_admin and admin both count as "staff" for routes either may use. */
export const requireStaff = () => requireAuth("super_admin", "admin");

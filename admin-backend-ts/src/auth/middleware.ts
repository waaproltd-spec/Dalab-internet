import { Request, Response, NextFunction } from "express";
import { verifyToken } from "./crypto.js";
import { Role } from "../types/index.js";
import { queryOne } from "../db/pool.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * Reads `Authorization: Bearer <token>`, verifies it, and — if roles are
 * given — checks the token's role claim against them. Attaches `req.auth`
 * on success. This is the single enforcement point for every protected
 * route; a customer token can never reach an admin/agent-only route
 * regardless of how the request is otherwise well-formed.
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
    next();
  };
}

/** super_admin and admin both count as "staff" for routes either may use. */
export const requireStaff = () => requireAuth("super_admin", "admin");

/**
 * Suspended-account enforcement (Customer App): a suspended customer
 * (customers.status='blocked') keeps a valid session — login itself never
 * rejects them (see /auth/login, /auth/register, /auth/identify) — but
 * every protected endpoint they call must reject them except Agent Support
 * (/support/...), so they can still reach a human to get unblocked, and
 * GET /customer/status, which is how the Customer App itself detects and
 * clears this state (see that route's own comment). Registered globally in
 * server.ts, ahead of every router, rather than threaded into each
 * individual customer route: this is the one place that can't be forgotten
 * when a new customer-facing route is added later, satisfying "every
 * protected API must reject requests from suspended customers" for the
 * whole surface at once, not just what exists today. Cheap: only runs the
 * extra query for requests actually carrying a customer-role token, and
 * reuses the exact JWT verification requireAuth() itself uses, so a
 * request that wouldn't authenticate anyway is unaffected.
 */
export async function customerSuspensionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  const payload = verifyToken(token);
  if (!payload || payload.role !== "customer") return next();
  if (req.path.startsWith("/support") || req.path === "/customer/status") return next();

  const customer = await queryOne<{ status: string }>(`SELECT status FROM customers WHERE id=$1`, [payload.sub]);
  if (customer?.status === "blocked") {
    sendJson(res, 403, {
      error: "Your account has been suspended. Contact Agent Support to resolve this.",
      code: "ACCOUNT_SUSPENDED",
    });
    return;
  }
  next();
}

import { Request, Response, NextFunction } from "express";
import { verifyToken } from "./crypto.js";
import { Role } from "../types/index.js";

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

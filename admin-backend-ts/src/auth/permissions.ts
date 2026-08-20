import { Request, Response, NextFunction } from "express";
import { queryOne } from "../db/pool.js";
import { requireAuth } from "./middleware.js";

/**
 * Coarse, per-feature-area permission keys a Super Admin can grant to a
 * regular Admin. Deliberately one flag per admin dashboard section rather
 * than one per CRUD verb — practical to toggle, and matches how the product
 * spec groups capabilities (e.g. "companies.manage" covers create/edit/
 * enable-disable/delete/visibility for companies).
 */
export const PERMISSIONS = [
  "companies.manage",
  "categories.manage",
  "packages.manage",
  "agents.manage",
  "customers.manage",
  "orders.manage",
  "orders.reverse",
  "devices.manage",
  "settings.manage",
  "reports.export",
  "commissions.manage",
  "feedback.manage",
  "referrals.manage",
  "finance.manage",
  "exchange.manage",
  "resellers.manage",
  "support.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Gate for mutating (POST/PUT/DELETE) staff routes. super_admin always
 * passes without a DB lookup — it is the unrestricted, highest-level role
 * the spec asks for. An admin passes only if `key` is in their stored
 * `permissions` array, checked live against the database (not the JWT) so a
 * permission change from the Super Admin takes effect immediately, without
 * waiting for the admin's token to expire or them to re-login.
 */
export function requirePermission(key: Permission) {
  const staffAuth = requireAuth("super_admin", "admin");
  return (req: Request, res: Response, next: NextFunction): void => {
    staffAuth(req, res, async () => {
      if (req.auth!.role === "super_admin") return next();

      const admin = await queryOne<{ permissions: string[] }>(
        `SELECT permissions FROM admin_users WHERE id=$1`,
        [req.auth!.sub]
      );
      if (admin?.permissions?.includes(key)) return next();

      res.status(403).json({ error: `Missing the '${key}' permission — ask a Super Admin to grant it.` });
    });
  };
}

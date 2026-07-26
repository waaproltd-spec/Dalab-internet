import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { PERMISSIONS, isPermission } from "../auth/permissions.js";
import { hashPassword, isValidEmail, isStrongPassword } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";

export const usersRouter = Router();

// Only a Super Admin can create/manage other staff accounts — an Admin
// cannot promote themselves or create new Admins. This is the actual RBAC
// boundary between the two roles the spec asks for.
usersRouter.get("/admin/users", requireAuth("super_admin"), async (_req, res) => {
  const rows = await query(`SELECT id, email, role, last_login_at, created_at FROM admin_users ORDER BY created_at DESC`);
  sendJson(res, 200, rows);
});

usersRouter.post("/admin/users", requireAuth("super_admin"), async (req, res) => {
  const { email, password, role } = req.body;
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) return sendJson(res, 400, { error: "A valid email is required" });
  if (!isStrongPassword(String(password ?? ""))) {
    return sendJson(res, 400, { error: "Password must be at least 8 characters and include a letter, a number, and a symbol" });
  }
  if (!["admin", "super_admin"].includes(role)) return sendJson(res, 400, { error: "role must be 'admin' or 'super_admin'" });

  const existing = await queryOne(`SELECT id FROM admin_users WHERE email=$1`, [normalizedEmail]);
  if (existing) return sendJson(res, 409, { error: "An account with this email already exists" });

  const id = randomUUID();
  await query(
    `INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
    [id, normalizedEmail, await hashPassword(password), role]
  );
  sendJson(res, 201, { id, email: normalizedEmail, role });
});

usersRouter.put("/admin/users/:id/role", requireAuth("super_admin"), async (req, res) => {
  const { role } = req.body;
  if (!["admin", "super_admin"].includes(role)) return sendJson(res, 400, { error: "role must be 'admin' or 'super_admin'" });
  const result = await query(`UPDATE admin_users SET role=$1 WHERE id=$2 RETURNING id`, [role, req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "User not found" });
  sendJson(res, 200, { id: req.params.id, role });
});

// Deleting the last remaining Super Admin would lock everyone out — guard
// against that rather than let it happen silently.
usersRouter.delete("/admin/users/:id", requireAuth("super_admin"), async (req, res) => {
  const target = await queryOne(`SELECT role FROM admin_users WHERE id=$1`, [req.params.id]);
  if (!target) return sendJson(res, 404, { error: "User not found" });

  if (target.role === "super_admin") {
    const remaining = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM admin_users WHERE role='super_admin'`);
    if (Number(remaining?.count ?? 0) <= 1) {
      return sendJson(res, 409, { error: "Cannot delete the last remaining Super Admin account" });
    }
  }
  await query(`DELETE FROM admin_users WHERE id=$1`, [req.params.id]);
  sendJson(res, 200, { deleted: true });
});

// Only the Super Admin can view or change another admin's permissions — a
// regular Admin never manages this, even for themselves.
usersRouter.get("/admin/users/:id/permissions", requireAuth("super_admin"), async (req, res) => {
  const user = await queryOne<{ permissions: string[] }>(`SELECT permissions FROM admin_users WHERE id=$1`, [req.params.id]);
  if (!user) return sendJson(res, 404, { error: "User not found" });
  sendJson(res, 200, { permissions: user.permissions ?? [] });
});

usersRouter.put("/admin/users/:id/permissions", requireAuth("super_admin"), async (req, res) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions) || !permissions.every(isPermission)) {
    return sendJson(res, 400, { error: `permissions must be an array drawn from: ${PERMISSIONS.join(", ")}` });
  }
  const result = await query(`UPDATE admin_users SET permissions=$1 WHERE id=$2 RETURNING id`, [permissions, req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "User not found" });
  sendJson(res, 200, { id: req.params.id, permissions });
});

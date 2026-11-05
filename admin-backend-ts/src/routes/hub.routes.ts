import { Router } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { bearer, hubEnabled, verifyHubToken } from "../auth/hub.js";
import { PERMISSIONS, isPermission } from "../auth/permissions.js";
import { hashPassword } from "../auth/crypto.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { issueTokens } from "./auth.routes.js";
import { Role } from "../types/index.js";

export const hubRouter = Router();

type HubEntry = { hubUserId: string; email: string; name?: string | null; role: string | null; permissions?: unknown; disabled?: boolean };
type LocalAdmin = { id: string; email: string; role: Role; permissions: string[] | null; hub_user_id: string | null; disabled_at: string | null };

const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

function cleanPermissions(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isPermission))] : [];
}

// Ends every refresh token of this admin. (A token rotated a moment ago
// that a reuse window would accept once more is still refused: /auth/refresh
// re-checks the admin is active with the same role.)
async function revokeSessions(adminId: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET revoked=true WHERE subject_id=$1 AND revoked=false`, [adminId]);
}

/** The local admin for a hub account: by link, else (first time) by email. */
async function findLocal(entry: HubEntry): Promise<LocalAdmin | null> {
  const linked = await queryOne<LocalAdmin>(`SELECT * FROM admin_users WHERE hub_user_id=$1`, [entry.hubUserId]);
  if (linked) return linked;
  return queryOne<LocalAdmin>(`SELECT * FROM admin_users WHERE lower(email)=lower($1) AND hub_user_id IS NULL`, [entry.email]);
}

/**
 * Applies the hub's current view of one person to this system: links the
 * account, sets email/role/permissions, or disables it. With `create`, a
 * person new to this system gets an account (unusable local password -- they
 * only ever sign in through the hub). Role or access changes end the
 * person's existing sessions here so the new rights apply at once.
 */
export async function applyHubEntry(entry: HubEntry, create: boolean): Promise<LocalAdmin | null> {
  if (!isUuid(entry.hubUserId) || typeof entry.email !== "string" || !entry.email.includes("@")) throw new Error("Invalid hub entry");
  const email = entry.email.trim().toLowerCase();
  const disabled = entry.disabled === true || (entry.role !== "super_admin" && entry.role !== "admin");
  const role = (disabled ? null : entry.role) as Role | null;
  const permissions = role === "admin" ? cleanPermissions(entry.permissions) : [];
  const name = typeof entry.name === "string" ? entry.name.slice(0, 120) : null;

  let local = await findLocal(entry);
  if (!local) {
    if (disabled || !create) return null;
    const clash = await queryOne(`SELECT id FROM admin_users WHERE lower(email)=$1`, [email]);
    if (clash) throw new Error("Another admin in this system already uses this email and is linked to a different hub account.");
    const unusable = await hashPassword(randomBytes(32).toString("hex"));
    return queryOne<LocalAdmin>(
      `INSERT INTO admin_users (id, email, password_hash, role, permissions, hub_user_id, display_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), email, unusable, role, permissions, entry.hubUserId, name]
    );
  }

  if (disabled) {
    await query(`UPDATE admin_users SET disabled_at=coalesce(disabled_at, now()), hub_user_id=$2 WHERE id=$1`, [local.id, entry.hubUserId]);
    await revokeSessions(local.id);
    return queryOne<LocalAdmin>(`SELECT * FROM admin_users WHERE id=$1`, [local.id]);
  }
  if (email !== local.email.toLowerCase()) {
    const clash = await queryOne(`SELECT id FROM admin_users WHERE lower(email)=$1 AND id<>$2`, [email, local.id]);
    if (clash) throw new Error("Another admin in this system already uses this email.");
  }
  const rightsChanged =
    local.role !== role || !!local.disabled_at ||
    JSON.stringify([...(local.permissions ?? [])].sort()) !== JSON.stringify([...permissions].sort());
  const updated = await queryOne<LocalAdmin>(
    `UPDATE admin_users SET email=$2, role=$3, permissions=$4, hub_user_id=$5, display_name=coalesce($6, display_name), disabled_at=NULL
      WHERE id=$1 RETURNING *`,
    [local.id, email, role, permissions, entry.hubUserId, name]
  );
  if (rightsChanged && !create) await revokeSessions(local.id);
  return updated;
}

/** Sign-in hand-off from the hub (the dashboard posts what it got in #hub_sso=...). */
hubRouter.post("/admin/auth/hub-sso", rateLimit("hub-sso", 30, 15 * 60 * 1000), async (req, res) => {
  if (!hubEnabled()) return sendJson(res, 404, { error: "Admin Hub sign-in is not enabled on this system." });
  const claims = await verifyHubToken(String(req.body?.assertion ?? ""), "hub_sso");
  if (!claims || !isUuid(claims.sub)) {
    return sendJson(res, 401, { error: "This sign-in link is invalid or has expired. Open the system again from the Admin Hub." });
  }
  let admin: LocalAdmin | null;
  try {
    admin = await applyHubEntry(
      { hubUserId: claims.sub, email: String(claims.email ?? ""), name: (claims.name as string) ?? null, role: (claims.role as string) ?? null, permissions: claims.permissions },
      true
    );
  } catch (err) {
    return sendJson(res, 409, { error: (err as Error).message });
  }
  if (!admin || admin.disabled_at) return sendJson(res, 403, { error: "You don't have access to this system." });
  await query(`UPDATE admin_users SET last_login_at=now() WHERE id=$1`, [admin.id]);
  const tokens = await issueTokens(admin.id, admin.role);
  sendJson(res, 200, {
    ...tokens,
    admin: { id: admin.id, email: admin.email, role: admin.role, permissions: admin.permissions ?? [], viaHub: true },
  });
});

/** Access changes pushed by the hub (role, permissions, email, disable). */
hubRouter.post("/admin/hub/sync", async (req, res) => {
  if (!hubEnabled()) return sendJson(res, 404, { error: "Admin Hub is not enabled on this system." });
  const claims = await verifyHubToken(bearer(req.headers.authorization), "hub_sync");
  if (!claims) return sendJson(res, 401, { error: "Invalid hub request." });
  const users = Array.isArray(claims.users) ? (claims.users as HubEntry[]) : [];
  const results = [];
  for (const entry of users) {
    try {
      const local = await applyHubEntry(entry, false);
      results.push({ hubUserId: entry.hubUserId, ok: true, present: !!local });
    } catch (err) {
      results.push({ hubUserId: entry.hubUserId, ok: false, error: (err as Error).message });
    }
  }
  const failed = results.find((r) => !r.ok);
  if (failed) return sendJson(res, 409, { error: failed.error, results });
  sendJson(res, 200, { results });
});

/** What the hub needs to grant access here: this system's permission names. */
hubRouter.get("/admin/hub/meta", async (req, res) => {
  if (!hubEnabled()) return sendJson(res, 404, { error: "Admin Hub is not enabled on this system." });
  const claims = await verifyHubToken(bearer(req.headers.authorization), "hub_meta");
  if (!claims) return sendJson(res, 401, { error: "Invalid hub request." });
  sendJson(res, 200, { permissions: PERMISSIONS });
});

/** Old single-use markers can go once they would have expired anyway. */
export async function cleanupHubTokens(): Promise<void> {
  await query(`DELETE FROM hub_used_tokens WHERE expires_at < now() - interval '5 minutes'`);
}

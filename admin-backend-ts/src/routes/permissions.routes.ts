import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { PERMISSIONS } from "../auth/permissions.js";
import { AGENT_SERVICES, AGENT_SERVICE_KEYS, isAgentService, agentServices } from "../auth/access.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * Owner (super_admin) control of who may use what:
 *  - each Agent's services (agents.services) -- Owner only; an Admin, even
 *    one allowed to manage agents, cannot change them;
 *  - the audit of every grant and revoke (Admin permissions, from this
 *    dashboard or the Admin Hub, and Agent services).
 * Admin permissions themselves are set in users.routes.ts / the Admin Hub.
 */
export const permissionsRouter = Router();

const diff = (before: string[], after: string[]) => ({
  granted: after.filter((k) => !before.includes(k)).sort(),
  revoked: before.filter((k) => !after.includes(k)).sort(),
});

/** Records one grant/revoke (nothing when nothing changed). Never throws. */
export async function recordPermissionChange(p: {
  actorId: string | null;
  source: "dashboard" | "admin_hub";
  targetType: "admin" | "agent";
  targetId: string;
  before: string[];
  after: string[];
  roleBefore?: string | null;
  roleAfter?: string | null;
}): Promise<void> {
  try {
    const { granted, revoked } = diff(p.before ?? [], p.after ?? []);
    const roleChanged = (p.roleBefore ?? null) !== (p.roleAfter ?? null);
    if (!granted.length && !revoked.length && !roleChanged) return;
    const actor = p.actorId ? await queryOne<{ email: string }>(`SELECT email FROM admin_users WHERE id=$1`, [p.actorId]) : null;
    const target =
      p.targetType === "admin"
        ? await queryOne<{ label: string }>(`SELECT email AS label FROM admin_users WHERE id=$1`, [p.targetId])
        : await queryOne<{ label: string }>(`SELECT name || ' (' || phone || ')' AS label FROM agents WHERE id=$1`, [p.targetId]);
    await query(
      `INSERT INTO permission_audit (actor_id, actor_label, source, target_type, target_id, target_label, granted, revoked, role_before, role_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        p.actorId,
        actor?.email ?? (p.source === "admin_hub" ? "Admin Hub" : "unknown"),
        p.source,
        p.targetType,
        p.targetId,
        target?.label ?? p.targetId,
        granted,
        revoked,
        roleChanged ? p.roleBefore ?? null : null,
        roleChanged ? p.roleAfter ?? null : null,
      ]
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("recordPermissionChange failed (non-fatal):", (err as Error).message);
  }
}

/** Sets an agent's services and keeps the older per-feature switches in step. */
export async function setAgentServices(agentId: string, services: string[], actorId: string): Promise<string[] | null> {
  const before = await queryOne<{ services: string[] }>(`SELECT services FROM agents WHERE id=$1`, [agentId]);
  if (!before) return null;
  const clean = AGENT_SERVICE_KEYS.filter((k) => services.includes(k));
  await query(`UPDATE agents SET services=$2, operations_enabled=$3, ciyaaraha_enabled=$4 WHERE id=$1`, [
    agentId,
    clean,
    clean.includes("operations"),
    clean.includes("ciyaaraha"),
  ]);
  await recordPermissionChange({ actorId, source: "dashboard", targetType: "agent", targetId: agentId, before: before.services ?? [], after: clean });
  return clean;
}

/** The catalog of Admin permissions and Agent services, for the Owner's page. */
permissionsRouter.get("/admin/permission-catalog", requireAuth("super_admin"), async (_req, res) => {
  sendJson(res, 200, { adminPermissions: PERMISSIONS, agentServices: AGENT_SERVICES });
});

permissionsRouter.get("/admin/agent-services", requireAuth("super_admin"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT id, name, phone, status, services FROM agents ORDER BY name`));
});

permissionsRouter.put("/admin/agents/:id/services", requireAuth("super_admin"), async (req, res) => {
  const services = req.body?.services;
  if (!Array.isArray(services) || !services.every(isAgentService)) {
    return sendJson(res, 400, { error: `services must be a list drawn from: ${AGENT_SERVICE_KEYS.join(", ")}` });
  }
  const saved = await setAgentServices(req.params.id, services, req.auth!.sub);
  if (!saved) return sendJson(res, 404, { error: "Agent not found" });
  sendJson(res, 200, { id: req.params.id, services: saved });
});

permissionsRouter.get("/admin/permission-audit", requireAuth("super_admin"), async (req, res) => {
  const targetType = String(req.query.targetType ?? "");
  const targetId = String(req.query.targetId ?? "");
  const args: unknown[] = [];
  const where: string[] = [];
  if (targetType === "admin" || targetType === "agent") {
    args.push(targetType);
    where.push(`target_type=$${args.length}`);
  }
  if (/^[0-9a-f-]{36}$/i.test(targetId)) {
    args.push(targetId);
    where.push(`target_id=$${args.length}`);
  }
  sendJson(
    res,
    200,
    await query(`SELECT * FROM permission_audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 500`, args)
  );
});

/** The signed-in agent's own services, so the Agent App shows only those. */
permissionsRouter.get("/agent/me/services", requireAuth("agent"), async (req, res) => {
  sendJson(res, 200, { services: await agentServices(req.auth!.sub), all: AGENT_SERVICE_KEYS });
});

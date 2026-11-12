import { Router, Request, Response, NextFunction } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import {
  ActivationRow,
  decryptCode,
  deviceActivationRequired,
  forgetApprovedDevice,
  hashActivationCode,
  isDeviceApproved,
  normalizeCode,
  resolveAgentDevice,
} from "../utils/deviceActivation.js";
import { verifyToken } from "../auth/crypto.js";

export const deviceActivationRouter = Router();

export const INSTALL_ID_HEADER = "x-agent-install-id";
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function installIdFrom(req: Request): string | null {
  const raw = String(req.headers[INSTALL_ID_HEADER] ?? req.body?.installId ?? "").trim();
  return INSTALL_ID_RE.test(raw) ? raw : null;
}

// ---------------- Agent App ----------------

/**
 * The Agent App calls this after login and from the Check button: returns
 * this install's activation status, its device number, and -- while
 * pending -- the current activation code (a new one if the old expired).
 * Only "approved" here lets the app open.
 */
deviceActivationRouter.post("/agent/device-activation/status", requireAuth("agent"), async (req, res) => {
  const installId = installIdFrom(req);
  if (!installId) return sendJson(res, 400, { error: "A valid installId is required" });
  if (!deviceActivationRequired()) {
    return sendJson(res, 200, { status: "approved", required: false, deviceNumber: null, code: null, codeExpiresAt: null });
  }
  const agent = await queryOne<{ status: string }>(`SELECT status FROM agents WHERE id=$1`, [req.auth!.sub]);
  if (!agent || agent.status !== "active") return sendJson(res, 403, { error: "This Agent account is not active", code: "ACCOUNT_INACTIVE" });

  const row = await resolveAgentDevice({
    agentId: req.auth!.sub,
    installId,
    deviceModel: req.body?.deviceModel ? String(req.body.deviceModel).slice(0, 120) : null,
    agentDeviceId: req.body?.agentDeviceId ? String(req.body.agentDeviceId).slice(0, 120) : null,
  });
  sendJson(res, 200, {
    status: row.status,
    required: true,
    deviceNumber: row.device_number,
    code: row.status === "pending" ? decryptCode(row) : null,
    codeExpiresAt: row.status === "pending" ? row.code_expires_at : null,
  });
});

// ---------------- Admin Dashboard ----------------

async function loadDetails(activationId: string) {
  return queryOne(
    `SELECT d.id AS activation_id, d.device_number, d.device_model, d.agent_device_id, d.status AS activation_status,
            d.code_expires_at, d.code_used_at, d.created_at AS requested_at, d.approved_at, d.approval_note,
            d.rejected_at, d.revoked_at,
            a.id AS agent_id, 'AGT-' || UPPER(SUBSTRING(a.id::text, 1, 8)) AS agent_code, a.name AS agent_name,
            a.phone AS agent_phone, a.status AS account_status,
            ab.email AS approved_by_email, rb.email AS rejected_by_email, vb.email AS revoked_by_email
     FROM agent_device_activations d
     JOIN agents a ON a.id = d.agent_id
     LEFT JOIN admin_users ab ON ab.id = d.approved_by
     LEFT JOIN admin_users rb ON rb.id = d.rejected_by
     LEFT JOIN admin_users vb ON vb.id = d.revoked_by
     WHERE d.id=$1`,
    [activationId]
  );
}

/** Finds the device a code belongs to, preferring a live pending code. */
async function findByCode(code: string): Promise<ActivationRow | null> {
  return queryOne<ActivationRow>(
    `SELECT * FROM agent_device_activations WHERE code_hash=$1
     ORDER BY (status = 'pending') DESC, updated_at DESC LIMIT 1`,
    [hashActivationCode(code)]
  );
}

/** Why a code can't be used, or null if it's a live pending code. */
function codeProblem(row: ActivationRow | null): { status: number; code: string; error: string } | null {
  if (!row) return { status: 404, code: "INVALID_CODE", error: "This activation code is invalid. Check the code on the agent's phone and try again." };
  if (row.status === "approved" || row.code_used_at) {
    return { status: 409, code: "CODE_USED", error: "This activation code has already been used. The device is already activated." };
  }
  if (row.status === "rejected") return { status: 409, code: "DEVICE_REJECTED", error: "This device's activation was rejected." };
  if (row.status !== "pending") return { status: 409, code: "CODE_NOT_ACTIVE", error: "This activation code is no longer active." };
  if (!row.code_expires_at || new Date(row.code_expires_at) <= new Date()) {
    return { status: 410, code: "CODE_EXPIRED", error: "This activation code has expired. Ask the agent to tap Check to get a new code." };
  }
  return null;
}

deviceActivationRouter.post(
  "/admin/device-activations/check",
  requirePermission("agents.manage"),
  rateLimit("device-activation-check", 60, 15 * 60 * 1000),
  async (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!code) return sendJson(res, 400, { code: "INVALID_CODE", error: "Enter the 4-character activation code (letters and numbers)." });
    const row = await findByCode(code);
    const problem = codeProblem(row);
    if (problem) {
      return sendJson(res, problem.status, { code: problem.code, error: problem.error, details: row ? await loadDetails(row.id) : null });
    }
    sendJson(res, 200, await loadDetails(row!.id));
  }
);

deviceActivationRouter.post("/admin/device-activations/:id/approve", requirePermission("agents.manage"), async (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (!code) return sendJson(res, 400, { code: "INVALID_CODE", error: "The activation code is required to approve a device." });

  const target = await queryOne<ActivationRow & { account_status: string }>(
    `SELECT d.*, a.status AS account_status FROM agent_device_activations d JOIN agents a ON a.id=d.agent_id WHERE d.id=$1`,
    [req.params.id]
  );
  if (!target) return sendJson(res, 404, { error: "Device not found" });
  if (target.code_hash !== hashActivationCode(code)) {
    return sendJson(res, 409, { code: "CODE_MISMATCH", error: "This code doesn't belong to this device. Check the code again." });
  }
  const problem = codeProblem(target);
  if (problem) return sendJson(res, problem.status, { code: problem.code, error: problem.error });
  if (target.account_status !== "active") {
    return sendJson(res, 409, { code: "ACCOUNT_INACTIVE", error: "This agent's account is suspended. Activate the account first." });
  }

  // Atomic: only one approval can win, and only while the code is still live.
  const approved = await queryOne<ActivationRow>(
    `UPDATE agent_device_activations
     SET status='approved', approved_by=$2, approved_at=now(), code_used_at=now(), approval_note=NULL, updated_at=now()
     WHERE id=$1 AND status='pending' AND code_hash=$3 AND code_expires_at > now()
     RETURNING *`,
    [req.params.id, req.auth!.sub, hashActivationCode(code)]
  );
  if (!approved) {
    const again = await queryOne<ActivationRow>(`SELECT * FROM agent_device_activations WHERE id=$1`, [req.params.id]);
    const p = codeProblem(again) ?? { status: 409, code: "CODE_NOT_ACTIVE", error: "This activation code is no longer active." };
    return sendJson(res, p.status, { code: p.code, error: p.error });
  }
  await recordActivity({
    adminId: req.auth!.sub,
    action: "device_activation.approved",
    entityType: "agent_device",
    entityId: approved.id,
    oldValue: { status: "pending" },
    newValue: { status: "approved", agentId: approved.agent_id, deviceNumber: approved.device_number },
  });
  sendJson(res, 200, await loadDetails(approved.id));
});

deviceActivationRouter.post("/admin/device-activations/:id/reject", requirePermission("agents.manage"), async (req, res) => {
  const rejected = await queryOne<ActivationRow>(
    `UPDATE agent_device_activations
     SET status='rejected', rejected_by=$2, rejected_at=now(), code_hash=NULL, code_encrypted=NULL, updated_at=now()
     WHERE id=$1 AND status='pending' RETURNING *`,
    [req.params.id, req.auth!.sub]
  );
  if (!rejected) return sendJson(res, 409, { error: "Only a device waiting for approval can be rejected." });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "device_activation.rejected",
    entityType: "agent_device",
    entityId: rejected.id,
    oldValue: { status: "pending" },
    newValue: { status: "rejected", agentId: rejected.agent_id, deviceNumber: rejected.device_number },
  });
  sendJson(res, 200, await loadDetails(rejected.id));
});

deviceActivationRouter.post("/admin/device-activations/:id/revoke", requirePermission("agents.manage"), async (req, res) => {
  const revoked = await queryOne<ActivationRow>(
    `UPDATE agent_device_activations
     SET status='revoked', revoked_by=$2, revoked_at=now(), code_hash=NULL, code_encrypted=NULL, updated_at=now()
     WHERE id=$1 AND status IN ('approved','rejected') RETURNING *`,
    [req.params.id, req.auth!.sub]
  );
  if (!revoked) return sendJson(res, 409, { error: "Only an approved or rejected device can be revoked/reset." });
  forgetApprovedDevice(revoked.agent_id, revoked.install_id);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "device_activation.revoked",
    entityType: "agent_device",
    entityId: revoked.id,
    oldValue: null,
    newValue: { status: "revoked", agentId: revoked.agent_id, deviceNumber: revoked.device_number },
  });
  sendJson(res, 200, await loadDetails(revoked.id));
});

deviceActivationRouter.get("/admin/device-activations", requirePermission("agents.manage"), async (req, res) => {
  const status = typeof req.query.status === "string" && ["pending", "approved", "rejected", "revoked"].includes(req.query.status) ? req.query.status : null;
  const rows = await query(
    `SELECT d.id AS activation_id, d.device_number, d.device_model, d.agent_device_id, d.status AS activation_status,
            d.created_at AS requested_at, d.approved_at, d.approval_note, d.rejected_at, d.revoked_at, d.last_seen_at,
            a.id AS agent_id, 'AGT-' || UPPER(SUBSTRING(a.id::text, 1, 8)) AS agent_code, a.name AS agent_name, a.phone AS agent_phone,
            a.status AS account_status, ab.email AS approved_by_email
     FROM agent_device_activations d
     JOIN agents a ON a.id = d.agent_id
     LEFT JOIN admin_users ab ON ab.id = d.approved_by
     WHERE ($1::text IS NULL OR d.status = $1)
     ORDER BY d.updated_at DESC LIMIT 200`,
    [status]
  );
  sendJson(res, 200, rows);
});

// ---------------- The gate ----------------

/**
 * One log line per refused install per minute, so an operator can tell which
 * app copy is being refused: "install=none" is an app too old to send the
 * install id; an id with no row is an install that never showed its code; a
 * known one names its device number in the dashboard.
 */
const lastRefusalLog = new Map<string, number>();
function logRefusal(agentId: string, installId: string | null, req: Request): void {
  const key = `${agentId}:${installId ?? "none"}`;
  const now = Date.now();
  if ((lastRefusalLog.get(key) ?? 0) > now - 60_000) return;
  lastRefusalLog.set(key, now);
  if (lastRefusalLog.size > 1000) lastRefusalLog.clear();
  void queryOne<{ device_number: string; status: string }>(
    `SELECT device_number, status FROM agent_device_activations WHERE agent_id=$1 AND install_id=$2`,
    [agentId, installId ?? ""]
  )
    .then((row) => {
      console.warn(
        `[device-activation] refused agent=${agentId} install=${installId ? installId.slice(0, 8) : "none"} ` +
          `device=${row ? `${row.device_number}(${row.status})` : "unregistered"} ua="${String(req.headers["user-agent"] ?? "").slice(0, 60)}"`
      );
    })
    .catch(() => undefined);
}

/** Routes an agent can call before its device is approved. */
function isExempt(path: string): boolean {
  return path.startsWith("/agent/device-activation") || path.startsWith("/agent/auth/") || path === "/auth/refresh" || path === "/auth/logout";
}

/**
 * Device Activation enforcement for the whole agent API, registered globally
 * in server.ts ahead of every router (same pattern as
 * customerSuspensionMiddleware): any request carrying an agent token must
 * come from an approved install (X-Agent-Install-Id), or it gets 403
 * DEVICE_NOT_ACTIVATED. Checked on the server, so no client can skip it.
 * Requests without an agent token are untouched.
 */
export async function agentDeviceActivationMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!deviceActivationRequired()) return next();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  const payload = verifyToken(token);
  if (!payload || payload.role !== "agent") return next();
  if (isExempt(req.path)) return next();

  const installId = installIdFrom(req);
  if (installId && (await isDeviceApproved(payload.sub, installId))) return next();
  logRefusal(payload.sub, installId, req);
  res.setHeader("X-Device-Activation", "required");
  sendJson(res, 403, {
    code: "DEVICE_NOT_ACTIVATED",
    error: "This device hasn't been activated yet. Open the Agent App and give your account manager the activation code.",
  });
}

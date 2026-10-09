import { createHmac, randomInt } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { encrypt, decrypt } from "../auth/crypto.js";

/**
 * Device Activation (Agent App): every app install must be approved by an
 * admin before it can use agent APIs. The install shows a 7-digit device
 * number and a 4-character activation code; the admin checks the code in
 * the dashboard and approves it.
 */

export type ActivationStatus = "pending" | "approved" | "rejected" | "revoked";

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const CODE_LENGTH = 4;

/** Off only if the server explicitly sets DEVICE_ACTIVATION_REQUIRED=false. */
export function deviceActivationRequired(): boolean {
  return process.env.DEVICE_ACTIVATION_REQUIRED !== "false";
}

export function codeTtlMs(): number {
  const minutes = Number(process.env.DEVICE_ACTIVATION_CODE_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
}

/** A cryptographically random 4-character code like "44b1". */
export function generateActivationCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function normalizeCode(raw: unknown): string | null {
  const code = String(raw ?? "").trim().toLowerCase();
  return /^[a-z0-9]{4}$/.test(code) ? code : null;
}

/** Keyed hash used to look a code up -- the code itself is never stored in plain text. */
export function hashActivationCode(code: string): string {
  const key = process.env.JWT_SECRET || "dev-only-jwt-secret-change-in-production";
  return createHmac("sha256", key).update(`device-activation:${code.toLowerCase()}`).digest("hex");
}

async function generateUniqueDeviceNumber(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const n = String(randomInt(1_000_000, 10_000_000));
    const taken = await queryOne(`SELECT 1 FROM agent_device_activations WHERE device_number=$1`, [n]);
    if (!taken) return n;
  }
  throw new Error("Could not allocate a device number");
}

export interface ActivationRow {
  id: string;
  agent_id: string;
  install_id: string;
  device_number: string;
  device_model: string | null;
  agent_device_id: string | null;
  status: ActivationStatus;
  code_hash: string | null;
  code_encrypted: string | null;
  code_expires_at: string | null;
  code_used_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
}

/**
 * Gives a pending device a fresh code (new random code, new expiry). Retries
 * on the rare collision with another device's live code.
 */
export async function issueNewCode(activationId: string): Promise<{ code: string; expiresAt: Date }> {
  for (let i = 0; i < 10; i++) {
    const code = generateActivationCode();
    const expiresAt = new Date(Date.now() + codeTtlMs());
    try {
      await query(
        `UPDATE agent_device_activations
         SET status='pending', code_hash=$2, code_encrypted=$3, code_expires_at=$4, code_used_at=NULL, updated_at=now()
         WHERE id=$1`,
        [activationId, hashActivationCode(code), encrypt(code), expiresAt]
      );
      return { code, expiresAt };
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
    }
  }
  throw new Error("Could not allocate a unique activation code");
}

export function decryptCode(row: Pick<ActivationRow, "code_encrypted">): string | null {
  if (!row.code_encrypted) return null;
  try {
    return decrypt(row.code_encrypted);
  } catch {
    return null;
  }
}

/**
 * The app's view of its own activation: finds or creates this install's row
 * and makes sure a pending device always has a live code. An agent who was
 * already using the app before Device Activation was switched on gets their
 * first device approved automatically (recorded with a note), so existing
 * phones keep working.
 */
export async function resolveAgentDevice(params: {
  agentId: string;
  installId: string;
  deviceModel?: string | null;
  agentDeviceId?: string | null;
}): Promise<ActivationRow> {
  let row = await queryOne<ActivationRow>(`SELECT * FROM agent_device_activations WHERE agent_id=$1 AND install_id=$2`, [
    params.agentId,
    params.installId,
  ]);

  if (!row) {
    const existingCount = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM agent_device_activations WHERE agent_id=$1`, [
      params.agentId,
    ]);
    const legacy = await queryOne<{ legacy: boolean }>(
      `SELECT (a.last_login_at IS NOT NULL AND a.last_login_at < r.started_at) AS legacy
       FROM agents a CROSS JOIN device_activation_rollout r WHERE a.id=$1`,
      [params.agentId]
    );
    const grandfather = (existingCount?.n ?? 0) === 0 && legacy?.legacy === true;
    const deviceNumber = await generateUniqueDeviceNumber();
    row = await queryOne<ActivationRow>(
      `INSERT INTO agent_device_activations (agent_id, install_id, device_number, device_model, agent_device_id, status, approved_at, approval_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (agent_id, install_id) DO UPDATE SET last_seen_at=now()
       RETURNING *`,
      [
        params.agentId,
        params.installId,
        deviceNumber,
        params.deviceModel ?? null,
        params.agentDeviceId ?? null,
        grandfather ? "approved" : "pending",
        grandfather ? new Date() : null,
        grandfather ? "Approved automatically: this agent's device was already in use before Device Activation was switched on." : null,
      ]
    );
  } else {
    await query(
      `UPDATE agent_device_activations SET last_seen_at=now(), device_model=COALESCE($2, device_model), agent_device_id=COALESCE($3, agent_device_id) WHERE id=$1`,
      [row.id, params.deviceModel ?? null, params.agentDeviceId ?? null]
    );
  }

  // A revoked device starts over: a new code to be approved again.
  // A pending device whose code expired (or never had one) gets a new code.
  if (row!.status === "revoked" || (row!.status === "pending" && (!row!.code_hash || !row!.code_expires_at || new Date(row!.code_expires_at) <= new Date()))) {
    await issueNewCode(row!.id);
    row = (await queryOne<ActivationRow>(`SELECT * FROM agent_device_activations WHERE id=$1`, [row!.id]))!;
  }
  return row!;
}

/** Cache of approved (agent, install) pairs so the per-request gate is cheap. */
const approvedCache = new Map<string, number>();
const CACHE_MS = 60_000;

export function forgetApprovedDevice(agentId: string, installId: string): void {
  approvedCache.delete(`${agentId}:${installId}`);
}

export function clearApprovedDeviceCache(): void {
  approvedCache.clear();
}

export async function isDeviceApproved(agentId: string, installId: string): Promise<boolean> {
  const key = `${agentId}:${installId}`;
  const cachedAt = approvedCache.get(key);
  if (cachedAt && Date.now() - cachedAt < CACHE_MS) return true;
  const row = await queryOne<{ status: string }>(`SELECT status FROM agent_device_activations WHERE agent_id=$1 AND install_id=$2`, [
    agentId,
    installId,
  ]);
  if (row?.status === "approved") {
    approvedCache.set(key, Date.now());
    return true;
  }
  approvedCache.delete(key);
  return false;
}

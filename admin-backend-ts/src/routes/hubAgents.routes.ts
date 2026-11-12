import { Router } from "express";
import { createHash } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { bearer, hubEnabled, verifyHubToken } from "../auth/hub.js";
import { hashPassword, verifyPassword } from "../auth/crypto.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { issueTokens } from "./auth.routes.js";

/**
 * AGENT APP sign-in through the Admin Hub (see the hub's
 * agentLogin.routes.ts). One app for every system: the agent types phone
 * number + PIN, the hub asks every system whether that is one of its
 * agents, and only the one system that says yes hands out a session.
 *
 *  - POST /admin/hub/agent-check  (hub only, signed): is phone + PIN an
 *    active agent here? Answers { match, agentId } -- nothing else, and the
 *    same bcrypt work whether or not the number exists, so the answer time
 *    says nothing either.
 *  - POST /admin/hub/agent-phone  (hub only, signed): is this phone number
 *    an agent here? For an admin of ANOTHER system about to give the same
 *    number to one of their agents.
 *  - POST /agent/auth/hub-login   (the app): spends the hub's single-use,
 *    60-second pass for one agent of THIS system and starts this system's
 *    normal agent session. Device Activation still applies to every agent
 *    request after that, exactly as before.
 *
 * The agent's PIN is the agent's existing password (agents.password_hash,
 * set by the admin who created the agent), so every existing agent can sign
 * in with it. Nothing about agents or PINs is stored at the hub. The
 * existing device sign-in (/agent/auth/device-login) is unchanged, so the
 * current Agent App keeps working until it is replaced.
 */
export const hubAgentsRouter = Router();

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const checkHash = (phone: string, pin: string) => sha256(`agent-check\n${phone}\n${pin}`);
const phoneHash = (phone: string) => sha256(`agent-phone\n${phone}`);

/** The 9-digit local number from any spelling, or null. Same rule as the hub. */
export function localAgentPhone(raw: unknown): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (/^00252\d{9}$/.test(digits)) digits = digits.slice(5);
  else if (/^252\d{9}$/.test(digits)) digits = digits.slice(3);
  else if (/^0\d{9}$/.test(digits)) digits = digits.slice(1);
  return /^\d{9}$/.test(digits) ? digits : null;
}

/** agents.phone in its 9-digit local form, in SQL (any stored spelling). */
const LOCAL_PHONE_SQL = `regexp_replace(regexp_replace(regexp_replace(regexp_replace(phone, '\\D', '', 'g'), '^00252', ''), '^252(\\d{9})$', '\\1'), '^0(\\d{9})$', '\\1')`;

let dummyHash: Promise<string> | null = null;
/** Same bcrypt work as a real check, for a number that isn't an agent here. */
async function burnCheck(pin: string): Promise<void> {
  dummyHash ??= hashPassword("not-a-real-agent-pin");
  await verifyPassword(pin, await dummyHash);
}

hubAgentsRouter.post("/admin/hub/agent-check", async (req, res) => {
  if (!hubEnabled()) return sendJson(res, 404, { error: "Admin Hub is not enabled on this system." });
  const claims = await verifyHubToken(bearer(req.headers.authorization), "hub_agent_check");
  const phone = localAgentPhone(req.body?.phone);
  const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
  if (!claims || !phone || !pin || claims.bodyHash !== checkHash(phone, pin)) {
    return sendJson(res, 401, { error: "Invalid hub request." });
  }
  const candidates = await query<{ id: string; password_hash: string }>(
    `SELECT id, password_hash FROM agents WHERE status='active' AND ${LOCAL_PHONE_SQL} = $1 ORDER BY created_at ASC`,
    [phone]
  );
  if (candidates.length === 0) {
    await burnCheck(pin);
    return sendJson(res, 200, { match: false });
  }
  for (const agent of candidates) {
    if (await verifyPassword(pin, agent.password_hash)) return sendJson(res, 200, { match: true, agentId: agent.id });
  }
  sendJson(res, 200, { match: false });
});

hubAgentsRouter.post("/admin/hub/agent-phone", async (req, res) => {
  if (!hubEnabled()) return sendJson(res, 404, { error: "Admin Hub is not enabled on this system." });
  const claims = await verifyHubToken(bearer(req.headers.authorization), "hub_agent_phone");
  const phone = localAgentPhone(req.body?.phone);
  if (!claims || !phone || claims.bodyHash !== phoneHash(phone)) return sendJson(res, 401, { error: "Invalid hub request." });
  const row = await queryOne(`SELECT 1 FROM agents WHERE ${LOCAL_PHONE_SQL} = $1 LIMIT 1`, [phone]);
  sendJson(res, 200, { inUse: Boolean(row) });
});

hubAgentsRouter.post("/agent/auth/hub-login", rateLimit("agent-hub-login", 30, 15 * 60 * 1000), async (req, res) => {
  if (!hubEnabled()) return sendJson(res, 404, { error: "Admin Hub sign-in is not enabled on this system." });
  const claims = await verifyHubToken(String(req.body?.handoff ?? ""), "hub_agent_sso");
  if (!claims || typeof claims.sub !== "string") {
    return sendJson(res, 401, { error: "This sign-in has expired. Enter your phone number and PIN again." });
  }
  const agent = await queryOne<{ id: string; name: string; phone: string; status: string }>(
    `SELECT id, name, phone, status FROM agents WHERE id=$1`,
    [claims.sub]
  );
  if (!agent || agent.status !== "active") return sendJson(res, 403, { error: "This agent account is not active. Ask your admin." });
  await query(`UPDATE agents SET last_login_at = now() WHERE id=$1`, [agent.id]);
  const tokens = await issueTokens(agent.id, "agent");
  sendJson(res, 200, { ...tokens, agent: { id: agent.id, name: agent.name, phone: agent.phone } });
});

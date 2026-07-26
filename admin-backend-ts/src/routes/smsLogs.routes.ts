import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

export const smsLogsRouter = Router();

/** Somali phone numbers legitimately appear in multiple formats (with 252,
 * with a leading 0, or bare) — compare the last 9 digits, not raw strings. */
function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

/**
 * Cross-network by design: the telecom that RECEIVED the payment has no
 * bearing on which PROVIDER's order it fulfills — a customer can pay via
 * any network for a package on any other. Matches by amount + normalized
 * customer phone only, never by provider. No phone match -> returns null
 * rather than guessing across possibly-different customers by amount alone.
 */
async function findMatchingOrder(parsedAmount: number | undefined, parsedPhone: string | undefined) {
  if (parsedAmount == null || !parsedPhone) return null;
  const target = normalizePhone(parsedPhone);
  if (!target) return null;

  const candidates = await query<{ id: string; sender_phone: string | null }>(
    `SELECT id, sender_phone FROM orders WHERE status='pending' AND ABS(amount - $1) < 0.01 ORDER BY created_at ASC`,
    [parsedAmount]
  );
  return candidates.find((o) => normalizePhone(o.sender_phone) === target) ?? null;
}

smsLogsRouter.post("/agent/sms-logs", requireAuth("agent"), async (req, res) => {
  const { sender, body, parsedProvider, parsedAmount, parsedPhone, receivedAt } = req.body;
  if (!sender || !body) return sendJson(res, 400, { error: "sender and body are required" });

  const match = await findMatchingOrder(parsedAmount, parsedPhone);
  const id = randomUUID();
  await query(
    `INSERT INTO sms_logs (id, agent_id, sender, body, parsed_provider, parsed_amount, parsed_phone, matched_order_id, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, now()))`,
    [id, req.auth!.sub, sender, body, parsedProvider ?? null, parsedAmount ?? null, parsedPhone ?? null, match?.id ?? null, receivedAt ?? null]
  );

  // A company with automation off means the agent must tap through the
  // existing manual verify-payment flow instead of the app auto-dialing.
  let requiresManualApproval = false;
  if (match) {
    const order = await queryOne<{ company_id: string }>(`SELECT company_id FROM orders WHERE id=$1`, [match.id]);
    const company = order && (await queryOne<{ auto_process_enabled: boolean }>(
      `SELECT auto_process_enabled FROM companies WHERE id=$1`,
      [order.company_id]
    ));
    requiresManualApproval = company ? !company.auto_process_enabled : false;
  }

  sendJson(res, 201, { id, matchedOrderId: match?.id ?? null, requiresManualApproval });
});

smsLogsRouter.get("/admin/sms-logs", requireStaff(), async (req, res) => {
  const { agentId, matched } = req.query as Record<string, string | undefined>;
  let sql = `SELECT * FROM sms_logs WHERE 1=1`;
  const args: unknown[] = [];
  if (agentId) { args.push(agentId); sql += ` AND agent_id=$${args.length}`; }
  if (matched === "true") sql += ` AND matched_order_id IS NOT NULL`;
  if (matched === "false") sql += ` AND matched_order_id IS NULL`;
  sql += ` ORDER BY received_at DESC`;
  sendJson(res, 200, await query(sql, args));
});

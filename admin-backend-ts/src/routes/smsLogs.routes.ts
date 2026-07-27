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

async function requiresManualApprovalFor(orderId: string): Promise<boolean> {
  const order = await queryOne<{ company_id: string }>(`SELECT company_id FROM orders WHERE id=$1`, [orderId]);
  const company = order && (await queryOne<{ auto_process_enabled: boolean }>(
    `SELECT auto_process_enabled FROM companies WHERE id=$1`,
    [order.company_id]
  ));
  return company ? !company.auto_process_enabled : false;
}

smsLogsRouter.post("/agent/sms-logs", requireAuth("agent"), async (req, res) => {
  const { sender, body, parsedProvider, parsedAmount, parsedPhone, receivedAt } = req.body;
  if (!sender || !body) return sendJson(res, 400, { error: "sender and body are required" });

  const match = await findMatchingOrder(parsedAmount, parsedPhone);
  const id = randomUUID();
  // Resolved once in JS (rather than left to SQL's now()) so the dedup
  // lookup below, if the insert conflicts, checks the exact same instant
  // the failed insert attempted — not a fresh now() that could land in a
  // different truncated minute than the row that actually won.
  const effectiveReceivedAt = receivedAt ?? new Date().toISOString();
  try {
    await query(
      `INSERT INTO sms_logs (id, agent_id, sender, body, parsed_provider, parsed_amount, parsed_phone, matched_order_id, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, req.auth!.sub, sender, body, parsedProvider ?? null, parsedAmount ?? null, parsedPhone ?? null, match?.id ?? null, effectiveReceivedAt]
    );
  } catch (err: any) {
    if (err?.code !== "23505") throw err;
    // A redelivered SMS broadcast (or a client retry after a dropped
    // response) hit the dedup index — return the log that already exists
    // instead of creating a second one, so the same payment never gets
    // matched/dialed twice.
    const existing = await queryOne<{ id: string; matched_order_id: string | null }>(
      `SELECT id, matched_order_id FROM sms_logs
       WHERE sender=$1 AND body=$2
         AND date_trunc('minute', received_at AT TIME ZONE 'UTC') = date_trunc('minute', $3::timestamptz AT TIME ZONE 'UTC')
       LIMIT 1`,
      [sender, body, effectiveReceivedAt]
    );
    if (existing) {
      const requiresManualApproval = existing.matched_order_id ? await requiresManualApprovalFor(existing.matched_order_id) : false;
      return sendJson(res, 200, { id: existing.id, matchedOrderId: existing.matched_order_id, requiresManualApproval, duplicate: true });
    }
    throw err;
  }

  // A company with automation off means the agent must tap through the
  // existing manual verify-payment flow instead of the app auto-dialing.
  const requiresManualApproval = match ? await requiresManualApprovalFor(match.id) : false;

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

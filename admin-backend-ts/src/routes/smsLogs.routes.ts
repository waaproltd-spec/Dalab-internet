import { Router, Response } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";

export const smsLogsRouter = Router();

/** Somali phone numbers legitimately appear in multiple formats (with 252,
 * with a leading 0, or bare) — compare the last 9 digits, not raw strings. */
function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

type OrderMatch = { id: string; sender_phone: string | null; receiver_phone: string | null; amount: number; company_id: string };

/**
 * Cross-network by design: the telecom that RECEIVED the payment has no
 * bearing on which PROVIDER's order it fulfills — a customer can pay via
 * any network for a package on any other. Matches by amount + normalized
 * customer phone only, never by provider. No phone match -> returns null
 * rather than guessing across possibly-different customers by amount alone.
 *
 * Two safeguards against a real payment being silently absorbed by the
 * WRONG order (same customer, same amount, but an old/abandoned attempt):
 *  - MATCH_WINDOW_HOURS excludes anything older than a day — a payment SMS
 *    arriving now is confirming something the customer just did, not a
 *    order they gave up on yesterday.
 *  - Within that window, the NEWEST pending order wins (`created_at DESC`,
 *    not ASC) — a customer who repeats a purchase at the same price almost
 *    always means their latest attempt, not an earlier abandoned one. Used
 *    to pick oldest-first, which meant a stale never-paid test/abandoned
 *    order for the same amount would keep "winning" every future payment
 *    for that amount from that phone, leaving the actual current order
 *    stuck at Pending forever while the stale one silently advanced.
 */
const MATCH_WINDOW_HOURS = 24;

async function findMatchingOrder(parsedAmount: number | undefined, parsedPhone: string | undefined): Promise<OrderMatch | null> {
  if (parsedAmount == null || !parsedPhone) return null;
  const target = normalizePhone(parsedPhone);
  if (!target) return null;

  const candidates = await query<OrderMatch>(
    `SELECT id, sender_phone, receiver_phone, amount, company_id FROM orders
     WHERE status='pending' AND ABS(amount - $1) < 0.01 AND created_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
     ORDER BY created_at DESC`,
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

/** True once an order has left 'pending' — a payment can never be (re-)linked to it after this. */
async function orderAlreadyFulfilled(orderId: string): Promise<boolean> {
  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id=$1`, [orderId]);
  return order != null && order.status !== "pending";
}

/**
 * Every verified/completed/rejected-duplicate payment SMS gets one Activity
 * Log entry so a Super Admin can see the whole incoming-payment pipeline —
 * not just admin-driven config changes — in one place, live. adminId is
 * always null here (this is a system/agent event, not an admin action);
 * recordActivity already treats a null adminId as valid (ON DELETE SET NULL).
 */
async function logPaymentActivity(params: {
  action: "payment_verified" | "payment_already_processed";
  smsLogId: string;
  order: OrderMatch;
  transactionRef: string | null;
  paymentTimestamp: string;
  status: "verified" | "already_processed";
}) {
  await recordActivity({
    adminId: undefined,
    action: params.action,
    entityType: "payment_transaction",
    entityId: params.smsLogId,
    oldValue: null,
    newValue: {
      orderId: params.order.id,
      senderPhone: params.order.sender_phone,
      receiverPhone: params.order.receiver_phone,
      amount: params.order.amount,
      provider: params.order.company_id,
      transactionRef: params.transactionRef,
      paymentTimestamp: params.paymentTimestamp,
      status: params.status,
    },
  });
}

async function respondAlreadyProcessed(res: Response, existing: { id: string; matched_order_id: string | null }, transactionRef: string | null, receivedAt: string) {
  const requiresManualApproval = existing.matched_order_id ? await requiresManualApprovalFor(existing.matched_order_id) : false;
  const orderAlreadyCompleted = existing.matched_order_id ? await orderAlreadyFulfilled(existing.matched_order_id) : false;
  if (existing.matched_order_id) {
    const order = await queryOne<OrderMatch>(
      `SELECT id, sender_phone, receiver_phone, amount, company_id FROM orders WHERE id=$1`,
      [existing.matched_order_id]
    );
    if (order) {
      await logPaymentActivity({
        action: "payment_already_processed",
        smsLogId: existing.id,
        order,
        transactionRef,
        paymentTimestamp: receivedAt,
        status: "already_processed",
      });
    }
  }
  sendJson(res, 200, {
    id: existing.id,
    matchedOrderId: existing.matched_order_id,
    requiresManualApproval,
    duplicate: true,
    orderAlreadyCompleted,
    status: "already_processed",
  });
}

smsLogsRouter.post("/agent/sms-logs", requireAuth("agent"), async (req, res) => {
  const { sender, body, parsedProvider, parsedAmount, parsedPhone, receivedAt, transactionRef } = req.body;
  if (!sender || !body) return sendJson(res, 400, { error: "sender and body are required" });

  const effectiveReceivedAt = receivedAt ?? new Date().toISOString();

  // A telecom's own per-transaction reference code (e.g. Somtel eDahab's
  // "Aqanoosiga" field) is a stronger, authoritative duplicate-payment
  // signal than the sender+body+minute heuristic below — check it first so
  // the exact same real-world payment is rejected as "Already Processed"
  // even if its message body text ever varies slightly between deliveries
  // (a redelivered broadcast, an OEM quirk, a manual re-scan of the inbox).
  if (transactionRef) {
    const existingByRef = await queryOne<{ id: string; matched_order_id: string | null }>(
      `SELECT id, matched_order_id FROM sms_logs WHERE transaction_ref=$1 LIMIT 1`,
      [transactionRef]
    );
    if (existingByRef) return respondAlreadyProcessed(res, existingByRef, transactionRef, effectiveReceivedAt);
  }

  const match = await findMatchingOrder(parsedAmount, parsedPhone);
  const id = randomUUID();
  // Resolved once in JS (rather than left to SQL's now()) so the dedup
  // lookup below, if the insert conflicts, checks the exact same instant
  // the failed insert attempted — not a fresh now() that could land in a
  // different truncated minute than the row that actually won.
  try {
    await query(
      `INSERT INTO sms_logs (id, agent_id, sender, body, parsed_provider, parsed_amount, parsed_phone, matched_order_id, received_at, transaction_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, req.auth!.sub, sender, body, parsedProvider ?? null, parsedAmount ?? null, parsedPhone ?? null, match?.id ?? null, effectiveReceivedAt, transactionRef ?? null]
    );
  } catch (err: any) {
    if (err?.code !== "23505") throw err;
    // A redelivered SMS broadcast (or a client retry after a dropped
    // response) hit a dedup index — return the log that already exists
    // instead of creating a second one, so the same payment never gets
    // matched/dialed twice. Try the transaction_ref index first (more
    // specific), falling back to the sender+body+minute index.
    const existing =
      (transactionRef &&
        (await queryOne<{ id: string; matched_order_id: string | null }>(
          `SELECT id, matched_order_id FROM sms_logs WHERE transaction_ref=$1 LIMIT 1`,
          [transactionRef]
        ))) ||
      (await queryOne<{ id: string; matched_order_id: string | null }>(
        `SELECT id, matched_order_id FROM sms_logs
         WHERE sender=$1 AND body=$2
           AND date_trunc('minute', received_at AT TIME ZONE 'UTC') = date_trunc('minute', $3::timestamptz AT TIME ZONE 'UTC')
         LIMIT 1`,
        [sender, body, effectiveReceivedAt]
      ));
    if (existing) return respondAlreadyProcessed(res, existing, transactionRef ?? null, effectiveReceivedAt);
    throw err;
  }

  // A company with automation off means the agent must tap through the
  // existing manual verify-payment flow instead of the app auto-dialing.
  const requiresManualApproval = match ? await requiresManualApprovalFor(match.id) : false;

  if (match) {
    await logPaymentActivity({
      action: "payment_verified",
      smsLogId: id,
      order: match,
      transactionRef: transactionRef ?? null,
      paymentTimestamp: effectiveReceivedAt,
      status: "verified",
    });
  }

  sendJson(res, 201, { id, matchedOrderId: match?.id ?? null, requiresManualApproval, duplicate: false, status: "new" });
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

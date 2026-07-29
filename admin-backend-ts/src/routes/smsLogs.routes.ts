import { Router, Response } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { createPaymentTransaction } from "../utils/paymentTransactions.js";
import { broadcast } from "../realtime/orderEvents.js";

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
  requiresManualApproval?: boolean;
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
      // "verified" here only ever means "this SMS matched an order" — it
      // does NOT mean the automatic verify->generate->dial pipeline ran.
      // Without this flag, "Payment verified" reads as "fully processed",
      // which is exactly the confusion behind more than one "payment
      // confirmed but USSD never sent" report: the provider's Automatic
      // Processing toggle was off, so nothing further happens until an
      // agent manually taps Verify Payment.
      requiresManualApproval: params.requiresManualApproval ?? false,
    },
  });
}

async function respondAlreadyProcessed(
  res: Response,
  existing: { id: string; matched_order_id: string | null },
  transactionRef: string | null,
  receivedAt: string,
  parsedPhone?: string,
  parsedAmount?: number
) {
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
        requiresManualApproval,
      });
    }
  }
  // A distinct ledger row for THIS blocked attempt (not the original), so
  // the payment_transactions table shows both the real payment and every
  // re-delivery/retry that was correctly rejected — the audit trail
  // requirement 5 asks for, and direct evidence the guarantee held.
  await createPaymentTransaction({
    smsLogId: existing.id,
    orderId: existing.matched_order_id,
    transactionRef,
    customerPhone: parsedPhone ?? null,
    amount: parsedAmount ?? null,
    paymentTimestamp: receivedAt,
    status: "duplicate_blocked",
  });
  broadcast({ type: "sms_log.created", smsLogId: existing.id, orderId: existing.matched_order_id });
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
    if (existingByRef) return respondAlreadyProcessed(res, existingByRef, transactionRef, effectiveReceivedAt, parsedPhone, parsedAmount);
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
    if (existing) return respondAlreadyProcessed(res, existing, transactionRef ?? null, effectiveReceivedAt, parsedPhone, parsedAmount);
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
      requiresManualApproval,
    });
  }

  // The ledger row for this genuinely-new payment attempt — 'pending' until
  // the Agent App's verify-payment/dial-attempt calls advance it. sms_logs'
  // own unique indexes (checked above) already guarantee this transactionRef
  // is new, so this insert always succeeds here — a null return would only
  // mean a narrow, effectively-impossible race, logged rather than crashing.
  await createPaymentTransaction({
    smsLogId: id,
    orderId: match?.id ?? null,
    transactionRef: transactionRef ?? null,
    customerPhone: parsedPhone ?? null,
    amount: parsedAmount ?? null,
    paymentTimestamp: effectiveReceivedAt,
    status: "pending",
  });

  broadcast({ type: "sms_log.created", smsLogId: id, orderId: match?.id ?? null });
  sendJson(res, 201, { id, matchedOrderId: match?.id ?? null, requiresManualApproval, duplicate: false, status: "new" });
});

smsLogsRouter.get("/admin/sms-logs", requireStaff(), async (req, res) => {
  const { agentId, matched, companyId, search, dateFrom, dateTo, limit } = req.query as Record<string, string | undefined>;
  let sql = `
    SELECT sl.*, o.company_id AS matched_company_id
    FROM sms_logs sl
    LEFT JOIN orders o ON o.id = sl.matched_order_id
    WHERE 1=1`;
  const args: unknown[] = [];
  if (agentId) { args.push(agentId); sql += ` AND sl.agent_id=$${args.length}`; }
  if (matched === "true") sql += ` AND sl.matched_order_id IS NOT NULL`;
  if (matched === "false") sql += ` AND sl.matched_order_id IS NULL`;
  if (companyId) { args.push(companyId); sql += ` AND o.company_id=$${args.length}`; }
  if (search) {
    args.push(`%${search}%`);
    const p = args.length;
    sql += ` AND (sl.sender ILIKE $${p} OR sl.body ILIKE $${p} OR sl.parsed_phone ILIKE $${p} OR sl.transaction_ref ILIKE $${p})`;
  }
  if (dateFrom) { args.push(dateFrom); sql += ` AND sl.received_at >= $${args.length}`; }
  if (dateTo) { args.push(dateTo); sql += ` AND sl.received_at <= $${args.length}`; }
  // Was fully unbounded before — cap at a generous default so this can't
  // choke on an ever-growing table; existing callers that pass no ?limit
  // see no change unless they already had more than 200 rows to show.
  const cappedLimit = Math.min(Number(limit) || 200, 1000);
  sql += ` ORDER BY sl.received_at DESC LIMIT ${cappedLimit}`;
  sendJson(res, 200, await query(sql, args));
});

// The duplicate-prevention ledger's read side — search/filter/sort for the
// Payment Transactions dashboard panel. Joined to companies/agent_devices
// for display names rather than making the dashboard do a second round-trip.
smsLogsRouter.get("/admin/payment-transactions", requireStaff(), async (req, res) => {
  const { status, search, companyId, deviceId, simSlot, dateFrom, dateTo, limit, offset } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `
    SELECT pt.*, o.company_id AS order_company_id, c.name AS provider_name, d.name AS device_name
    FROM payment_transactions pt
    LEFT JOIN orders o ON o.id = pt.order_id
    LEFT JOIN companies c ON c.id = o.company_id
    LEFT JOIN agent_devices d ON d.id = pt.agent_device_id
    WHERE 1=1`;
  if (status) { args.push(status); sql += ` AND pt.status=$${args.length}`; }
  if (companyId) { args.push(companyId); sql += ` AND o.company_id=$${args.length}`; }
  if (deviceId) { args.push(deviceId); sql += ` AND pt.agent_device_id=$${args.length}`; }
  if (simSlot) { args.push(Number(simSlot)); sql += ` AND pt.sim_slot=$${args.length}`; }
  if (dateFrom) { args.push(dateFrom); sql += ` AND pt.created_at >= $${args.length}`; }
  if (dateTo) { args.push(dateTo); sql += ` AND pt.created_at <= $${args.length}`; }
  if (search) {
    args.push(`%${search}%`);
    const p = args.length;
    sql += ` AND (pt.customer_phone ILIKE $${p} OR pt.transaction_ref ILIKE $${p} OR pt.order_id ILIKE $${p})`;
  }
  // Default stays 500 — same as before this endpoint took a ?limit param —
  // so a caller that never passes one sees identical behavior.
  const cappedLimit = Math.min(Number(limit) || 500, 2000);
  args.push(cappedLimit);
  sql += ` ORDER BY pt.created_at DESC LIMIT $${args.length}`;
  if (offset) { args.push(Number(offset)); sql += ` OFFSET $${args.length}`; }
  sendJson(res, 200, await query(sql, args));
});

// "Stuck" is precise, not a guess: payment_transactions.status only ever
// leaves 'pending' when a dial attempt is actually logged (markPaymentProcessing,
// called from POST /agent/orders/:id/dial-attempts). So a transaction still
// 'pending' while its order has already flipped to 'in_progress' (proving
// verify-payment succeeded) means the automatic dial never happened — the
// exact failure mode this endpoint surfaces for the dashboard.
smsLogsRouter.get("/admin/payment-transactions/stuck-count", requireStaff(), async (req, res) => {
  const thresholdMinutes = Math.min(Number(req.query.minutes) || 5, 1440);
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM payment_transactions pt
     JOIN orders o ON o.id = pt.order_id
     WHERE pt.status = 'pending' AND o.status = 'in_progress'
       AND pt.created_at < now() - ($1 || ' minutes')::interval`,
    [thresholdMinutes]
  );
  sendJson(res, 200, { count: Number(row?.count ?? 0), thresholdMinutes });
});

// Full chronological trace for one payment: the matched SMS, every dial
// attempt for its order (retry history), and the config/audit-log entries
// tied to either the SMS log or the order — activity-log writes elsewhere
// in this codebase key by whichever of the two happened to be in scope at
// the time (payment_verified/payment_already_processed use smsLogId,
// payment_completed uses orderId), so both are checked here.
smsLogsRouter.get("/admin/payment-transactions/:id/timeline", requireStaff(), async (req, res) => {
  const tx = await queryOne<Record<string, unknown>>(
    `SELECT pt.*, o.company_id AS order_company_id, c.name AS provider_name, d.name AS device_name
     FROM payment_transactions pt
     LEFT JOIN orders o ON o.id = pt.order_id
     LEFT JOIN companies c ON c.id = o.company_id
     LEFT JOIN agent_devices d ON d.id = pt.agent_device_id
     WHERE pt.id=$1`,
    [req.params.id]
  );
  if (!tx) return sendJson(res, 404, { error: "Payment transaction not found" });

  const smsLog = tx.sms_log_id ? await queryOne(`SELECT * FROM sms_logs WHERE id=$1`, [tx.sms_log_id]) : null;
  const order = tx.order_id
    ? await queryOne<Record<string, unknown>>(
        `SELECT o.*, cu.name AS customer_name, cu.phone AS customer_phone, p.name AS package_name
         FROM orders o
         JOIN customers cu ON cu.id = o.customer_id
         JOIN packages p ON p.id = o.package_id
         WHERE o.id=$1`,
        [tx.order_id]
      )
    : null;
  // Staff-facing — same PIN-redaction rule as every order response
  // elsewhere: never let the raw ussd_generated column (real PIN inlined)
  // reach a non-agent response.
  if (order) order.ussd_generated = order.ussd_generated_masked ?? null;
  const dialAttempts = tx.order_id
    ? await query(
        `SELECT id, sim_slot, attempt_number, status, response_message, created_at, completed_at,
                COALESCE(ussd_string_masked, '(masked — regenerate to view)') AS ussd_string
         FROM ussd_dial_attempts WHERE order_id=$1 ORDER BY attempt_number ASC`,
        [tx.order_id]
      )
    : [];
  const entityIds = [tx.sms_log_id, tx.order_id].filter((v): v is string => typeof v === "string");
  const activity = entityIds.length
    ? await query(
        `SELECT id, action, entity_type, entity_id, new_value, created_at
         FROM admin_activity_log WHERE entity_id = ANY($1::text[]) ORDER BY created_at ASC`,
        [entityIds]
      )
    : [];

  sendJson(res, 200, { transaction: tx, smsLog, order, dialAttempts, activity });
});

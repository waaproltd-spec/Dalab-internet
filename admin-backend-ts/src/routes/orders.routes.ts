import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { generateUssdForOrder } from "./ussd.routes.js";
import { subscribe, broadcast } from "../realtime/orderEvents.js";
import { recordActivity } from "../utils/activityLog.js";
import { creditCommissionIfNeeded, reverseCommissionIfNeeded } from "../utils/commissions.js";
import { creditReferralBonusIfNeeded, reverseReferralBonusIfNeeded } from "../utils/referrals.js";
import { isAlreadyCompleted } from "../utils/paymentTransactions.js";

export const ordersRouter = Router();

const ORDER_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];
const MACAASH_POINTS_PER_DOLLAR = 10;

// Schedule Recharge upper bound only — a scheduled fulfillment time must not
// be so far out that it's indistinguishable from never. There is no lower
// bound: a customer picking "now" or any future time is valid, and a
// date/time that's already due (now or in the past) is simply treated as an
// immediate recharge downstream (see isScheduledForLater below and
// runScheduledRechargeSweep) rather than rejected — both the initial pick
// and any later edit are validated against this same bound.
const MAX_SCHEDULE_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

function validateScheduledAt(scheduledAt: unknown): { error?: string; date?: Date } {
  if (scheduledAt == null) return {};
  const date = new Date(scheduledAt as string);
  if (Number.isNaN(date.getTime())) return { error: "scheduledAt is not a valid date/time" };
  const leadMs = date.getTime() - Date.now();
  if (leadMs > MAX_SCHEDULE_LEAD_MS) return { error: "scheduledAt must be within 30 days" };
  return { date };
}

function orderRef(): string {
  return "DLB" + Math.floor(100000000 + Math.random() * 900000000);
}

const ORDER_LIST_SELECT = `
  SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
         co.name AS company_name, co.color_hex AS company_color, p.name AS package_name
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN companies co ON co.id = o.company_id
  JOIN packages p ON p.id = o.package_id`;

async function loadOrder(id: string) {
  return queryOne(`${ORDER_LIST_SELECT} WHERE o.id=$1`, [id]);
}

// ussd_generated carries the provider's plaintext PIN inlined (the Agent
// App needs the real string to dial) — every customer- and admin/staff-
// facing response must show ussd_generated_masked instead. Agent-facing
// routes intentionally never call this and keep the raw field.
function maskOrder<T extends Record<string, any> | undefined | null>(order: T): T {
  if (!order) return order;
  return { ...order, ussd_generated: order.ussd_generated_masked ?? null };
}
function maskOrders<T extends Record<string, any>>(orders: T[]): T[] {
  return orders.map(maskOrder);
}

// ---------------- Customer ----------------
ordersRouter.post("/orders", requireAuth("customer"), async (req, res) => {
  const { companyId, packageId, senderPhone, receiverPhone, paymentMethod, clientRequestId, scheduledAt, useLoyaltyPoints } = req.body;
  const company = await queryOne(`SELECT * FROM companies WHERE id=$1 AND deleted_at IS NULL`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  if (company.status === "offline") return sendJson(res, 409, { error: `${company.name} is currently offline` });

  const pkg = await queryOne(`SELECT * FROM packages WHERE id=$1 AND active=true`, [packageId]);
  if (!pkg) return sendJson(res, 404, { error: "Package not found" });
  if (pkg.company_id !== companyId) {
    return sendJson(res, 400, { error: "Package does not belong to the selected company" });
  }

  const scheduleCheck = validateScheduledAt(scheduledAt);
  if (scheduleCheck.error) return sendJson(res, 400, { error: scheduleCheck.error });

  const customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [req.auth!.sub]);

  // Loyalty Points discount: reduces only the customer's payment amount
  // (what gets collected via USSD), never provider_amount — the package
  // itself, and what the provider is paid to deliver it, is unaffected; the
  // customer is simply subsidizing part of their own payment with points
  // they already earned. Points are debited immediately at order creation
  // (the whole point of "spending" them), not deferred to completion.
  let pointsToUse = 0;
  let finalAmount = Number(pkg.price);
  if (useLoyaltyPoints != null) {
    if (typeof useLoyaltyPoints !== "number" || !Number.isInteger(useLoyaltyPoints) || useLoyaltyPoints < 0) {
      return sendJson(res, 400, { error: "useLoyaltyPoints must be a non-negative integer" });
    }
    if (useLoyaltyPoints > (customer?.macaash_points ?? 0)) {
      return sendJson(res, 400, { error: "You don't have enough Loyalty Points" });
    }
    if (useLoyaltyPoints > 0) {
      const rule = await queryOne<{ points_per_dollar_discount: number }>(`SELECT points_per_dollar_discount FROM referral_reward_rules LIMIT 1`);
      const pointsPerDollar = rule?.points_per_dollar_discount ?? 100;
      const requestedDiscount = useLoyaltyPoints / pointsPerDollar;
      const cappedDiscount = Math.min(requestedDiscount, Number(pkg.price));
      pointsToUse = Math.round(cappedDiscount * pointsPerDollar); // only debit points actually applied, if capped
      finalAmount = Math.round((Number(pkg.price) - cappedDiscount) * 100) / 100;
    }
  }

  const id = orderRef();
  try {
    await query(
      `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, sender_phone, receiver_phone, payment_method, channel, macaash_earned, client_request_id, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,'android',$10,$11,$12)`,
      [
        id, req.auth!.sub, companyId, packageId, finalAmount, pkg.provider_amount ?? pkg.price,
        senderPhone || customer?.phone || null,
        receiverPhone || customer?.phone || null,
        paymentMethod || company.gateway || null,
        Math.round(finalAmount * MACAASH_POINTS_PER_DOLLAR),
        clientRequestId ?? null,
        scheduleCheck.date ?? null,
      ]
    );
    if (pointsToUse > 0) {
      await query(
        `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason, kind) VALUES ($1,$2,$3,$4,$5,'redeemed')`,
        [randomUUID(), req.auth!.sub, id, -pointsToUse, `Redeemed for a discount on order ${id}`]
      );
      await query(`UPDATE customers SET macaash_points = GREATEST(0, macaash_points - $1) WHERE id=$2`, [pointsToUse, req.auth!.sub]);
    }
  } catch (err: any) {
    if (err?.code !== "23505") throw err;
    if (err?.constraint === "idx_orders_client_request_id") {
      // A retried create (e.g. from the offline queue) with the same
      // clientRequestId — the original attempt already went through, so
      // return the existing order instead of creating a second one.
      const existing = await queryOne<{ id: string }>(`SELECT id FROM orders WHERE client_request_id=$1`, [clientRequestId]);
      return sendJson(res, 200, maskOrder(await loadOrder(existing!.id)));
    }
    if (err?.constraint === "idx_orders_pending_content_dedup") {
      // Same customer already has a pending, non-scheduled order for this
      // exact company+package+amount (e.g. re-visiting Checkout without
      // paying) — reuse it instead of creating a duplicate sibling order
      // that a future payment could otherwise leave stranded.
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM orders WHERE customer_id=$1 AND company_id=$2 AND package_id=$3 AND amount=$4 AND status='pending' AND scheduled_at IS NULL`,
        [req.auth!.sub, companyId, packageId, finalAmount]
      );
      if (existing) return sendJson(res, 200, maskOrder(await loadOrder(existing.id)));
    }
    throw err;
  }
  broadcast({ type: "order.created", orderId: id });
  sendJson(res, 201, maskOrder(await loadOrder(id)));
});

ordersRouter.get("/orders", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `SELECT o.*, co.name AS company_name, p.name AS package_name
     FROM orders o JOIN companies co ON co.id=o.company_id JOIN packages p ON p.id=o.package_id
     WHERE o.customer_id=$1 ORDER BY o.created_at DESC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, maskOrders(rows));
});

// Real-time order feed for the Customer App — same subscribe/broadcast
// pub/sub already powering /agent/orders/stream and /admin/orders/stream.
// Registered before "/orders/:id" so "stream" isn't swallowed as an :id
// param. The broadcast payload is just {type, orderId} regardless of role,
// so no server-side filtering by customer is needed — the app already
// re-fetches its own order(s) by id on any event rather than trusting the
// event payload.
ordersRouter.get("/orders/stream", requireAuth("customer"), async (req, res) => {
  const unsubscribe = subscribe(res);
  req.on("close", unsubscribe);
});

ordersRouter.get("/orders/:id", requireAuth("customer"), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order || (order as any).customer_id !== req.auth!.sub) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, maskOrder(order));
});

// A scheduled recharge can only be edited/cancelled by its own customer,
// and only while it's genuinely still pending fulfillment -- once
// ussd_generated is set (by the sweep or, for a non-scheduled order,
// verify-payment itself) it's too late to change the plan, and a second
// cancellation request can't be filed on top of one already awaiting review.
async function loadEditableScheduledOrder(orderId: string, customerId: string) {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  if (!order || order.customer_id !== customerId) return { error: 404 as const };
  if (!order.scheduled_at || order.ussd_generated || order.cancellation_requested_at) {
    return { error: 409 as const };
  }
  return { order };
}

ordersRouter.put("/orders/:id/schedule", requireAuth("customer"), async (req, res) => {
  const found = await loadEditableScheduledOrder(req.params.id, req.auth!.sub);
  if (found.error === 404) return sendJson(res, 404, { error: "Order not found" });
  if (found.error === 409) return sendJson(res, 409, { error: "This order's schedule can no longer be edited" });

  const scheduleCheck = validateScheduledAt(req.body.scheduledAt);
  if (scheduleCheck.error || !scheduleCheck.date) {
    return sendJson(res, 400, { error: scheduleCheck.error ?? "scheduledAt is required" });
  }
  await query(`UPDATE orders SET scheduled_at=$1, updated_at=now() WHERE id=$2`, [scheduleCheck.date, req.params.id]);
  broadcast({ type: "order.updated", orderId: req.params.id });
  sendJson(res, 200, maskOrder(await loadOrder(req.params.id)));
});

ordersRouter.post("/orders/:id/request-cancellation", requireAuth("customer"), async (req, res) => {
  const found = await loadEditableScheduledOrder(req.params.id, req.auth!.sub);
  if (found.error === 404) return sendJson(res, 404, { error: "Order not found" });
  if (found.error === 409) return sendJson(res, 409, { error: "This order's schedule can no longer be cancelled" });

  await query(`UPDATE orders SET cancellation_requested_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: undefined,
    action: "schedule_cancellation_requested",
    entityType: "order",
    entityId: req.params.id,
    oldValue: null,
    newValue: { scheduledAt: found.order.scheduled_at },
  });
  broadcast({ type: "order.updated", orderId: req.params.id });
  sendJson(res, 200, maskOrder(await loadOrder(req.params.id)));
});

// ---------------- Agent ----------------

// Agent-initiated sale — same validation/pricing/Macaash logic as the
// customer-initiated POST /orders above, but the customer is identified by
// phone (looked up or created on the spot, same as OTP verify does) since
// the agent — not the customer — is the one authenticated here.
ordersRouter.post("/agent/orders", requireAuth("agent"), async (req, res) => {
  const { customerPhone, companyId, packageId, receiverPhone, paymentMethod, clientRequestId } = req.body;
  const phone = String(customerPhone ?? "").trim();
  if (!/^\+?\d{6,15}$/.test(phone)) return sendJson(res, 400, { error: "Provide a valid customer phone number" });

  const company = await queryOne(`SELECT * FROM companies WHERE id=$1 AND deleted_at IS NULL`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  if (company.status === "offline") return sendJson(res, 409, { error: `${company.name} is currently offline` });

  const pkg = await queryOne(`SELECT * FROM packages WHERE id=$1 AND active=true`, [packageId]);
  if (!pkg) return sendJson(res, 404, { error: "Package not found" });
  if (pkg.company_id !== companyId) {
    return sendJson(res, 400, { error: "Package does not belong to the selected company" });
  }

  let customer = await queryOne(`SELECT * FROM customers WHERE phone=$1`, [phone]);
  if (!customer) {
    customer = await queryOne(`INSERT INTO customers (id, phone) VALUES ($1,$2) RETURNING *`, [randomUUID(), phone]);
  }
  if (customer!.status === "blocked") return sendJson(res, 403, { error: "This customer's account has been blocked" });

  const id = orderRef();
  try {
    await query(
      `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, sender_phone, receiver_phone, payment_method, channel, agent_id, macaash_earned, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,'agent',$10,$11,$12)`,
      [
        id, customer!.id, companyId, packageId, pkg.price, pkg.provider_amount ?? pkg.price,
        phone,
        receiverPhone || phone,
        paymentMethod || company.gateway || null,
        req.auth!.sub,
        Math.round(pkg.price * MACAASH_POINTS_PER_DOLLAR),
        clientRequestId ?? null,
      ]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_orders_client_request_id") throw err;
    const existing = await queryOne<{ id: string }>(`SELECT id FROM orders WHERE client_request_id=$1`, [clientRequestId]);
    return sendJson(res, 200, await loadOrder(existing!.id));
  }
  broadcast({ type: "order.created", orderId: id });
  sendJson(res, 201, await loadOrder(id));
});

ordersRouter.get("/agent/orders", requireAuth("agent"), async (req, res) => {
  const { status } = req.query;
  const rows = status
    ? await query(`${ORDER_LIST_SELECT} WHERE o.status=$1 ORDER BY o.created_at DESC`, [status])
    : await query(`${ORDER_LIST_SELECT} ORDER BY o.created_at DESC`);
  sendJson(res, 200, rows);
});

// Real-time order feed for the Agent App — replaces the old dead-code
// WebSocket client. Registered before "/agent/orders/:id" so "stream" isn't
// swallowed as an :id param.
ordersRouter.get("/agent/orders/stream", requireAuth("agent"), async (req, res) => {
  const unsubscribe = subscribe(res);
  req.on("close", unsubscribe);
});

// Self-heal target list for the Agent App: an order that reached in_progress
// with a USSD string generated, but whose payment_transactions row is still
// 'pending' -- meaning no dial attempt has EVER started for it (markPaymentProcessing
// only flips it to 'processing', called exclusively from POST .../dial-attempts).
// This is the exact same "stuck" predicate GET /admin/payment-transactions/stuck-count
// already uses, just filtered to what's now actually actionable (a USSD string
// exists) rather than every possible cause — this is what lets an order that
// failed generation get auto-dialed the moment a Super Admin fixes the
// underlying template/PIN, with zero manual "Dial Now" tap required.
// Registered before "/agent/orders/:id" so "self-heal-candidates" isn't
// swallowed as an :id param (same reasoning as "/agent/orders/stream" above).
ordersRouter.get("/agent/orders/self-heal-candidates", requireAuth("agent"), async (_req, res) => {
  const rows = await query(
    `${ORDER_LIST_SELECT}
     WHERE o.status='in_progress' AND o.ussd_generated IS NOT NULL
       AND EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.order_id = o.id AND pt.status='pending')
     ORDER BY o.updated_at ASC`
  );
  sendJson(res, 200, rows);
});

ordersRouter.get("/agent/orders/:id", requireAuth("agent"), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, order);
});

ordersRouter.post("/agent/orders/:id/verify-payment", requireAuth("agent"), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });

  // Atomic compare-and-swap: only ever one caller of two concurrent/retried
  // requests actually flips pending -> in_progress, so USSD generation can
  // never be double-triggered for the same order.
  const result = await query(
    `UPDATE orders SET status='in_progress', agent_id=$1, updated_at=now() WHERE id=$2 AND status='pending' RETURNING id`,
    [req.auth!.sub, order.id]
  );
  if (result.length === 0) {
    // Already verified by this or a concurrent request — idempotent no-op,
    // return current state rather than erroring a retrying client.
    if (order.status !== "pending") return sendJson(res, 200, await loadOrder(order.id));
    return sendJson(res, 409, { error: `Cannot verify an order in status '${order.status}'` });
  }

  if (req.body.smsLogId) {
    await query(`UPDATE sms_logs SET matched_order_id=$1 WHERE id=$2`, [order.id, req.body.smsLogId]);
  }
  // Order approved — auto-generate the USSD dialer string. A missing PIN or
  // template isn't fatal to the approval itself; ussd_generated just stays
  // null until an admin sets one up, visible on the order detail either way.
  // The failure reason (if any) is persisted rather than discarded, so a
  // stuck order (verified, in_progress, never dialed) shows WHY instead of
  // looking identical to any other kind of stall.
  //
  // Schedule Recharge: a future scheduled_at means the customer has already
  // paid (this verify-payment call is unaffected) but explicitly asked for
  // fulfillment to wait -- so generateUssdForOrder is deliberately skipped
  // here and left for runScheduledRechargeSweep() to call once that time
  // arrives. ussd_generated stays null in the meantime, which already keeps
  // this order invisible to the self-heal-candidates predicate below (it
  // requires ussd_generated IS NOT NULL) -- no other change needed to avoid
  // an early/duplicate dial.
  const isScheduledForLater = order.scheduled_at && new Date(order.scheduled_at).getTime() > Date.now();
  if (!isScheduledForLater) {
    const genResult = await generateUssdForOrder(order);
    await query(`UPDATE orders SET ussd_generation_failed_reason=$1 WHERE id=$2`, [genResult.error ?? null, order.id]);
    if (genResult.error) {
      // This is what makes the failure visible in the Activity Log panel —
      // previously it only reached orders.ussd_generation_failed_reason,
      // reachable only via one specific transaction's timeline modal.
      await recordActivity({
        adminId: undefined,
        action: "ussd_generation_failed",
        entityType: "order",
        entityId: order.id,
        oldValue: null,
        newValue: { reason: genResult.error, companyId: order.company_id, packageId: order.package_id },
      });
    }
  }
  broadcast({ type: "order.updated", orderId: order.id });
  sendJson(res, 200, await loadOrder(order.id));
});

async function creditMacaashIfNeeded(order: any) {
  if (order.macaash_earned > 0) {
    try {
      await query(
        `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason, kind) VALUES ($1,$2,$3,$4,$5,'earn')`,
        [randomUUID(), order.customer_id, order.id, order.macaash_earned, `Earned from order ${order.id}`]
      );
    } catch (err: any) {
      if (err?.code !== "23505" || err?.constraint !== "idx_macaash_tx_order_earn") throw err;
      return; // already credited by a concurrent/retried call — no-op
    }
    await query(`UPDATE customers SET macaash_points = macaash_points + $1 WHERE id=$2`, [order.macaash_earned, order.customer_id]);
  }
}

/**
 * Atomic in_progress -> completed transition, shared by the agent's own
 * "mark complete" tap (after a successful USSD dial response) and the
 * voucher-confirmation endpoint below (a second, independent signal: the
 * carrier's own SMS confirming the agent's SIM sent the top-up). Either
 * signal can complete the order first; whichever loses the race just gets
 * 0 rows back from the guarded UPDATE and is treated as a no-op, not an error.
 */
async function completeOrderById(orderId: string): Promise<{ order: any; alreadyCompleted: boolean } | null> {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  if (!order) return null;

  const result = await query(
    `UPDATE orders SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1 AND status='in_progress' RETURNING id`,
    [orderId]
  );
  if (result.length === 0) {
    return { order, alreadyCompleted: order.status === "completed" };
  }
  await creditMacaashIfNeeded(order);
  await creditCommissionIfNeeded(order);
  await creditReferralBonusIfNeeded(order);
  broadcast({ type: "order.updated", orderId });
  await recordActivity({
    adminId: undefined,
    action: "payment_completed",
    entityType: "payment_transaction",
    entityId: order.id,
    oldValue: null,
    newValue: {
      orderId: order.id,
      senderPhone: order.sender_phone,
      receiverPhone: order.receiver_phone,
      amount: order.amount,
      provider: order.company_id,
      transactionRef: null,
      paymentTimestamp: new Date().toISOString(),
      status: "completed",
    },
  });
  return { order, alreadyCompleted: false };
}

ordersRouter.post("/agent/orders/:id/complete", requireAuth("agent"), async (req, res) => {
  const result = await completeOrderById(req.params.id);
  if (!result) return sendJson(res, 404, { error: "Order not found" });
  if (result.order.status !== "completed" && !result.alreadyCompleted) {
    return sendJson(res, 409, { error: "Order must be in progress before it can be completed" });
  }
  sendJson(res, 200, await loadOrder(req.params.id));
});

/** Same last-9-digit comparison smsLogs.routes.ts's findMatchingOrder uses —
 * Somali phone numbers legitimately appear with/without the 252 country
 * code or a leading 0. */
function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

/**
 * Flow 2's second half: the agent's own SIM sent a top-up/voucher to the
 * customer, and the carrier confirmed it back to the agent's phone (e.g.
 * Hormuud's "[-E-Voucher-] You have transferred $X to Y" from sender 740) —
 * a corroborating signal alongside the USSD dial's own on-screen response,
 * since some OEM/carrier USSD response callbacks are unreliable or generic.
 * Matches the most recently updated in_progress order for this receiver
 * phone + amount and completes it the same atomic way the agent's own
 * "mark complete" tap does; a redundant or unmatched confirmation is not an
 * error — nothing to complete just means this device's own top-up already
 * completed the order (or this SMS doesn't correspond to a DALAB order).
 */
ordersRouter.post("/agent/orders/voucher-confirmation", requireAuth("agent"), async (req, res) => {
  const { receiverPhone, amount } = req.body;
  if (!receiverPhone || amount == null) {
    return sendJson(res, 400, { error: "receiverPhone and amount are required" });
  }
  const target = normalizePhone(receiverPhone);
  if (!target) return sendJson(res, 400, { error: "receiverPhone is not a valid phone number" });

  // Oldest-first + row-locked, mirroring findMatchingOrder's rationale in
  // smsLogs.routes.ts: when several in_progress siblings exist for the same
  // amount+phone, the carrier's confirmation should complete whichever was
  // claimed first, and FOR UPDATE SKIP LOCKED keeps two concurrent carrier
  // confirmations from both landing on the same in-flight candidate.
  const candidates = await withTransaction((client) =>
    client
      .query<{ id: string; receiver_phone: string | null }>(
        `SELECT id, receiver_phone FROM orders WHERE status='in_progress' AND ABS(amount - $1) < 0.01
         ORDER BY updated_at ASC
         FOR UPDATE SKIP LOCKED`,
        [amount]
      )
      .then((r) => r.rows)
  );
  const match = candidates.find((o) => normalizePhone(o.receiver_phone) === target);
  if (!match) return sendJson(res, 200, { matched: false });

  const result = await completeOrderById(match.id);
  sendJson(res, 200, { matched: true, orderId: match.id, alreadyCompleted: result?.alreadyCompleted ?? false });
});

ordersRouter.get("/agent/transactions", requireAuth("agent"), async (req, res) => {
  // customers.name is nullable (a customer who registered via OTP but never
  // set one) — the Agent App's Transaction.customerName is a non-null Kotlin
  // field, and Gson silently assigns null to it instead of erroring, which
  // crashed the app the moment that row rendered. Coalescing to phone here
  // means this column is never actually null over the wire.
  const rows = await query(
    `SELECT o.id AS order_id, COALESCE(c.name, c.phone) AS customer_name, co.name AS company_name, o.amount, o.completed_at
     FROM orders o JOIN customers c ON c.id=o.customer_id JOIN companies co ON co.id=o.company_id
     WHERE o.agent_id=$1 AND o.status='completed' ORDER BY o.completed_at DESC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

// ---------------- Admin/Staff: Orders Management ----------------
ordersRouter.get("/admin/orders", requireStaff(), async (req, res) => {
  const { status, companyId, search, dateFrom, dateTo } = req.query as Record<string, string | undefined>;
  let sql = `${ORDER_LIST_SELECT} WHERE 1=1`;
  const args: unknown[] = [];
  if (status) { args.push(status); sql += ` AND o.status=$${args.length}`; }
  if (companyId) { args.push(companyId); sql += ` AND o.company_id=$${args.length}`; }
  if (dateFrom) { args.push(dateFrom); sql += ` AND o.created_at >= $${args.length}`; }
  if (dateTo) { args.push(dateTo); sql += ` AND o.created_at <= $${args.length}`; }
  if (search) {
    args.push(`%${search}%`);
    const idx = args.length;
    sql += ` AND (o.id ILIKE $${idx} OR c.name ILIKE $${idx} OR o.sender_phone ILIKE $${idx} OR o.receiver_phone ILIKE $${idx} OR c.phone ILIKE $${idx})`;
  }
  sql += ` ORDER BY o.created_at DESC`;
  sendJson(res, 200, maskOrders(await query(sql, args)));
});

ordersRouter.get("/admin/orders/counts", requireStaff(), async (req, res) => {
  const { companyId } = req.query;
  const rows = companyId
    ? await query(`SELECT status, COUNT(*) AS n FROM orders WHERE company_id=$1 GROUP BY status`, [companyId])
    : await query(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`);

  const counts = { pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0, all: 0 };
  for (const row of rows as { status: string; n: string }[]) {
    const n = Number(row.n);
    counts.all += n;
    if (row.status === "pending") counts.pending = n;
    else if (row.status === "in_progress") counts.inProgress = n;
    else if (row.status === "completed") counts.completed = n;
    else if (row.status === "failed") counts.failed = n;
    else if (row.status === "cancelled") counts.cancelled = n;
  }
  sendJson(res, 200, counts);
});

// Real-time order feed for the Super Admin dashboard — replaces its 8s
// setInterval poll. Registered before "/admin/orders/:id" so "stream" isn't
// swallowed as an :id param.
ordersRouter.get("/admin/orders/stream", requireStaff(), async (req, res) => {
  const unsubscribe = subscribe(res);
  req.on("close", unsubscribe);
});

// Schedule Recharge cancellation review list (Super Admin only) — same
// "register before :id" reasoning as "/admin/orders/stream" above, since
// this is also exactly 3 path segments and would otherwise be swallowed as
// an :id param by the route below.
ordersRouter.get("/admin/orders/scheduled-cancellations", requireAuth("super_admin"), async (_req, res) => {
  const rows = await query(
    `${ORDER_LIST_SELECT} WHERE o.cancellation_requested_at IS NOT NULL AND o.cancellation_decision IS NULL
     ORDER BY o.cancellation_requested_at ASC`
  );
  sendJson(res, 200, maskOrders(rows));
});

// Manual Recovery: a coded, human-readable reason for exactly why one order
// is stuck, derived entirely from signals that already exist elsewhere in
// this codebase (payment_transactions, ussd_generation_failed_reason, the
// latest dial attempt's own response_message, and the responsible device's
// heartbeat staleness — the same check delivery-status already makes) —
// never a fabricated status, always read from real state. Returns null when
// the order isn't actually stuck by any of these signals (e.g. a payment
// hasn't even been matched yet), which the caller uses to exclude it.
async function classifyStuckReason(order: any): Promise<string | null> {
  if (order.status === "pending") {
    const hasPayment = await queryOne(`SELECT id FROM payment_transactions WHERE order_id=$1 LIMIT 1`, [order.id]);
    return hasPayment ? "payment_verification_waiting" : null;
  }
  if (order.status !== "in_progress") return null;

  if (!order.ussd_generated) return "ussd_generation_failed";

  const lastAttempt = await queryOne<{ status: string; response_message: string | null }>(
    `SELECT status, response_message FROM ussd_dial_attempts WHERE order_id=$1 ORDER BY attempt_number DESC LIMIT 1`,
    [order.id]
  );
  if (lastAttempt && lastAttempt.status === "failed") {
    const msg = (lastAttempt.response_message ?? "").toLowerCase();
    if (msg.includes("sim")) return "sim_not_available";
    if (msg.includes("network") || msg.includes("timeout") || msg.includes("connection")) return "internet_error";
    return "server_timeout";
  }

  const device = await queryOne<{ last_heartbeat_at: string | null }>(
    `SELECT d.last_heartbeat_at FROM sim_routing sr JOIN agent_devices d ON d.id = sr.device_id
     WHERE sr.company_id=$1 ORDER BY sr.priority ASC LIMIT 1`,
    [order.company_id]
  );
  if (!device) return "sim_not_available";
  const lastHeartbeatAt = device.last_heartbeat_at ? new Date(device.last_heartbeat_at).getTime() : null;
  const stale = lastHeartbeatAt == null || Date.now() - lastHeartbeatAt > DEVICE_STALE_MS;
  return stale ? "agent_offline" : "server_timeout";
}

// Manual Recovery Dashboard: every order that's genuinely stuck (not just
// mid-flight in the normal automatic pipeline — the 5-minute floor gives
// that a fair chance to finish first) and eligible for manual "Send to
// Agent" recovery. Registered before the "/:id" route below for the same
// reason every other literal-path route above already is.
ordersRouter.get("/admin/orders/pending-recovery", requireStaff(), async (_req, res) => {
  const candidates = await query<any>(
    `${ORDER_LIST_SELECT}
     WHERE o.status IN ('pending','in_progress')
       AND o.created_at < now() - interval '5 minutes'
       AND o.cancellation_requested_at IS NULL
       AND (o.scheduled_at IS NULL OR o.scheduled_at <= now())
     ORDER BY o.created_at ASC
     LIMIT 200`
  );
  const withReasons = await Promise.all(
    candidates.map(async (o) => ({ ...o, stuck_reason: await classifyStuckReason(o) }))
  );
  sendJson(res, 200, maskOrders(withReasons.filter((o) => o.stuck_reason != null)));
});

ordersRouter.get("/admin/orders/:id", requireStaff(), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, maskOrder(order));
});

// For an order that's verified + USSD-generated but has zero dial attempts
// (the "delivering, but nobody's dialed it yet" state) — tells the dashboard
// whether that's because no device is configured to handle this company at
// all, or because the responsible device's heartbeat has gone stale, rather
// than leaving that ambiguous. Same "no heartbeat in >5 min = stale"
// threshold already used by the Devices panel's own staleness badge.
const DEVICE_STALE_MS = 5 * 60 * 1000;

ordersRouter.get("/admin/orders/:id/delivery-status", requireStaff(), async (req, res) => {
  const order = await queryOne(`SELECT company_id FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });

  const devices = await query(
    `SELECT d.name, d.last_heartbeat_at
     FROM sim_routing sr JOIN agent_devices d ON d.id = sr.device_id
     WHERE sr.company_id=$1
     ORDER BY sr.priority ASC`,
    [order.company_id]
  );
  if (devices.length === 0) {
    return sendJson(res, 200, { hasRouting: false, device: null });
  }
  const top = devices[0];
  const lastHeartbeatAt = top.last_heartbeat_at ? new Date(top.last_heartbeat_at) : null;
  const stale = !lastHeartbeatAt || Date.now() - lastHeartbeatAt.getTime() > DEVICE_STALE_MS;
  sendJson(res, 200, {
    hasRouting: true,
    device: { name: top.name, lastHeartbeatAt: top.last_heartbeat_at, stale },
  });
});

ordersRouter.put("/admin/orders/:id/status", requirePermission("orders.manage"), async (req, res) => {
  const { status } = req.body;
  if (!ORDER_STATUSES.includes(status)) return sendJson(res, 400, { error: `status must be one of ${ORDER_STATUSES.join(", ")}` });
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });

  // Only 'completed' (Macaash credit) and 'in_progress' (USSD generation)
  // have a double-fire side effect — guard those two atomically so a
  // duplicate/concurrent call re-setting the same target status is a no-op;
  // other lateral transitions (e.g. failed -> cancelled) have no such risk.
  if (status === "completed") {
    const result = await query(
      `UPDATE orders SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1 AND status != 'completed' RETURNING id`,
      [req.params.id]
    );
    if (result.length > 0) {
      await creditMacaashIfNeeded(order);
      await creditCommissionIfNeeded(order);
      await creditReferralBonusIfNeeded(order);
    }
  } else if (status === "in_progress") {
    const result = await query(
      `UPDATE orders SET status='in_progress', updated_at=now() WHERE id=$1 AND status != 'in_progress' RETURNING id`,
      [req.params.id]
    );
    if (result.length > 0) {
      const genResult = await generateUssdForOrder(order, req.auth!.sub);
      await query(`UPDATE orders SET ussd_generation_failed_reason=$1 WHERE id=$2`, [genResult.error ?? null, req.params.id]);
      if (genResult.error) {
        await recordActivity({
          adminId: req.auth!.sub,
          action: "ussd_generation_failed",
          entityType: "order",
          entityId: req.params.id,
          oldValue: null,
          newValue: { reason: genResult.error, companyId: order.company_id, packageId: order.package_id },
        });
      }
    }
  } else {
    await query(`UPDATE orders SET status=$1, updated_at=now() WHERE id=$2`, [status, req.params.id]);
  }
  broadcast({ type: "order.updated", orderId: req.params.id });
  sendJson(res, 200, maskOrder(await loadOrder(req.params.id)));
});

// Manual Recovery — "Send to Agent". Never creates a new order: this is the
// exact same order row, the same customer, the same package, the same
// verified payment record, moved forward in place. A pending order with a
// matched payment is atomically advanced to in_progress and USSD is
// generated exactly the way verify-payment itself would have; an
// in_progress order that never got its USSD string is regenerated; either
// way, broadcasting order.updated is what actually gets it dialed — the
// Agent App's own self-heal sweep (already triggered by this exact SSE
// event, already idempotent via payment_transactions'/ussd_dial_attempts'
// existing guards) picks it up and dials it, so this endpoint never pushes
// a dial command itself and never duplicates anything already guaranteed
// duplicate-safe elsewhere.
ordersRouter.post("/admin/orders/:id/recover", requirePermission("orders.manage"), async (req, res) => {
  const order = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });

  if (!["pending", "in_progress"].includes(order.status)) {
    return sendJson(res, 409, { error: `Order status '${order.status}' is not eligible for manual recovery.` });
  }
  if (await isAlreadyCompleted(order.id)) {
    return sendJson(res, 409, { error: "This order's payment has already completed — nothing to recover." });
  }
  if (order.cancellation_requested_at) {
    return sendJson(res, 409, { error: "This order has a pending cancellation request — resolve that first." });
  }
  if (order.scheduled_at && new Date(order.scheduled_at).getTime() > Date.now()) {
    return sendJson(res, 409, { error: "This order is scheduled for a future time — it is not stuck." });
  }
  const hasPayment = await queryOne(`SELECT id FROM payment_transactions WHERE order_id=$1 LIMIT 1`, [order.id]);
  if (!hasPayment) {
    return sendJson(res, 400, { error: "No verified payment found for this order — nothing to recover." });
  }

  let genResult: { error?: string } | undefined;
  if (order.status === "pending") {
    const flipped = await query(
      `UPDATE orders SET status='in_progress', updated_at=now() WHERE id=$1 AND status='pending' RETURNING id`,
      [order.id]
    );
    if (flipped.length > 0) {
      genResult = await generateUssdForOrder(order, req.auth!.sub);
      await query(`UPDATE orders SET ussd_generation_failed_reason=$1 WHERE id=$2`, [genResult.error ?? null, order.id]);
    }
  } else if (!order.ussd_generated) {
    genResult = await generateUssdForOrder(order, req.auth!.sub);
    await query(`UPDATE orders SET ussd_generation_failed_reason=$1 WHERE id=$2`, [genResult.error ?? null, order.id]);
  }

  broadcast({ type: "order.updated", orderId: order.id });
  const updated = await loadOrder(order.id);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "manual_recovery_triggered",
    entityType: "order",
    entityId: order.id,
    oldValue: { status: order.status },
    newValue: { status: (updated as any)?.status, ussdGenerationError: genResult?.error ?? null },
  });
  sendJson(res, 200, maskOrder(updated));
});

// Internal bookkeeping reversal only — there is no payment gateway here to
// call for a real refund. Cancels the order and claws back any Macaash
// points already credited via an offsetting negative ledger row (never
// mutates/deletes the original credit row, so history stays intact).
// Shared by the direct admin reversal endpoint below and by the Schedule
// Recharge cancellation-approval endpoint (`POST
// /admin/orders/:id/scheduled-cancellations/approve`), so the Macaash
// clawback logic exists in exactly one place.
async function reverseOrderInternal(orderId: string): Promise<{ ok: boolean; order?: any }> {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  if (!order) return { ok: false };

  const result = await query(
    `UPDATE orders SET status='cancelled', reversed_at=now(), updated_at=now() WHERE id=$1 AND reversed_at IS NULL RETURNING id`,
    [orderId]
  );
  if (result.length === 0) return { ok: false, order };

  const credited = await queryOne<{ id: string; points: number }>(
    `SELECT id, points FROM macaash_transactions WHERE order_id=$1 AND kind='earn'`,
    [orderId]
  );
  if (credited) {
    try {
      await query(
        `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason, kind) VALUES ($1,$2,$3,$4,$5,'reversal')`,
        [randomUUID(), order.customer_id, orderId, -credited.points, `Reversed order ${orderId}`]
      );
      await query(`UPDATE customers SET macaash_points = GREATEST(0, macaash_points - $1) WHERE id=$2`, [credited.points, order.customer_id]);
    } catch (err: any) {
      if (err?.code !== "23505" || err?.constraint !== "idx_macaash_tx_order_reversal") throw err;
      // Already reversed by a concurrent call — the atomic reversed_at guard
      // above should already prevent reaching here twice, but this is a
      // defense-in-depth no-op rather than a 500 if it ever does.
    }
  }
  await reverseCommissionIfNeeded(orderId);
  await reverseReferralBonusIfNeeded(orderId);

  broadcast({ type: "order.updated", orderId });
  return { ok: true, order };
}

ordersRouter.post("/admin/orders/:id/reverse", requirePermission("orders.reverse"), async (req, res) => {
  const result = await reverseOrderInternal(req.params.id);
  if (!result.order) return sendJson(res, 404, { error: "Order not found" });
  if (!result.ok) return sendJson(res, 409, { error: "Order has already been reversed" });
  sendJson(res, 200, maskOrder(await loadOrder(req.params.id)));
});

// ---------------- Schedule Recharge: cancellation review (Super Admin only) ----------------
// A customer's cancellation request never auto-refunds — it's a review item.
// Deliberately requireAuth("super_admin") rather than the delegable
// "orders.reverse" permission a regular Admin could hold: approving/rejecting
// a refund decision must stay Super-Admin-exclusive per explicit instruction.
// (The GET list route lives earlier in this file, before "/admin/orders/:id".)
ordersRouter.post("/admin/orders/:id/scheduled-cancellations/approve", requireAuth("super_admin"), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (!order.cancellation_requested_at || order.cancellation_decision) {
    return sendJson(res, 409, { error: "This order has no pending cancellation request" });
  }

  const reversal = await reverseOrderInternal(req.params.id);
  if (!reversal.ok) return sendJson(res, 409, { error: "Order has already been reversed" });

  await query(
    `UPDATE orders SET cancellation_decision='approved', cancellation_decided_at=now(), cancellation_decided_by=$1, updated_at=now() WHERE id=$2`,
    [req.auth!.sub, req.params.id]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "schedule_cancellation_approved",
    entityType: "order",
    entityId: req.params.id,
    oldValue: null,
    newValue: { scheduledAt: order.scheduled_at },
  });
  broadcast({ type: "order.updated", orderId: req.params.id });
  sendJson(res, 200, maskOrder(await loadOrder(req.params.id)));
});

ordersRouter.post("/admin/orders/:id/scheduled-cancellations/reject", requireAuth("super_admin"), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (!order.cancellation_requested_at || order.cancellation_decision) {
    return sendJson(res, 409, { error: "This order has no pending cancellation request" });
  }

  // Order itself is untouched (still in_progress, still scheduled) -- setting
  // cancellation_decision='rejected' is what makes runScheduledRechargeSweep()
  // eligible to pick it up again, immediately if scheduled_at already elapsed
  // during the review window, otherwise at its original time.
  await query(
    `UPDATE orders SET cancellation_decision='rejected', cancellation_decided_at=now(), cancellation_decided_by=$1, updated_at=now() WHERE id=$2`,
    [req.auth!.sub, req.params.id]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "schedule_cancellation_rejected",
    entityType: "order",
    entityId: req.params.id,
    oldValue: null,
    newValue: { scheduledAt: order.scheduled_at },
  });
  broadcast({ type: "order.updated", orderId: req.params.id });
  sendJson(res, 200, maskOrder(await loadOrder(req.params.id)));
});

ordersRouter.get("/admin/dashboard/stats", requireStaff(), async (_req, res) => {
  const totals = await queryOne<{
    total_sales: string;
    pending_orders: string;
    successful_orders: string;
    failed_orders: string;
  }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE status='completed'), 0) AS total_sales,
       COUNT(*) FILTER (WHERE status='pending') AS pending_orders,
       COUNT(*) FILTER (WHERE status='completed') AS successful_orders,
       COUNT(*) FILTER (WHERE status='failed') AS failed_orders
     FROM orders`
  );
  const activeCustomers = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM customers WHERE status='active'`);
  // Postgres returns numeric/count columns as strings via node-postgres (to avoid
  // precision loss on bigint) — the dashboard expects real numbers (it calls
  // .toFixed()/.toLocaleString() on these), and camelCase keys, not the raw
  // snake_case column names, or it crashes right after this resolves.
  sendJson(res, 200, {
    totalSales: Number(totals?.total_sales ?? 0),
    pendingOrders: Number(totals?.pending_orders ?? 0),
    successfulOrders: Number(totals?.successful_orders ?? 0),
    failedOrders: Number(totals?.failed_orders ?? 0),
    activeCustomers: Number(activeCustomers?.n ?? 0),
  });
});

// ---------------- Schedule Recharge: periodic sweep ----------------
// The first scan-the-DB-and-act periodic job in this backend (every other
// setInterval here is either an SSE heartbeat or a rate-limit map cleanup) —
// each module owns its own timer, so this one lives here rather than in a
// central registry. Finds every order whose scheduled fulfillment time has
// arrived and calls generateUssdForOrder for it, exactly the same call
// verify-payment itself would have made immediately were it not scheduled.
// From that point on, zero new machinery is needed: ussd_generated being set
// plus the broadcast below already makes the order a self-heal candidate
// (see GET /agent/orders/self-heal-candidates above), which the Agent App's
// existing SelfHealSweeper already picks up and dials automatically.
async function runScheduledRechargeSweep() {
  const due = await query(
    `SELECT * FROM orders
     WHERE scheduled_at IS NOT NULL AND scheduled_at <= now() AND ussd_generated IS NULL AND status='in_progress'
       AND (cancellation_requested_at IS NULL OR cancellation_decision = 'rejected')`
  );
  for (const order of due as any[]) {
    const genResult = await generateUssdForOrder(order);
    await query(`UPDATE orders SET ussd_generation_failed_reason=$1 WHERE id=$2`, [genResult.error ?? null, order.id]);
    if (genResult.error) {
      await recordActivity({
        adminId: undefined,
        action: "ussd_generation_failed",
        entityType: "order",
        entityId: order.id,
        oldValue: null,
        newValue: { reason: genResult.error, companyId: order.company_id, packageId: order.package_id },
      });
    }
    broadcast({ type: "order.updated", orderId: order.id });
  }
}

setInterval(() => {
  runScheduledRechargeSweep().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Scheduled recharge sweep failed:", err);
  });
}, 60_000);

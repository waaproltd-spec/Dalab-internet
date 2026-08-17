import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { broadcast } from "../realtime/orderEvents.js";
import {
  somlinkSendData,
  logSomlink,
  SomlinkApiError,
  SomlinkAmbiguousError,
  SomlinkConfigError,
} from "../services/somlink.js";

export const somlinkRouter = Router();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new SomlinkConfigError(`${name} is not set`);
  return value;
}

/** Somali phone numbers legitimately appear with/without the 252 country
 * code or a leading 0 (the same ambiguity orders.routes.ts's own
 * normalizePhone and smsLogs.routes.ts's own normalizePhone already exist
 * to handle). order.receiver_phone/sender_phone are stored in whatever raw
 * form the customer/agent entered — e.g. the 12-digit "252645390044" on the
 * real order that got SOMLINK error 126 — while SOMLINK_PHONE (the wallet
 * number SOMLINK's own /auth/data_v3_login already authenticates
 * successfully) is the bare local 9-digit form ("647177774"). A 12-digit
 * data_phone SOMLINK doesn't recognize as a valid MSISDN is a plausible
 * cause of a generic "SORRY_THERE_IS_ISSUE_IN_THE_DATA_SERVER" rather than
 * a specific invalid-phone error; normalizing both phone params to the one
 * local form SOMLINK is confirmed to accept removes that mismatch. */
function toLocalPhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

/**
 * Places one real SOMLINK /data/send_data order for this DALAB order and
 * records the attempt in somlink_transactions. Never called twice for the
 * same order concurrently or on a blind retry: the INSERT below relies on
 * idx_somlink_tx_order_active (a partial unique index on order_id WHERE
 * status IN ('pending','success') — see migration 049) to atomically reject
 * a second attempt while one is in flight or already succeeded. Callers
 * (orders.routes.ts's verifyOrderAndGenerateUssd, and the manual retry
 * route below) are responsible for calling completeOrderById after a
 * `{ ok: true }` result — this function only ever touches
 * somlink_transactions, never orders.status, so it stays reusable from
 * both the automatic and the manual-retry path without either one
 * accidentally completing an order out from under the other.
 */
export async function deliverViaSomlink(order: any): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pkg = await queryOne<{ somlink_bundle_id: number | null }>(
    `SELECT somlink_bundle_id FROM packages WHERE id=$1`,
    [order.package_id]
  );
  if (!pkg?.somlink_bundle_id) {
    return { ok: false, reason: "no_bundle_configured" };
  }
  const rawDataPhone: string | null = order.receiver_phone ?? order.sender_phone ?? null;
  if (!rawDataPhone) {
    return { ok: false, reason: "no_customer_phone" };
  }
  const dataPhone = toLocalPhone(rawDataPhone);
  if (!dataPhone) {
    return { ok: false, reason: "no_customer_phone" };
  }
  // Mirrors generateUssdForOrder's own provider_amount fallback: what the
  // customer paid (order.amount) can be a discounted price, while SOMLINK
  // must be charged its real bundle cost.
  const amount = Number(order.provider_amount ?? order.amount);

  let walletPhone: string;
  try {
    walletPhone = toLocalPhone(requiredEnv("SOMLINK_PHONE"));
  } catch (err) {
    return { ok: false, reason: "somlink_not_configured" };
  }

  const txId = randomUUID();
  try {
    await query(
      `INSERT INTO somlink_transactions (id, order_id, bundle_id, wallet_phone, data_phone, amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [txId, order.id, pkg.somlink_bundle_id, walletPhone, dataPhone, amount]
    );
  } catch (err: any) {
    if (err?.code === "23505") {
      // A pending or already-successful attempt exists for this order —
      // this is the guarantee point: never place a second real order.
      return { ok: false, reason: "already_attempted" };
    }
    throw err;
  }

  const startedAt = Date.now();
  try {
    const result = await somlinkSendData({
      dataPhone,
      walletPhone,
      amount,
      bundleId: pkg.somlink_bundle_id,
    });
    const durationMs = Date.now() - startedAt;
    await query(
      `UPDATE somlink_transactions
       SET status='success', response_code=$1, response_message=$2, paid_amount=$3, balance_after=$4, responded_at=now()
       WHERE id=$5`,
      [result.code, result.message, result.paidAmount, result.balance, txId]
    );
    logSomlink({
      orderId: order.id,
      bundleId: pkg.somlink_bundle_id,
      amount,
      dataPhone,
      status: "success",
      responseCode: result.code,
      responseMessage: result.message,
      durationMs,
    });
    return { ok: true };
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof SomlinkApiError) {
      // A clear, structured "no" from SOMLINK (bad bundle, insufficient
      // balance, invalid phone, auth failure after the one allowed
      // re-login) — the wallet was definitely NOT charged for this
      // attempt, so this order is safe to retry later without any risk of
      // double-spending.
      await query(
        `UPDATE somlink_transactions SET status='failed', response_code=$1, response_message=$2, responded_at=now() WHERE id=$3`,
        [err.code ?? null, err.somlinkMessage ?? err.message, txId]
      );
      logSomlink({
        orderId: order.id,
        bundleId: pkg.somlink_bundle_id,
        amount,
        dataPhone,
        status: "failed",
        responseCode: err.code,
        responseMessage: err.somlinkMessage,
        durationMs,
      });
      return { ok: false, reason: "somlink_declined" };
    }
    // Network error, timeout, or an unparseable response — genuinely
    // unknown whether SOMLINK's wallet was charged and the bundle sent.
    // Left as 'ambiguous' and NOT retried automatically anywhere in this
    // codebase; only a human confirming the true outcome via SOMLINK's own
    // dashboard should decide whether to complete or clear this order.
    const message = err instanceof SomlinkAmbiguousError ? err.message : String(err?.message ?? err);
    await query(
      `UPDATE somlink_transactions SET status='ambiguous', error_detail=$1, responded_at=now() WHERE id=$2`,
      [message, txId]
    );
    logSomlink({
      orderId: order.id,
      bundleId: pkg.somlink_bundle_id,
      amount,
      dataPhone,
      status: "ambiguous",
      error: message,
      durationMs,
    });
    return { ok: false, reason: "somlink_ambiguous" };
  }
}

/** Extends orders.routes.ts's classifyStuckReason for a SOMLINK-fulfilled
 * order stuck in_progress — mirrors that function's own USSD-side reasons
 * (delivery_response_ambiguous, server_timeout, ...) with SOMLINK-specific
 * ones so admin sees why, not a generic/misleading USSD reason. */
export async function classifySomlinkStuckReason(order: any): Promise<string | null> {
  const lastTx = await queryOne<{ status: string; response_message: string | null }>(
    `SELECT status, response_message FROM somlink_transactions WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [order.id]
  );
  if (!lastTx) return "somlink_not_attempted";
  if (lastTx.status === "ambiguous") return "somlink_response_ambiguous";
  if (lastTx.status === "failed") return "somlink_declined";
  return null;
}

/**
 * Manual, staff-only retry for an order stuck in_progress with a 'failed'
 * or 'ambiguous' SOMLINK attempt. Deliberately requires a human in the
 * loop rather than any automatic sweep: for a 'failed' attempt this is
 * safe (SOMLINK gave a clear "no", nothing was charged), but for an
 * 'ambiguous' one the caller is expected to have independently confirmed
 * via SOMLINK's own dashboard that the prior attempt did NOT go through
 * before clicking this — see somlink_transactions' unique index doc.
 */
somlinkRouter.post("/admin/orders/:id/retry-somlink", requireStaff(), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (order.status !== "in_progress") {
    return sendJson(res, 409, { error: `Cannot retry SOMLINK delivery for an order in status '${order.status}'` });
  }
  const company = await queryOne<{ fulfillment_method: string }>(
    `SELECT fulfillment_method FROM companies WHERE id=$1`,
    [order.company_id]
  );
  if (company?.fulfillment_method !== "somlink") {
    return sendJson(res, 400, { error: "This order's provider is not SOMLINK-fulfilled" });
  }
  const result = await deliverViaSomlink(order);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "somlink_retry",
    entityType: "order",
    entityId: order.id,
    oldValue: null,
    newValue: result,
  });
  if (result.ok) {
    const { completeOrderById } = await import("./orders.routes.js");
    await completeOrderById(order.id);
  }
  broadcast({ type: "order.updated", orderId: order.id });
  const updated = await queryOne(`SELECT * FROM orders WHERE id=$1`, [order.id]);
  sendJson(res, 200, { order: updated, delivery: result });
});

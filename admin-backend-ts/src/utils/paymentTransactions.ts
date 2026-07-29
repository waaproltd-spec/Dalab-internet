import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { broadcast } from "../realtime/orderEvents.js";

/**
 * The explicit payment-transaction ledger — one row per real-world payment
 * attempt, tracked through PENDING -> PROCESSING -> COMPLETED/FAILED, or
 * DUPLICATE_BLOCKED at any point this SMS turns out to be a re-delivery of
 * an already-recorded payment. This is the authoritative guarantee that a
 * payment is dialed at most once, independent of (and a stronger guarantee
 * than) the order's own pending/in_progress/completed status — it survives
 * an Agent App reconnect or a retried API call by construction, since every
 * write here is either an idempotent upsert or guarded by a status check.
 */
export type PaymentTxStatus = "pending" | "processing" | "completed" | "failed" | "duplicate_blocked";

export async function createPaymentTransaction(params: {
  smsLogId: string | null;
  orderId: string | null;
  transactionRef: string | null;
  customerPhone: string | null;
  amount: number | null;
  paymentTimestamp: string;
  status: PaymentTxStatus;
}): Promise<string | null> {
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO payment_transactions
         (id, sms_log_id, order_id, transaction_ref, customer_phone, amount, payment_timestamp, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        params.smsLogId,
        params.orderId,
        params.transactionRef,
        params.customerPhone,
        params.amount,
        params.paymentTimestamp,
        params.status,
      ]
    );
    broadcast({ type: "payment_transaction.updated", paymentTransactionId: id, orderId: params.orderId });
    return id;
  } catch (err: any) {
    // A concurrent request already created the active (non-duplicate_blocked)
    // row for this exact transaction_ref — this attempt is itself the
    // duplicate. Not an error: report it as blocked rather than throwing.
    if (err?.code !== "23505" || err?.constraint !== "idx_payment_tx_ref_active") throw err;
    return null;
  }
}

/** Called once a dial attempt actually starts — the point at which we know
 * which physical device/SIM is handling this payment. UssdOrchestrator
 * retries a failed dial up to 3 times, so 'failed' is NOT treated as final
 * here (a retry needs to move it back to 'processing') — only 'completed'
 * and 'duplicate_blocked' are permanent end states nothing can leave. */
export async function markPaymentProcessing(params: {
  orderId: string;
  agentDeviceId: string | null;
  simSlot: number | null;
  ussdDialAttemptId: string;
}): Promise<void> {
  const rows = await query<{ id: string }>(
    `UPDATE payment_transactions
     SET status='processing', agent_device_id=$1, sim_slot=$2, ussd_dial_attempt_id=$3, updated_at=now()
     WHERE order_id=$4 AND status NOT IN ('completed','duplicate_blocked')
     RETURNING id`,
    [params.agentDeviceId, params.simSlot, params.ussdDialAttemptId, params.orderId]
  );
  if (rows.length > 0) {
    broadcast({ type: "payment_transaction.updated", paymentTransactionId: rows[0].id, orderId: params.orderId });
  }
}

export async function markPaymentFinal(orderId: string, status: "completed" | "failed"): Promise<void> {
  const rows = await query<{ id: string }>(
    `UPDATE payment_transactions SET status=$1, updated_at=now()
     WHERE order_id=$2 AND status NOT IN ('completed','duplicate_blocked')
     RETURNING id`,
    [status, orderId]
  );
  if (rows.length > 0) {
    broadcast({ type: "payment_transaction.updated", paymentTransactionId: rows[0].id, orderId });
  }
}

/** True if this order already has a payment_transactions row that reached a
 * terminal, successful state — used as an extra guard right before a dial
 * attempt starts, on top of the order's own status check, so "is another
 * job already running / already done for this payment" is answerable from
 * one place. */
export async function isAlreadyCompleted(orderId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM payment_transactions WHERE order_id=$1 AND status='completed' LIMIT 1`,
    [orderId]
  );
  return row != null;
}

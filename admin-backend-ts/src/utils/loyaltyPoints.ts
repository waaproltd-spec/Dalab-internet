import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";

/**
 * Refunds Macaash points a customer redeemed as a checkout discount (see
 * POST /orders' useLoyaltyPoints handling) on an order that ends up not
 * delivering value — failed, cancelled, or later reversed after completing.
 * Symmetric with utils/referrals.ts's credit/reverse pair: a no-op if this
 * order never redeemed any points, and idempotent (guarded by
 * idx_macaash_tx_order_redeemed_refund) so calling it more than once for
 * the same order — a retried failure signal, a reversal after a failure
 * already refunded it, etc. — never double-refunds.
 */
export async function refundRedeemedPointsIfNeeded(orderId: string): Promise<void> {
  const redemption = await queryOne<{ customer_id: string; points: number }>(
    `SELECT customer_id, points FROM macaash_transactions WHERE order_id=$1 AND kind='redeemed'`,
    [orderId]
  );
  if (!redemption) return;
  const refundPoints = -redemption.points; // 'redeemed' rows store a negative points value
  if (refundPoints <= 0) return;

  try {
    await query(
      `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason, kind)
       VALUES ($1,$2,$3,$4,$5,'redeemed_refund')`,
      [randomUUID(), redemption.customer_id, orderId, refundPoints, `Refunded points redeemed on order ${orderId}`]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_macaash_tx_order_redeemed_refund") throw err;
    return; // already refunded — no-op
  }
  await query(`UPDATE customers SET macaash_points = macaash_points + $1 WHERE id=$2`, [refundPoints, redemption.customer_id]);
}

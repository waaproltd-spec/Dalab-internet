import { query, withTransaction } from "../db/pool.js";
import { recordActivity } from "../utils/activityLog.js";
import { notifyCustomer } from "../services/customerNotify.js";
import { sendPushToAllAgents } from "../services/push.js";

/**
 * Shop order's automatic SMS matcher — same shape and safety properties as
 * findMatchingVipNumberOrder/confirmVipNumberOrderPaidViaSms in
 * vipNumberSmsMatching.ts (candidate row lock, phone+amount match, atomic
 * claim-before-state-changes), just against shop_orders instead of
 * vip_number_orders. Deliberately its own module, not added inline to
 * smsLogs.routes.ts, for the same "keep this feature's SMS-matching code
 * clearly separated from Internet/eBadal/Reseller's" reasoning
 * resellerSmsMatching.ts's own header gives.
 *
 * migration 074 originally decided Shop would NOT be wired into this
 * pipeline ("adding a 5th matcher for a brand-new, lower-traffic feature is
 * a needless risk to Internet/eBadal/Reseller's real-money pipeline") —
 * this reverses that decision for the same reason migration 092 already
 * reversed it for VIP Numbers: a genuinely paid Shop order was sitting on
 * "Awaiting Payment" indefinitely, with the confirming SMS already sitting
 * unread on the collection phone. ingestPaymentSms only ever calls this once
 * every earlier matcher (Store, Offline Auto-Order, Exchange, Reseller
 * Deposit, Reseller Withdraw, VIP Number, VIP Number Package) has already
 * found nothing for a given SMS — same "always last, never steals a payment
 * meant for the others" guarantee every earlier addition follows.
 *
 * No device/SIM verification here, same as VIP Numbers: shop_payment_methods
 * has no device_id/sim_slot columns at all — there is only ever one global
 * collection number per method (EVC Plus / eDahab). Every match here is
 * accepted on amount+phone alone, the same trust level findMatchingOrder
 * already gives a "legacy company" with no company-specific payment method
 * configured.
 */

const MATCH_WINDOW_HOURS = 24;
const TERMINAL_SHOP_STATUSES = ["delivered", "cancelled", "failed", "returned", "refunded"];

function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

type ShopOrderCandidate = { id: string; sender_phone: string; total_amount: number };

export type ShopOrderMatchResult = { order: ShopOrderCandidate | null; reason: string | null };

export async function findMatchingShopOrder(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined
): Promise<ShopOrderMatchResult> {
  if (parsedAmount == null || !parsedPhone) {
    return { order: null, reason: "SMS did not parse a usable amount and/or sender phone number" };
  }
  const target = normalizePhone(parsedPhone);
  if (!target) return { order: null, reason: "Parsed phone number had no digits after normalization" };

  const candidates = await withTransaction((client) =>
    client
      .query<ShopOrderCandidate>(
        `SELECT id, sender_phone, total_amount FROM shop_orders
         WHERE payment_status='pending' AND status NOT IN (${TERMINAL_SHOP_STATUSES.map((_, i) => `$${i + 2}`).join(",")})
           AND ABS(total_amount - $1) < 0.01 AND updated_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED`,
        [parsedAmount, ...TERMINAL_SHOP_STATUSES]
      )
      .then((r) => r.rows)
  );
  if (candidates.length === 0) {
    return { order: null, reason: `No pending Shop order for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h` };
  }
  const phoneMatch = candidates.find((o) => normalizePhone(o.sender_phone) === target);
  if (!phoneMatch) {
    return {
      order: null,
      reason: `${candidates.length} pending Shop order(s) for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h, but none for phone ...${target}`,
    };
  }
  return { order: phoneMatch, reason: null };
}

/**
 * Flips the order to paid — mirrors PUT /admin/shop/orders/:id/payment-status's
 * own state transition exactly (shop.routes.ts), just with no admin attached
 * (verified_by_admin_id stays null) and its own atomic claim instead of the
 * admin route's explicit 409 checks. This IS "an Admin sees the money arrive
 * and taps Mark Paid" — automated.
 *
 * The claim (payment_status='pending' CAS) runs first; only a successful
 * claim is allowed to touch shop_order_status_history or fire any side
 * effect, so a race between two SMS (or this and an admin's manual
 * confirmation) can never double-process the same order.
 */
export async function confirmShopOrderPaidViaSms(
  order: ShopOrderCandidate,
  smsLogId: string
): Promise<{ confirmed: boolean }> {
  const claimed = await withTransaction(async (client) => {
    const row = await client.query<{ status: string; customer_id: string }>(
      `SELECT status, customer_id FROM shop_orders WHERE id=$1 FOR UPDATE`,
      [order.id]
    );
    const existing = row.rows[0];
    if (!existing || TERMINAL_SHOP_STATUSES.includes(existing.status)) return null;
    const updated = await client.query<{ id: string }>(
      `UPDATE shop_orders SET payment_status='paid', paid_at=now(),
         status = CASE WHEN status='pending' THEN 'processing' ELSE status END,
         updated_at=now() WHERE id=$1 AND payment_status='pending' RETURNING id`,
      [order.id]
    );
    if (updated.rows.length === 0) return null;
    if (existing.status === "pending") {
      await client.query(
        `INSERT INTO shop_order_status_history (order_id, status, note) VALUES ($1,'processing','Payment confirmed automatically via SMS')`,
        [order.id]
      );
    }
    return existing;
  });
  if (!claimed) return { confirmed: false };

  await query(`UPDATE sms_logs SET matched_shop_order_id=$1 WHERE id=$2`, [order.id, smsLogId]);
  await recordActivity({
    adminId: undefined,
    action: "shop_order_payment_confirmed_via_sms",
    entityType: "shop_order",
    entityId: order.id,
    oldValue: { paymentStatus: "pending" },
    newValue: { paymentStatus: "paid", smsLogId },
  });
  await notifyCustomer(
    claimed.customer_id,
    "shop_order_update",
    "Order Confirmed",
    `Your payment for order ${order.id} has been confirmed. We're preparing it now.`
  );
  await sendPushToAllAgents({
    title: "🛒 Shop Order Paid",
    body: `Order ${order.id} payment confirmed: $${Number(order.total_amount).toFixed(2)}`,
    data: { screen: "agent_orders", orderType: "shop", orderId: order.id },
  });
  return { confirmed: true };
}

import { query, withTransaction } from "../db/pool.js";
import { recordActivity } from "../utils/activityLog.js";
import { notifyCustomer } from "../services/customerNotify.js";
import { sendPushToAllAgents } from "../services/push.js";

/**
 * VIP Number and VIP Number Package orders' automatic SMS matchers — same
 * shape and safety properties as findMatchingResellerDeposit/
 * confirmResellerDepositViaSms in resellerSmsMatching.ts (candidate row
 * lock, phone+amount match, atomic claim-before-state-changes), just
 * against vip_number_orders/vip_number_package_orders instead of
 * reseller_deposits. Deliberately its own module, not added inline to
 * smsLogs.routes.ts, for the same "keep this feature's SMS-matching code
 * clearly separated from Internet/eBadal/Reseller's" reasoning
 * resellerSmsMatching.ts's own header gives.
 *
 * migration 087/088 originally decided VIP Numbers would NOT be wired into
 * this pipeline ("a brand-new, lower-traffic feature shouldn't add a new
 * matcher to Internet/eBadal/Reseller's real-money pipeline") — this
 * reverses that decision after real-world use showed a genuinely paid VIP
 * order sitting on 'Awaiting Payment' until an admin happened to notice the
 * incoming SMS. ingestPaymentSms only ever calls these once Store, Offline
 * Auto-Order, Exchange, Reseller Deposit, AND Reseller Withdraw have all
 * found nothing for a given SMS — same "always last, never steals a
 * payment meant for the others" guarantee every earlier addition follows.
 *
 * No device/SIM verification here, unlike findMatchingOrder/
 * findMatchingResellerDeposit: shop_payment_methods (which VIP Numbers
 * reuses directly, see migration 087's header) has no device_id/sim_slot
 * columns at all — there is only ever one global collection number per
 * method (EVC Plus / eDahab), not a per-company routed one. Every match
 * here is accepted on amount+phone alone, the same trust level
 * findMatchingOrder already gives a "legacy company" with no
 * company-specific payment method configured.
 */

const MATCH_WINDOW_HOURS = 24;
const VIP_TERMINAL_STATUSES = ["completed", "cancelled", "failed", "expired"];

function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

type VipNumberOrderCandidate = { id: string; sender_phone: string; price: number; phone_number: string };

export type VipNumberOrderMatchResult = { order: VipNumberOrderCandidate | null; reason: string | null };

export async function findMatchingVipNumberOrder(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined
): Promise<VipNumberOrderMatchResult> {
  if (parsedAmount == null || !parsedPhone) {
    return { order: null, reason: "SMS did not parse a usable amount and/or sender phone number" };
  }
  const target = normalizePhone(parsedPhone);
  if (!target) return { order: null, reason: "Parsed phone number had no digits after normalization" };

  const candidates = await withTransaction((client) =>
    client
      .query<VipNumberOrderCandidate>(
        `SELECT id, sender_phone, price, phone_number FROM vip_number_orders
         WHERE payment_status='pending' AND status NOT IN (${VIP_TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(",")})
           AND ABS(price - $1) < 0.01 AND updated_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED`,
        [parsedAmount, ...VIP_TERMINAL_STATUSES]
      )
      .then((r) => r.rows)
  );
  if (candidates.length === 0) {
    return { order: null, reason: `No pending VIP number order for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h` };
  }
  const phoneMatch = candidates.find((o) => normalizePhone(o.sender_phone) === target);
  if (!phoneMatch) {
    return {
      order: null,
      reason: `${candidates.length} pending VIP number order(s) for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h, but none for phone ...${target}`,
    };
  }
  return { order: phoneMatch, reason: null };
}

/**
 * Flips the order to paid + 'sold' the VIP number — mirrors PUT
 * /admin/vip-numbers/orders/:id/payment-status's own state transition
 * exactly (vipNumbers.routes.ts), just with no admin attached
 * (verified_by_admin_id stays null) and its own atomic claim instead of
 * the admin route's FOR UPDATE + explicit 409 checks. This IS "an Admin
 * manually marks the order paid" — automated. Deliberately duplicated
 * rather than shared with the admin route: same precedent as
 * confirmResellerDepositViaSms/the manual reseller-deposit verify route,
 * which also don't share this logic (see resellerDepositsWithdrawals.
 * routes.ts) — keeps each entry point's own transaction self-contained.
 *
 * The claim (payment_status='pending' CAS) runs first; only a successful
 * claim is allowed to touch vip_numbers or fire any side effect, so a race
 * between two SMS (or this and an admin's manual confirmation) can never
 * double-process the same order.
 */
export async function confirmVipNumberOrderPaidViaSms(
  order: VipNumberOrderCandidate,
  smsLogId: string
): Promise<{ confirmed: boolean }> {
  const claimed = await withTransaction(async (client) => {
    const row = await client.query<{ status: string; vip_number_id: string; customer_id: string }>(
      `SELECT status, vip_number_id, customer_id FROM vip_number_orders WHERE id=$1 FOR UPDATE`,
      [order.id]
    );
    const existing = row.rows[0];
    if (!existing || VIP_TERMINAL_STATUSES.includes(existing.status)) return null;
    const updated = await client.query<{ id: string }>(
      `UPDATE vip_number_orders SET payment_status='paid', paid_at=now(),
         status = CASE WHEN status='pending' THEN 'processing' ELSE status END,
         updated_at=now() WHERE id=$1 AND payment_status='pending' RETURNING id`,
      [order.id]
    );
    if (updated.rows.length === 0) return null;
    await client.query(`UPDATE vip_numbers SET status='sold', updated_at=now() WHERE id=$1`, [existing.vip_number_id]);
    return existing;
  });
  if (!claimed) return { confirmed: false };

  await query(`UPDATE sms_logs SET matched_vip_number_order_id=$1 WHERE id=$2`, [order.id, smsLogId]);
  if (claimed.status === "pending") {
    await query(`INSERT INTO vip_number_order_status_history (order_id, status, note) VALUES ($1,'processing','Payment confirmed automatically via SMS')`, [
      order.id,
    ]);
  }
  await recordActivity({
    adminId: undefined,
    action: "vip_number_order_payment_confirmed_via_sms",
    entityType: "vip_number_order",
    entityId: order.id,
    oldValue: { paymentStatus: "pending" },
    newValue: { paymentStatus: "paid", smsLogId },
  });
  await notifyCustomer(
    claimed.customer_id,
    "vip_number_order_update",
    "Payment Confirmed",
    `Your payment for VIP number order ${order.id} has been confirmed. We're processing your number now.`
  );
  // Format requested for the agent's system-tray notification: multi-line
  // body naming the actual VIP number and amount, not just an order id --
  // see AgentFcmService.kt's own handling of this exact data shape.
  await sendPushToAllAgents({
    title: "🔔 New VIP Order",
    body: `VIP Number: ${order.phone_number}\nPayment confirmed: $${Number(order.price).toFixed(2)}\nOrder ID: ${order.id}`,
    data: { screen: "agent_orders", orderType: "vip_number", orderId: order.id },
  });
  return { confirmed: true };
}

type VipNumberPackageOrderCandidate = { id: string; sender_phone: string; price: number; size: number };

export type VipNumberPackageOrderMatchResult = { order: VipNumberPackageOrderCandidate | null; reason: string | null };

export async function findMatchingVipNumberPackageOrder(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined
): Promise<VipNumberPackageOrderMatchResult> {
  if (parsedAmount == null || !parsedPhone) {
    return { order: null, reason: "SMS did not parse a usable amount and/or sender phone number" };
  }
  const target = normalizePhone(parsedPhone);
  if (!target) return { order: null, reason: "Parsed phone number had no digits after normalization" };

  const candidates = await withTransaction((client) =>
    client
      .query<VipNumberPackageOrderCandidate>(
        `SELECT id, sender_phone, price, size FROM vip_number_package_orders
         WHERE payment_status='pending' AND status NOT IN (${VIP_TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(",")})
           AND ABS(price - $1) < 0.01 AND updated_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED`,
        [parsedAmount, ...VIP_TERMINAL_STATUSES]
      )
      .then((r) => r.rows)
  );
  if (candidates.length === 0) {
    return { order: null, reason: `No pending VIP number package order for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h` };
  }
  const phoneMatch = candidates.find((o) => normalizePhone(o.sender_phone) === target);
  if (!phoneMatch) {
    return {
      order: null,
      reason: `${candidates.length} pending VIP number package order(s) for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h, but none for phone ...${target}`,
    };
  }
  return { order: phoneMatch, reason: null };
}

/** Package counterpart to confirmVipNumberOrderPaidViaSms — same shape,
 * moves every member number in the package to 'sold' at once (mirrors PUT
 * /admin/vip-numbers/packages/orders/:id/payment-status exactly). */
export async function confirmVipNumberPackageOrderPaidViaSms(
  order: VipNumberPackageOrderCandidate,
  smsLogId: string
): Promise<{ confirmed: boolean }> {
  const claimed = await withTransaction(async (client) => {
    const row = await client.query<{ status: string; package_id: string; customer_id: string }>(
      `SELECT status, package_id, customer_id FROM vip_number_package_orders WHERE id=$1 FOR UPDATE`,
      [order.id]
    );
    const existing = row.rows[0];
    if (!existing || VIP_TERMINAL_STATUSES.includes(existing.status)) return null;
    const updated = await client.query<{ id: string }>(
      `UPDATE vip_number_package_orders SET payment_status='paid', paid_at=now(),
         status = CASE WHEN status='pending' THEN 'processing' ELSE status END,
         updated_at=now() WHERE id=$1 AND payment_status='pending' RETURNING id`,
      [order.id]
    );
    if (updated.rows.length === 0) return null;
    await client.query(
      `UPDATE vip_numbers SET status='sold', updated_at=now()
       WHERE id IN (SELECT vip_number_id FROM vip_number_package_items WHERE package_id=$1)`,
      [existing.package_id]
    );
    return existing;
  });
  if (!claimed) return { confirmed: false };

  await query(`UPDATE sms_logs SET matched_vip_number_package_order_id=$1 WHERE id=$2`, [order.id, smsLogId]);
  if (claimed.status === "pending") {
    await query(
      `INSERT INTO vip_number_package_order_status_history (package_order_id, status, note) VALUES ($1,'processing','Payment confirmed automatically via SMS')`,
      [order.id]
    );
  }
  await recordActivity({
    adminId: undefined,
    action: "vip_number_package_order_payment_confirmed_via_sms",
    entityType: "vip_number_package_order",
    entityId: order.id,
    oldValue: { paymentStatus: "pending" },
    newValue: { paymentStatus: "paid", smsLogId },
  });
  await notifyCustomer(
    claimed.customer_id,
    "vip_number_package_order_update",
    "Payment Confirmed",
    `Your payment for VIP number package order ${order.id} has been confirmed. We're processing your numbers now.`
  );
  await sendPushToAllAgents({
    title: "🔔 New VIP Order",
    body: `VIP Package: ${order.size} Numbers\nPayment confirmed: $${Number(order.price).toFixed(2)}\nOrder ID: ${order.id}`,
    data: { screen: "agent_orders", orderType: "vip_package", orderId: order.id },
  });
  return { confirmed: true };
}

import { query, queryOne, withTransaction } from "../db/pool.js";
import { recordActivity } from "../utils/activityLog.js";
import { notifyCustomer } from "../services/customerNotify.js";
import { sendPushToAgent } from "../services/push.js";

/**
 * Shop's automatic SMS matcher — confirms a Shop order's payment the moment
 * an agent's phone receives the customer's self-dialed USSD payment SMS,
 * same shape and safety properties as findMatchingResellerDeposit
 * (resellerSmsMatching.ts): candidate row lock, amount+phone match,
 * device/SIM verification against the matched payment method, atomic claim
 * before anything else happens. Deliberately its own module and deliberately
 * last in ingestPaymentSms's priority chain (smsLogs.routes.ts only ever
 * calls this once Store, Exchange, Reseller Deposit, AND Reseller Withdraw
 * have all found nothing) — a real payment meant for one of those must
 * never be stolen by this matcher.
 */

const MATCH_WINDOW_HOURS = 24;

function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

type ShopOrderCandidate = {
  id: string;
  sender_phone: string;
  total_amount: number;
  payment_method: string | null;
  customer_id: string;
};

export type ShopOrderMatchResult = { order: ShopOrderCandidate | null; reason: string | null };

export async function findMatchingShopOrder(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined,
  uploadingAgentId: string,
  uploadingSimSlot: number | null | undefined
): Promise<ShopOrderMatchResult> {
  if (parsedAmount == null || !parsedPhone) {
    return { order: null, reason: "SMS did not parse a usable amount and/or sender phone number" };
  }
  const target = normalizePhone(parsedPhone);
  if (!target) return { order: null, reason: "Parsed phone number had no digits after normalization" };

  const candidates = await withTransaction((client) =>
    client
      .query<ShopOrderCandidate>(
        `SELECT id, sender_phone, total_amount, payment_method, customer_id FROM shop_orders
         WHERE payment_status='unpaid' AND ABS(total_amount - $1) < 0.01 AND created_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED`,
        [parsedAmount]
      )
      .then((r) => r.rows)
  );
  if (candidates.length === 0) {
    return { order: null, reason: `No unpaid Shop order for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h` };
  }
  const phoneMatches = candidates.filter((o) => normalizePhone(o.sender_phone) === target);
  if (phoneMatches.length === 0) {
    return {
      order: null,
      reason: `${candidates.length} unpaid Shop order(s) for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h, but none for phone ...${target}`,
    };
  }

  const uploadingAgent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [uploadingAgentId]);
  const uploadingDeviceId = uploadingAgent?.device_id ?? null;

  const skipped: string[] = [];
  for (const candidate of phoneMatches) {
    if (!candidate.payment_method) {
      skipped.push(`order ${candidate.id}: has no paymentMethod recorded`);
      continue;
    }
    const method = await queryOne<{ device_id: string | null; sim_slot: number | null }>(
      `SELECT device_id, sim_slot FROM shop_payment_methods WHERE method=$1`,
      [candidate.payment_method]
    );
    if (!method) {
      skipped.push(`order ${candidate.id}: its payment method (${candidate.payment_method}) no longer exists`);
      continue;
    }
    if (!method.device_id) {
      // Not yet linked to a device — accept, same bootstrap
      // findMatchingResellerDeposit uses, and auto-link this method to the
      // device/slot this SMS arrived on since a real amount+phone-matched
      // order just proved that's where it's collected.
      if (uploadingDeviceId) {
        await query(
          `UPDATE shop_payment_methods SET device_id=$1, sim_slot=COALESCE(sim_slot, $2) WHERE method=$3`,
          [uploadingDeviceId, uploadingSimSlot ?? null, candidate.payment_method]
        );
      }
      return { order: candidate, reason: null };
    }
    if (method.device_id !== uploadingDeviceId) {
      skipped.push(`order ${candidate.id}: expects device ${method.device_id}, this SMS arrived on device ${uploadingDeviceId ?? "(agent has no device_id set)"}`);
      continue;
    }
    if (method.sim_slot != null && method.sim_slot !== uploadingSimSlot) {
      skipped.push(`order ${candidate.id}: expects SIM slot ${method.sim_slot}, this SMS arrived on slot ${uploadingSimSlot ?? "(unresolved)"}`);
      continue;
    }
    return { order: candidate, reason: null };
  }
  return { order: null, reason: `Matched by amount+phone but rejected by device/SIM verification — ${skipped.join("; ")}` };
}

/**
 * Flips the order's payment_status to 'paid', mirroring
 * confirmResellerDepositViaSms's atomic-claim-first shape: the CAS
 * (`WHERE payment_status='unpaid'`) runs before any side effect below, so a
 * race between a live SMS upload and a resweep (or two concurrent uploads)
 * can never fire the notification twice or double-confirm a payment — a
 * caller that loses the race just returns { confirmed: false }. Also this
 * function's ONLY caller (ingestPaymentSms) already rejects a second SMS
 * from ever reaching here at all once shop_orders.payment_status='paid',
 * since findMatchingShopOrder only selects payment_status='unpaid' rows.
 *
 * The Agent App push is the feature this function exists for: "the
 * assigned Shop Agent" is resolved the same transitive way Store/Reseller
 * Deposit resolve "which device handles this order" — via the order's
 * payment_method -> shop_payment_methods.device_id -> every currently
 * logged-in agent on that device (agents.device_id). Best-effort and never
 * allowed to fail the payment confirmation itself (sendPushToAgent already
 * never throws — see push.ts).
 */
export async function confirmShopOrderPaymentViaSms(
  order: ShopOrderCandidate,
  smsLogId: string
): Promise<{ confirmed: boolean }> {
  const claimed = await query<{ id: string }>(
    `UPDATE shop_orders SET payment_status='paid', updated_at=now() WHERE id=$1 AND payment_status='unpaid' RETURNING id`,
    [order.id]
  );
  if (claimed.length === 0) {
    // Lost the race, or already resolved another way — no double-confirm,
    // no duplicate notification.
    return { confirmed: false };
  }

  await query(`UPDATE sms_logs SET matched_shop_order_id=$1 WHERE id=$2`, [order.id, smsLogId]);
  await recordActivity({
    adminId: undefined,
    action: "shop_order_payment_verified_via_sms",
    entityType: "shop_order",
    entityId: order.id,
    oldValue: null,
    newValue: { smsLogId, amount: order.total_amount, summary: `SMS -> Shop Order ${order.id} -> payment verified` },
  });

  await notifyCustomer(
    order.customer_id,
    "shop_payment_confirmed",
    "Payment confirmed",
    `Your payment for order ${order.id} has been confirmed.`,
    { orderId: order.id }
  );

  const method = order.payment_method
    ? await queryOne<{ device_id: string | null; label: string | null }>(
        `SELECT device_id, label FROM shop_payment_methods WHERE method=$1`,
        [order.payment_method]
      )
    : null;
  if (method?.device_id) {
    const assignedAgents = await query<{ id: string }>(`SELECT id FROM agents WHERE device_id=$1`, [method.device_id]);
    const amountLabel = Number(order.total_amount).toFixed(2);
    const methodLabel = method.label ?? order.payment_method ?? "Unknown";
    for (const agent of assignedAgents) {
      await sendPushToAgent(agent.id, {
        title: "💰 Payment Received",
        body: `Customer payment has been confirmed.\nOrder: #${order.id}\nAmount: $${amountLabel}\nPayment: ${methodLabel}\nStatus: 🟢 Confirmed`,
        channelId: "shop_payments",
        data: { screen: "shop_order_detail", orderId: order.id },
      });
    }
  }

  return { confirmed: true };
}

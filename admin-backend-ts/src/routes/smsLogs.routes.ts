import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import {
  createPaymentTransaction,
  hasActivePaymentTransaction,
  linkPaymentTransactionToOrder,
  markPaymentTransactionDuplicateForSms,
} from "../utils/paymentTransactions.js";
import { extractBalanceFromSms, resolveCompanyIdByProviderName, resolveDeviceSlotForCompany, applyBalanceUpdate } from "../utils/simBalances.js";
import { broadcast } from "../realtime/orderEvents.js";
import { verifyOrderAndGenerateUssd } from "./orders.routes.js";
import { autoAdvanceExchangeOrderToInProgress } from "./exchange.routes.js";
import { findMatchingResellerDeposit, confirmResellerDepositViaSms } from "./resellerSmsMatching.js";

export const smsLogsRouter = Router();

/** Somali phone numbers legitimately appear in multiple formats (with 252,
 * with a leading 0, or bare) — compare the last 9 digits, not raw strings. */
function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

type OrderMatch = {
  id: string;
  sender_phone: string | null;
  receiver_phone: string | null;
  amount: number;
  company_id: string;
  payment_method_id: string | null;
};

/**
 * Matches by amount + normalized customer phone, same as before. No phone
 * match -> returns null rather than guessing across possibly-different
 * customers by amount alone.
 *
 * Payment-number verification: when the matched order used one of a
 * company's specific payment methods (payment_method_id set — EVC Plus vs
 * eDahab vs JEEB, each its own telco/SIM) and that method already has a
 * known device/SIM slot (company_payment_methods.device_id/sim_slot), the
 * SMS must have arrived through that exact device (and, if the method
 * specifies one, the exact SIM slot on that device — a single payment
 * phone commonly holds two payment SIMs) — otherwise it's treated the
 * same as no match at all, and the order simply stays 'pending' rather
 * than being silently completed by a payment that landed on the wrong
 * number.
 *
 * A method with no device linked YET is accepted (never rejected for that
 * reason alone — same trust level as a legacy company below) and the
 * device/slot this SMS actually arrived on is auto-linked onto that
 * payment method right here, since a real amount+phone-matched payment
 * just proved that's where it's collected. There is no admin UI step for
 * this — every method links itself the moment its first real payment
 * comes in, and every payment after that is strictly verified against the
 * link it just learned. Legacy companies with no per-method payment
 * methods configured (payment_method_id null) keep the original
 * cross-network behavior — there's no specific number to verify against
 * yet.
 *
 * Two further safeguards against a real payment being silently absorbed by
 * the WRONG order (same customer, same amount, but a different attempt):
 *  - MATCH_WINDOW_HOURS excludes anything not touched in the last day — a
 *    payment SMS arriving now is confirming something the customer just
 *    did, not an order they gave up on long ago. This is also what keeps
 *    oldest-first matching (below) safe: a stale/abandoned order can only
 *    "win" future payments of that amount for up to this window, never
 *    indefinitely.
 *    Filtered on updated_at, not created_at: the guest/orders create route
 *    above silently REUSES an existing 'pending' row (same customer+
 *    company+package+amount) via idx_orders_pending_content_dedup instead
 *    of inserting a new one when a customer re-attempts checkout — it
 *    bumps updated_at but deliberately leaves created_at as the original
 *    creation time (an immutable audit trail). Filtering on created_at
 *    made a customer's brand-new checkout attempt today invisible to
 *    matching if the row being reused was first created days earlier —
 *    confirmed via a real order stuck 'pending' since its original
 *    creation, reused today, whose same-day payment SMS still got "No
 *    pending order... in the last 24h" because created_at never moved.
 *    updated_at is the right freshness signal here since it's exactly what
 *    the reuse path (and every real status transition) already bumps.
 *  - Within that window, the OLDEST eligible pending order wins
 *    (`created_at ASC`) — when a customer has several pending orders for
 *    the same amount (e.g. re-visiting Checkout more than once before
 *    paying), the payment they actually send should complete the one they
 *    created first, not leave it stranded while a newer duplicate jumps
 *    the queue. A candidate that fails the device check is skipped in
 *    favor of the next-oldest one that passes, rather than blocking the
 *    whole match on an order for a different payment method.
 *  - The candidate SELECT runs inside a transaction with
 *    `FOR UPDATE SKIP LOCKED` so two payment SMS arriving at the same
 *    instant can't both be handed the same locked-in-flight candidate row
 *    — a concurrent call instead skips it and considers the next-oldest
 *    eligible order. The actual pending -> in_progress transition still
 *    happens later, atomically, in verify-payment's own compare-and-swap;
 *    this lock only protects the candidate SELECT itself.
 */
const MATCH_WINDOW_HOURS = 24;

type MatchResult = { order: OrderMatch | null; reason: string | null };

/**
 * findMatchingOrder's reject paths used to return a bare null — indistinguishable
 * on the dashboard between "no candidate order at all" and "a real order was
 * found but rejected by the device/SIM-slot guardrail below." reason gives
 * every rejection a plain-language explanation, persisted onto the sms_logs
 * row itself (match_failure_reason, migration 037) so a Super Admin can see
 * WHY without cross-referencing agents.device_id and
 * company_payment_methods.device_id/sim_slot by hand.
 */
async function findMatchingOrder(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined,
  uploadingAgentId: string,
  uploadingSimSlot: number | null | undefined
): Promise<MatchResult> {
  if (parsedAmount == null || !parsedPhone) {
    return { order: null, reason: "SMS did not parse a usable amount and/or sender phone number" };
  }
  const target = normalizePhone(parsedPhone);
  if (!target) return { order: null, reason: "Parsed phone number had no digits after normalization" };

  const candidates = await withTransaction((client) =>
    client
      .query<OrderMatch>(
        `SELECT id, sender_phone, receiver_phone, amount, company_id, payment_method_id FROM orders
         WHERE status='pending' AND ABS(amount - $1) < 0.01 AND updated_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED`,
        [parsedAmount]
      )
      .then((r) => r.rows)
  );
  if (candidates.length === 0) {
    return { order: null, reason: `No pending order for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h` };
  }
  const phoneMatches = candidates.filter((o) => normalizePhone(o.sender_phone) === target);
  if (phoneMatches.length === 0) {
    return {
      order: null,
      reason: `${candidates.length} pending order(s) for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h, but none for phone ...${target}`,
    };
  }

  const uploadingAgent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [uploadingAgentId]);
  const uploadingDeviceId = uploadingAgent?.device_id ?? null;

  const skipped: string[] = [];
  for (const candidate of phoneMatches) {
    if (!candidate.payment_method_id) return { order: candidate, reason: null }; // legacy company, no specific number to verify against
    const method = await queryOne<{ device_id: string | null; sim_slot: number | null }>(
      `SELECT device_id, sim_slot FROM company_payment_methods WHERE id=$1`,
      [candidate.payment_method_id]
    );
    if (!method) {
      skipped.push(`order ${candidate.id}: its payment method record (${candidate.payment_method_id}) no longer exists`);
      continue;
    }
    if (!method.device_id) {
      // Not yet linked to a device — accept (same trust level as the
      // legacy-company path above) and auto-link this payment method to
      // the device/slot this SMS just arrived on, since a real
      // amount+phone-matched payment is concrete proof that's where it's
      // collected. Every payment after this one is strictly verified
      // against the link just learned here. If the uploading agent has no
      // device_id of its own yet, there's nothing to link — still accept
      // the match rather than strand the order, but leave the method
      // unlinked for the next SMS to try again.
      if (uploadingDeviceId) {
        await query(
          `UPDATE company_payment_methods SET device_id=$1, sim_slot=COALESCE(sim_slot, $2) WHERE id=$3`,
          [uploadingDeviceId, uploadingSimSlot ?? null, candidate.payment_method_id]
        );
      }
      return { order: candidate, reason: null };
    }
    if (method.device_id !== uploadingDeviceId) {
      skipped.push(`order ${candidate.id}: expects device ${method.device_id}, this SMS arrived on device ${uploadingDeviceId ?? "(agent has no device_id set)"}`);
      continue;
    }
    // A payment device commonly has two SIMs, each its own payment number
    // (EVC Plus vs eDahab) — when the method specifies which slot, the
    // upload must have resolved the SAME slot to count as verified; a
    // method with no slot configured (single-SIM payment device, or not
    // narrowed down yet) only needs the device to match, same as before
    // slot-level tracking existed.
    if (method.sim_slot != null && method.sim_slot !== uploadingSimSlot) {
      skipped.push(`order ${candidate.id}: expects SIM slot ${method.sim_slot}, this SMS arrived on slot ${uploadingSimSlot ?? "(unresolved)"}`);
      continue;
    }
    return { order: candidate, reason: null };
  }
  // Every amount+phone match was on the wrong (or unassigned) device/SIM —
  // stays pending, never falsely completed.
  return { order: null, reason: `Matched by amount+phone but rejected by device/SIM verification — ${skipped.join("; ")}` };
}

type ExchangeOrderMatch = {
  id: string;
  sender_phone: string;
  amount_sent: number;
  from_wallet_id: string;
};

type ExchangeMatchResult = { order: ExchangeOrderMatch | null; reason: string | null };

/**
 * Money Exchange counterpart to findMatchingOrder() above — same
 * amount+phone+device/SIM verification shape, against exchange_orders
 * instead of orders. Only ever called when the Internet Store matcher
 * found nothing for this SMS (see ingestPaymentSms), so a payment SMS that
 * really is for a Store order is never redirected here.
 *
 * "Correct collection wallet" is enforced via exchange_payout_wallets: each
 * wallet TYPE (evc_plus/edahab/...) has its own DALAB collection number,
 * and that number's device/SIM is what a customer's payment SMS for a
 * candidate order (keyed by that order's from_wallet_id) must have arrived
 * on — exactly the same device/SIM guardrail findMatchingOrder already
 * applies via company_payment_methods, just resolved through
 * exchange_payout_wallets instead. This also inherently verifies
 * provider/wallet identity: a candidate's from_wallet_id determines which
 * specific collection wallet is expected, so an SMS that arrived on the
 * wrong wallet's device/SIM can never match a candidate of a different
 * currency.
 */
async function findMatchingExchangeOrder(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined,
  uploadingAgentId: string,
  uploadingSimSlot: number | null | undefined
): Promise<ExchangeMatchResult> {
  if (parsedAmount == null || !parsedPhone) {
    return { order: null, reason: "SMS did not parse a usable amount and/or sender phone number" };
  }
  const target = normalizePhone(parsedPhone);
  if (!target) return { order: null, reason: "Parsed phone number had no digits after normalization" };

  const candidates = await withTransaction((client) =>
    client
      .query<ExchangeOrderMatch>(
        `SELECT id, sender_phone, amount_sent, from_wallet_id FROM exchange_orders
         WHERE status='pending' AND ABS(amount_sent - $1) < 0.01 AND updated_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED`,
        [parsedAmount]
      )
      .then((r) => r.rows)
  );
  if (candidates.length === 0) {
    return { order: null, reason: `No pending exchange order for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h` };
  }
  const phoneMatches = candidates.filter((o) => normalizePhone(o.sender_phone) === target);
  if (phoneMatches.length === 0) {
    return {
      order: null,
      reason: `${candidates.length} pending exchange order(s) for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h, but none sent from phone ...${target}`,
    };
  }

  const uploadingAgent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [uploadingAgentId]);
  const uploadingDeviceId = uploadingAgent?.device_id ?? null;

  const skipped: string[] = [];
  for (const candidate of phoneMatches) {
    const collectionWallet = await queryOne<{ device_id: string | null; sim_slot: number | null }>(
      `SELECT device_id, sim_slot FROM exchange_payout_wallets WHERE wallet_id=$1 ORDER BY created_at ASC LIMIT 1`,
      [candidate.from_wallet_id]
    );
    if (!collectionWallet) {
      skipped.push(`order ${candidate.id}: no collection wallet configured for ${candidate.from_wallet_id}`);
      continue;
    }
    if (!collectionWallet.device_id) {
      // Not yet linked to a device — accept, same permissive fallback
      // findMatchingOrder uses for a payment method with no device on
      // record yet; once a device IS on record every payment after this
      // is strictly verified against it.
      return { order: candidate, reason: null };
    }
    if (collectionWallet.device_id !== uploadingDeviceId) {
      skipped.push(
        `order ${candidate.id}: expects device ${collectionWallet.device_id}, this SMS arrived on device ${uploadingDeviceId ?? "(agent has no device_id set)"}`
      );
      continue;
    }
    if (collectionWallet.sim_slot != null && collectionWallet.sim_slot !== uploadingSimSlot) {
      skipped.push(
        `order ${candidate.id}: expects SIM slot ${collectionWallet.sim_slot}, this SMS arrived on slot ${uploadingSimSlot ?? "(unresolved)"}`
      );
      continue;
    }
    return { order: candidate, reason: null };
  }
  return { order: null, reason: `Matched by amount+phone but rejected by collection-wallet device/SIM verification — ${skipped.join("; ")}` };
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
  action: "payment_verified" | "payment_already_processed" | "duplicate_delivery_prevented";
  smsLogId: string;
  order: OrderMatch;
  transactionRef: string | null;
  paymentTimestamp: string;
  status: "verified" | "already_processed" | "duplicate_blocked";
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

/** Returns the same response shape ingestPaymentSms() itself returns, so
 * both the live route and tests can treat every outcome uniformly. */
type IngestSmsResult = {
  status: number;
  body: {
    id: string;
    matchedOrderId: string | null;
    matchedExchangeOrderId?: string | null;
    matchedResellerDepositId?: string | null;
    requiresManualApproval: boolean;
    duplicate: boolean;
    orderAlreadyCompleted?: boolean;
    status: string;
  };
};

async function buildAlreadyProcessedResult(
  existing: { id: string; matched_order_id: string | null; matched_exchange_order_id?: string | null },
  transactionRef: string | null,
  receivedAt: string,
  parsedPhone?: string,
  parsedAmount?: number
): Promise<IngestSmsResult> {
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
  // requirement 5 asks for, and direct evidence the guarantee held. Only
  // for Store orders — exchange orders don't use this ledger (see
  // ingestPaymentSms for why).
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
  return {
    status: 200,
    body: {
      id: existing.id,
      matchedOrderId: existing.matched_order_id,
      matchedExchangeOrderId: existing.matched_exchange_order_id ?? null,
      requiresManualApproval,
      duplicate: true,
      orderAlreadyCompleted,
      status: "already_processed",
    },
  };
}

export type IngestSmsParams = {
  agentId: string;
  sender: string;
  body: string;
  parsedProvider?: string | null;
  parsedAmount?: number;
  parsedPhone?: string;
  receivedAt?: string;
  transactionRef?: string | null;
  simSlot?: number | null;
};

/**
 * The full incoming-payment-SMS pipeline, extracted out of the Express
 * handler so it's directly callable (no HTTP/auth needed) — from
 * resweepUnmatchedSmsLogs below, and from tests. Behavior for the Internet
 * Store path is byte-for-byte what the inline handler used to do; the only
 * addition is the Money Exchange branch, which only ever runs once the
 * Store matcher has already found nothing for this SMS — Store matching is
 * always tried first and is completely unaffected by Exchange existing.
 *
 * Money Exchange matches are NOT routed through payment_transactions (that
 * ledger is Store-specific — commission math, Balance Dashboard, etc. all
 * assume a Store order). A matched exchange order is instead just linked
 * via sms_logs.matched_exchange_order_id and logged, exactly enough for a
 * Super Admin to see "this SMS pays for DEX..." and click Verify Payment
 * themselves — matching alone never advances the order out of 'pending'
 * or dials any payout, on purpose (see exchange.routes.ts's manual-v1
 * verify endpoint).
 */
export async function ingestPaymentSms(params: IngestSmsParams): Promise<IngestSmsResult> {
  const { agentId, sender, body, parsedProvider, parsedAmount, parsedPhone, transactionRef, simSlot } = params;
  const effectiveReceivedAt = params.receivedAt ?? new Date().toISOString();

  // A telecom's own per-transaction reference code (e.g. Somtel eDahab's
  // "Aqanoosiga" field) is a stronger, authoritative duplicate-payment
  // signal than the sender+body+minute heuristic below — check it first so
  // the exact same real-world payment is rejected as "Already Processed"
  // even if its message body text ever varies slightly between deliveries
  // (a redelivered broadcast, an OEM quirk, a manual re-scan of the inbox).
  if (transactionRef) {
    const existingByRef = await queryOne<{ id: string; matched_order_id: string | null; matched_exchange_order_id: string | null }>(
      `SELECT id, matched_order_id, matched_exchange_order_id FROM sms_logs WHERE transaction_ref=$1 LIMIT 1`,
      [transactionRef]
    );
    if (existingByRef) return buildAlreadyProcessedResult(existingByRef, transactionRef, effectiveReceivedAt, parsedPhone, parsedAmount);
  }

  const { order: match, reason: matchFailureReason } = await findMatchingOrder(parsedAmount, parsedPhone, agentId, simSlot);

  // Exchange matching only runs when the Store matcher found nothing — an
  // SMS that's genuinely a Store payment is never redirected here.
  let exchangeMatch: ExchangeOrderMatch | null = null;
  let exchangeMatchFailureReason: string | null = null;
  if (!match) {
    const exchangeResult = await findMatchingExchangeOrder(parsedAmount, parsedPhone, agentId, simSlot);
    exchangeMatch = exchangeResult.order;
    exchangeMatchFailureReason = exchangeResult.reason;
  }

  // Reseller Deposit matching only runs when BOTH Store and Exchange found
  // nothing — same "always last, never steals a payment meant for the
  // others" guarantee. See resellerSmsMatching.ts's header comment.
  let resellerDepositMatch: Awaited<ReturnType<typeof findMatchingResellerDeposit>>["deposit"] = null;
  let resellerMatchFailureReason: string | null = null;
  if (!match && !exchangeMatch) {
    const resellerResult = await findMatchingResellerDeposit(parsedAmount, parsedPhone, agentId, simSlot);
    resellerDepositMatch = resellerResult.deposit;
    resellerMatchFailureReason = resellerResult.reason;
  }

  const combinedFailureReason =
    match || exchangeMatch || resellerDepositMatch
      ? null
      : [
          matchFailureReason,
          exchangeMatchFailureReason ? `Exchange: ${exchangeMatchFailureReason}` : null,
          resellerMatchFailureReason ? `Reseller Deposit: ${resellerMatchFailureReason}` : null,
        ]
          .filter(Boolean)
          .join(" | ");

  const id = randomUUID();
  // Resolved once in JS (rather than left to SQL's now()) so the dedup
  // lookup below, if the insert conflicts, checks the exact same instant
  // the failed insert attempted — not a fresh now() that could land in a
  // different truncated minute than the row that actually won.
  try {
    await query(
      `INSERT INTO sms_logs (id, agent_id, sender, body, parsed_provider, parsed_amount, parsed_phone, matched_order_id, matched_exchange_order_id, matched_reseller_deposit_id, received_at, transaction_ref, sim_slot, match_failure_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id, agentId, sender, body, parsedProvider ?? null, parsedAmount ?? null, parsedPhone ?? null,
        match?.id ?? null, exchangeMatch?.id ?? null, resellerDepositMatch?.id ?? null,
        effectiveReceivedAt, transactionRef ?? null, simSlot ?? null,
        combinedFailureReason || null,
      ]
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
        (await queryOne<{ id: string; matched_order_id: string | null; matched_exchange_order_id: string | null }>(
          `SELECT id, matched_order_id, matched_exchange_order_id FROM sms_logs WHERE transaction_ref=$1 LIMIT 1`,
          [transactionRef]
        ))) ||
      (await queryOne<{ id: string; matched_order_id: string | null; matched_exchange_order_id: string | null }>(
        `SELECT id, matched_order_id, matched_exchange_order_id FROM sms_logs
         WHERE sender=$1 AND body=$2
           AND date_trunc('minute', received_at AT TIME ZONE 'UTC') = date_trunc('minute', $3::timestamptz AT TIME ZONE 'UTC')
         LIMIT 1`,
        [sender, body, effectiveReceivedAt]
      ));
    if (existing) return buildAlreadyProcessedResult(existing, transactionRef ?? null, effectiveReceivedAt, parsedPhone, parsedAmount);
    throw err;
  }

  // Central Balance Dashboard: automatic balance detection. Best-effort and
  // fully isolated from the payment/order pipeline above — a balance-parse
  // or SIM-resolution failure here must never affect whether this SMS gets
  // matched, deduped, or dialed. Runs regardless of match/duplicate outcome,
  // since the carrier-reported balance is real information either way.
  try {
    const detected = extractBalanceFromSms(body);
    if (detected) {
      const companyId = match?.company_id ?? (await resolveCompanyIdByProviderName(detected.provider));
      const slot = companyId ? await resolveDeviceSlotForCompany(companyId) : null;
      if (slot) {
        await applyBalanceUpdate({
          deviceId: slot.deviceId,
          simSlot: slot.simSlot,
          newBalance: detected.balance,
          companyId,
          orderId: match?.id ?? null,
          smsLogId: id,
          source: "sms",
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Balance auto-detection failed (non-fatal):", err);
  }

  // A company with automation off means the agent must tap through the
  // existing manual verify-payment flow instead of the app auto-dialing.
  const requiresManualApproval = match ? await requiresManualApprovalFor(match.id) : false;

  // Critical fix — prevent duplicate order processing. findMatchingOrder()
  // matches an order purely by status='pending' + amount + phone; nothing
  // "claims" the order at match time, so a second SMS with a different
  // transaction_ref/body arriving before the Agent App's verify-payment call
  // flips the order out of 'pending' could otherwise match this same order
  // again and get its own 'pending' payment_transactions row created for it
  // (this is the exact root cause of the duplicate Order ID rows reported).
  // Proactively reject that here, before ever inserting a second active row.
  if (match && (await hasActivePaymentTransaction(match.id))) {
    return buildDuplicateBlockedResult(id, match, transactionRef ?? null, effectiveReceivedAt, requiresManualApproval);
  }

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

  // Money Exchange's duplicate guard + "matched" activity entry — an
  // exchange order is only ever allowed one linked SMS. A race between two
  // concurrent uploads matching the same order is closed by the same
  // FOR UPDATE SKIP LOCKED candidate lock findMatchingExchangeOrder takes,
  // plus this existence check right before linking.
  if (exchangeMatch) {
    const alreadyLinked = await queryOne<{ id: string }>(
      `SELECT id FROM sms_logs WHERE matched_exchange_order_id=$1 AND id != $2 LIMIT 1`,
      [exchangeMatch.id, id]
    );
    if (alreadyLinked) {
      await query(`UPDATE sms_logs SET matched_exchange_order_id=NULL, match_failure_reason=$1 WHERE id=$2`, [
        `Exchange order ${exchangeMatch.id} already has a matched payment SMS`,
        id,
      ]);
      return buildExchangeDuplicateBlockedResult(id, exchangeMatch.id, transactionRef ?? null);
    }
    // The exact "SMS -> Exchange Order DEX... -> matched" trail requested —
    // visible in the Activity Log the same way every other exchange status
    // change already is.
    await recordActivity({
      adminId: undefined,
      action: "match_exchange_order_sms",
      entityType: "exchange_order",
      entityId: exchangeMatch.id,
      oldValue: null,
      newValue: { smsLogId: id, amountSent: exchangeMatch.amount_sent, transactionRef: transactionRef ?? null, summary: `SMS -> Exchange Order ${exchangeMatch.id} -> matched` },
    });
    // Fully automatic payout pipeline: a matched payment SMS now also
    // advances the order itself (pending -> in_progress), not just links
    // the SMS — this is what lets the Agent App's ExchangeSelfHealSweeper
    // pick it up and dial the payout with no admin/agent tap required. Its
    // own UPDATE...WHERE status='pending' guard makes this safe to call
    // unconditionally: if the order somehow isn't pending anymore (a race,
    // or an admin already verified it by hand), this is just a no-op.
    await autoAdvanceExchangeOrderToInProgress(exchangeMatch.id, { source: "sms_match" });
  }

  // Reseller Deposit: "Once the payment is confirmed, the exact amount is
  // added to the Reseller Wallet" (product instruction) — fully automatic,
  // no admin tap required. confirmResellerDepositViaSms does its own atomic
  // claim (status='pending' CAS) before crediting, so this is safe even if
  // called more than once for the same deposit.
  if (resellerDepositMatch) {
    await confirmResellerDepositViaSms(resellerDepositMatch, id);
  }

  // The ledger row for this genuinely-new payment attempt — 'pending' until
  // the Agent App's verify-payment/dial-attempt calls advance it. A null
  // return means idx_payment_tx_order_active's atomic backstop (migration
  // 028) caught a race the proactive check above missed — two SMS matching
  // the same order in the same instant — so fall back to the identical
  // duplicate-blocked path rather than silently dropping the record. Only
  // relevant for Store orders — exchange orders never touch this ledger.
  const txId = await createPaymentTransaction({
    smsLogId: id,
    orderId: match?.id ?? null,
    transactionRef: transactionRef ?? null,
    customerPhone: parsedPhone ?? null,
    amount: parsedAmount ?? null,
    paymentTimestamp: effectiveReceivedAt,
    status: "pending",
  });

  if (txId == null && match) {
    return buildDuplicateBlockedResult(id, match, transactionRef ?? null, effectiveReceivedAt, requiresManualApproval);
  }

  broadcast({ type: "sms_log.created", smsLogId: id, orderId: match?.id ?? null });
  return {
    status: 201,
    body: {
      id,
      matchedOrderId: match?.id ?? null,
      matchedExchangeOrderId: exchangeMatch?.id ?? null,
      matchedResellerDepositId: resellerDepositMatch?.id ?? null,
      requiresManualApproval,
      duplicate: false,
      status: "new",
    },
  };
}

smsLogsRouter.post("/agent/sms-logs", requireAuth("agent"), async (req, res) => {
  const { sender, body } = req.body ?? {};
  if (!sender || !body) return sendJson(res, 400, { error: "sender and body are required" });
  const result = await ingestPaymentSms({ agentId: req.auth!.sub, ...req.body });
  sendJson(res, result.status, result.body);
});

type OrphanedSmsRow = {
  id: string;
  agent_id: string;
  parsed_amount: number | null;
  parsed_phone: string | null;
  sim_slot: number | null;
  transaction_ref: string | null;
  received_at: string;
};

/**
 * findMatchingOrder only ever runs once, at upload time — if the matching
 * order simply doesn't exist yet (the SMS beat the order-creation call),
 * that SMS was permanently orphaned: matched_order_id is written once at
 * INSERT and never revisited by anything else in this codebase. This
 * re-attempts findMatchingOrder for every still-unmatched
 * SMS in the match window, and — on a fresh match — runs the exact same
 * link -> activity-log -> verify -> generate-USSD chain the live upload
 * path runs inline, so a delayed match still ends up fully processed
 * automatically (the existing self-heal-candidates poll then dials it,
 * same as any other in_progress+ussd_generated order).
 *
 * Best-effort per-row: one bad row's exception is logged and skipped
 * rather than aborting the whole sweep (mirrors selfHealStuckOrders'
 * try/catch convention in ussd.routes.ts).
 */
export async function resweepUnmatchedSmsLogs(): Promise<{ relinked: number; stillUnmatched: number }> {
  const orphans = await query<OrphanedSmsRow>(
    `SELECT id, agent_id, parsed_amount, parsed_phone, sim_slot, transaction_ref, received_at FROM sms_logs
     WHERE matched_order_id IS NULL AND matched_exchange_order_id IS NULL AND matched_reseller_deposit_id IS NULL
       AND received_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
     ORDER BY received_at ASC`
  );
  let relinked = 0;
  for (const sms of orphans) {
    try {
      const { order: match, reason } = await findMatchingOrder(sms.parsed_amount ?? undefined, sms.parsed_phone ?? undefined, sms.agent_id, sms.sim_slot);
      if (match) {
        // Atomically claim this row — a concurrent live upload or another
        // sweep pass may have linked it (or a different SMS to this same
        // order) in the meantime; only proceed if we're the one that wins.
        const claimed = await query<{ id: string }>(
          `UPDATE sms_logs SET matched_order_id=$1, match_failure_reason=NULL WHERE id=$2 AND matched_order_id IS NULL RETURNING id`,
          [match.id, sms.id]
        );
        if (claimed.length === 0) continue;

        const requiresManualApproval = await requiresManualApprovalFor(match.id);
        if (await hasActivePaymentTransaction(match.id)) {
          // The order this SMS now matches was fulfilled by a different
          // payment between its original upload and this sweep pass —
          // record it as a blocked duplicate, same as the live path does.
          await markPaymentTransactionDuplicateForSms(sms.id, match.id);
          await logPaymentActivity({
            action: "duplicate_delivery_prevented",
            smsLogId: sms.id,
            order: match,
            transactionRef: sms.transaction_ref,
            paymentTimestamp: sms.received_at,
            status: "duplicate_blocked",
            requiresManualApproval,
          });
          broadcast({ type: "sms_log.created", smsLogId: sms.id, orderId: match.id });
          continue;
        }

        await linkPaymentTransactionToOrder(sms.id, match.id);
        await logPaymentActivity({
          action: "payment_verified",
          smsLogId: sms.id,
          order: match,
          transactionRef: sms.transaction_ref,
          paymentTimestamp: sms.received_at,
          status: "verified",
          requiresManualApproval,
        });
        if (!requiresManualApproval) {
          const orderRow = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [match.id]);
          if (orderRow) await verifyOrderAndGenerateUssd(orderRow, sms.agent_id);
        }
        broadcast({ type: "sms_log.created", smsLogId: sms.id, orderId: match.id });
        relinked++;
        continue;
      }

      // No Store order match — try Money Exchange next, same as the live
      // upload path does. Never auto-verifies/pays out; only links + logs.
      const { order: exchangeMatch, reason: exchangeReason } = await findMatchingExchangeOrder(
        sms.parsed_amount ?? undefined,
        sms.parsed_phone ?? undefined,
        sms.agent_id,
        sms.sim_slot
      );
      if (exchangeMatch) {
        const alreadyLinked = await queryOne<{ id: string }>(`SELECT id FROM sms_logs WHERE matched_exchange_order_id=$1 LIMIT 1`, [exchangeMatch.id]);
        if (alreadyLinked) {
          await query(`UPDATE sms_logs SET match_failure_reason=$1 WHERE id=$2`, [
            `Exchange order ${exchangeMatch.id} already has a matched payment SMS`,
            sms.id,
          ]);
          continue;
        }
        const claimedExchange = await query<{ id: string }>(
          `UPDATE sms_logs SET matched_exchange_order_id=$1, match_failure_reason=NULL WHERE id=$2 AND matched_order_id IS NULL AND matched_exchange_order_id IS NULL RETURNING id`,
          [exchangeMatch.id, sms.id]
        );
        if (claimedExchange.length === 0) continue;
        await recordActivity({
          adminId: undefined,
          action: "match_exchange_order_sms",
          entityType: "exchange_order",
          entityId: exchangeMatch.id,
          oldValue: null,
          newValue: { smsLogId: sms.id, amountSent: exchangeMatch.amount_sent, transactionRef: sms.transaction_ref, summary: `SMS -> Exchange Order ${exchangeMatch.id} -> matched` },
        });
        // Same automatic pending -> in_progress advance the live upload path
        // makes — a delayed match (the SMS beat the order's creation) still
        // ends up fully automatic, not stuck waiting for a manual verify.
        await autoAdvanceExchangeOrderToInProgress(exchangeMatch.id, { source: "sms_match" });
        relinked++;
        continue;
      }

      // No Store or Exchange match — try Reseller Deposit last, same order
      // as the live upload path. A delayed match here (the SMS beat the
      // deposit-request creation, or the payment method's device wasn't
      // linked yet) still ends up fully credited automatically.
      const { deposit: resellerMatch, reason: resellerReason } = await findMatchingResellerDeposit(
        sms.parsed_amount ?? undefined,
        sms.parsed_phone ?? undefined,
        sms.agent_id,
        sms.sim_slot
      );
      if (!resellerMatch) {
        await query(`UPDATE sms_logs SET match_failure_reason=$1 WHERE id=$2`, [
          [reason, exchangeReason ? `Exchange: ${exchangeReason}` : null, resellerReason ? `Reseller Deposit: ${resellerReason}` : null]
            .filter(Boolean)
            .join(" | "),
          sms.id,
        ]);
        continue;
      }
      const result = await confirmResellerDepositViaSms(resellerMatch, sms.id);
      if (result.credited) relinked++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`resweepUnmatchedSmsLogs failed for sms_log ${sms.id}:`, (err as Error).message);
    }
  }
  return { relinked, stillUnmatched: orphans.length - relinked };
}

// Every 15s (tightened from 30s) — frequent enough that a delayed match
// (the order simply hadn't been created yet when the SMS first arrived, or
// a Super Admin just fixed a payment method's device/SIM assignment)
// resolves within seconds, without needing a bespoke "please retry this
// one" trigger from every place that could unblock it. Bounded to
// MATCH_WINDOW_HOURS worth of rows and best-effort (never throws), so this
// can't grow unbounded or take the process down.
setInterval(() => {
  resweepUnmatchedSmsLogs().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("resweepUnmatchedSmsLogs sweep failed:", (err as Error).message);
  });
}, 15_000);

/** Shared tail for both the proactive check and the unique-index backstop:
 * records this specific attempt as its own 'duplicate_blocked' ledger row
 * (so the audit trail shows every rejected re-delivery, not just the real
 * payment), logs the required "Duplicate delivery prevented" activity entry,
 * and returns the same shape buildAlreadyProcessedResult already returns so
 * the Agent App/dashboard don't need a third response shape to handle. */
async function buildDuplicateBlockedResult(
  smsLogId: string,
  order: OrderMatch,
  transactionRef: string | null,
  paymentTimestamp: string,
  requiresManualApproval: boolean
): Promise<IngestSmsResult> {
  await logPaymentActivity({
    action: "duplicate_delivery_prevented",
    smsLogId,
    order,
    transactionRef,
    paymentTimestamp,
    status: "duplicate_blocked",
    requiresManualApproval,
  });
  await createPaymentTransaction({
    smsLogId,
    orderId: order.id,
    transactionRef,
    customerPhone: order.sender_phone,
    amount: order.amount,
    paymentTimestamp,
    status: "duplicate_blocked",
  });
  broadcast({ type: "sms_log.created", smsLogId, orderId: order.id });
  return {
    status: 200,
    body: {
      id: smsLogId,
      matchedOrderId: order.id,
      requiresManualApproval,
      duplicate: true,
      orderAlreadyCompleted: await orderAlreadyFulfilled(order.id),
      status: "duplicate_blocked",
    },
  };
}

/** Money Exchange's much simpler duplicate guard: unlike Store orders,
 * exchange orders don't have a payment_transactions ledger — an exchange
 * order simply isn't allowed to have more than one linked SMS. Records the
 * same "Duplicate delivery prevented" activity shape as the Store path. */
async function buildExchangeDuplicateBlockedResult(smsLogId: string, exchangeOrderId: string, transactionRef: string | null): Promise<IngestSmsResult> {
  await recordActivity({
    adminId: undefined,
    action: "duplicate_delivery_prevented",
    entityType: "exchange_order",
    entityId: exchangeOrderId,
    oldValue: null,
    newValue: { smsLogId, transactionRef },
  });
  broadcast({ type: "sms_log.created", smsLogId, orderId: null });
  return {
    status: 200,
    body: {
      id: smsLogId,
      matchedOrderId: null,
      matchedExchangeOrderId: null,
      requiresManualApproval: false,
      duplicate: true,
      status: "duplicate_blocked",
    },
  };
}

smsLogsRouter.get("/admin/sms-logs", requireStaff(), async (req, res) => {
  const { agentId, matched, companyId, search, dateFrom, dateTo, limit } = req.query as Record<string, string | undefined>;
  let sql = `
    SELECT sl.*, o.company_id AS matched_company_id, eo.status AS matched_exchange_order_status
    FROM sms_logs sl
    LEFT JOIN orders o ON o.id = sl.matched_order_id
    LEFT JOIN exchange_orders eo ON eo.id = sl.matched_exchange_order_id
    WHERE 1=1`;
  const args: unknown[] = [];
  if (agentId) { args.push(agentId); sql += ` AND sl.agent_id=$${args.length}`; }
  if (matched === "true") sql += ` AND (sl.matched_order_id IS NOT NULL OR sl.matched_exchange_order_id IS NOT NULL)`;
  if (matched === "false") sql += ` AND sl.matched_order_id IS NULL AND sl.matched_exchange_order_id IS NULL`;
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

// Manual approval for an SMS the automatic matcher never linked to an order
// (findMatchingOrder found no eligible order at upload time, and the 15s
// resweep hasn't found one either — e.g. the customer's declared sending
// number doesn't quite match what the SMS shows). A Super Admin who has
// read the raw SMS text and confirms it really is the payment for a
// specific order can point it at that order manually — the exact same
// linkPaymentTransactionToOrder call the automatic resweep makes, just
// admin-triggered instead of matcher-triggered. This only links the
// payment ledger; it never dials anything itself — actually notifying the
// Agent App still requires the separate, explicit "Send to Agent" call
// (POST /admin/orders/:id/recover, below in orders.routes.ts), which now
// works immediately afterward since it only requires a linked payment.
smsLogsRouter.post("/admin/sms-logs/:id/link-order", requirePermission("orders.manage"), async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return sendJson(res, 400, { error: "orderId is required" });

  const sms = await queryOne<any>(`SELECT * FROM sms_logs WHERE id=$1`, [req.params.id]);
  if (!sms) return sendJson(res, 404, { error: "SMS log not found" });
  if (sms.matched_order_id) {
    return sendJson(res, 409, { error: `This SMS is already linked to order ${sms.matched_order_id}.` });
  }

  const order = await queryOne<any>(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (!["pending", "in_progress"].includes(order.status)) {
    return sendJson(res, 409, { error: `Order status '${order.status}' can't accept a payment link.` });
  }

  // Atomic claim, same guard the automatic resweep uses — this row may have
  // matched automatically, or been linked by a concurrent admin request, in
  // the instant between the check above and here.
  const claimed = await query<{ id: string }>(
    `UPDATE sms_logs SET matched_order_id=$1, match_failure_reason=NULL WHERE id=$2 AND matched_order_id IS NULL RETURNING id`,
    [orderId, req.params.id]
  );
  if (claimed.length === 0) {
    return sendJson(res, 409, { error: "This SMS was just linked by another request — refresh and try again." });
  }

  const requiresManualApproval = await requiresManualApprovalFor(orderId);

  if (await hasActivePaymentTransaction(orderId)) {
    // Same real race the live upload path and the resweep both guard
    // against: this order was fulfilled by a different payment between the
    // admin loading this screen and clicking Link.
    await markPaymentTransactionDuplicateForSms(sms.id, orderId);
    await logPaymentActivity({
      action: "duplicate_delivery_prevented",
      smsLogId: sms.id,
      order,
      transactionRef: sms.transaction_ref,
      paymentTimestamp: sms.received_at,
      status: "duplicate_blocked",
      requiresManualApproval,
    });
    broadcast({ type: "sms_log.created", smsLogId: sms.id, orderId });
    return sendJson(res, 409, {
      error: "This order already has an active payment linked to it — this SMS was recorded as a blocked duplicate instead.",
    });
  }

  await linkPaymentTransactionToOrder(sms.id, orderId);
  await logPaymentActivity({
    action: "payment_verified",
    smsLogId: sms.id,
    order,
    transactionRef: sms.transaction_ref,
    paymentTimestamp: sms.received_at,
    status: "verified",
    requiresManualApproval,
  });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "sms_manually_linked",
    entityType: "order",
    entityId: orderId,
    oldValue: null,
    newValue: { smsLogId: sms.id, parsedAmount: sms.parsed_amount, parsedPhone: sms.parsed_phone },
  });
  broadcast({ type: "sms_log.created", smsLogId: sms.id, orderId });

  sendJson(res, 200, { ok: true, orderId, smsLogId: sms.id });
});

// The duplicate-prevention ledger's read side — search/filter/sort for the
// Payment Transactions dashboard panel. Joined to companies/agent_devices
// for display names rather than making the dashboard do a second round-trip.
smsLogsRouter.get("/admin/payment-transactions", requireStaff(), async (req, res) => {
  const { status, search, companyId, deviceId, simSlot, dateFrom, dateTo, limit, offset, orderId } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `
    SELECT pt.*, o.company_id AS order_company_id, c.name AS provider_name, d.name AS device_name
    FROM payment_transactions pt
    LEFT JOIN orders o ON o.id = pt.order_id
    LEFT JOIN companies c ON c.id = o.company_id
    LEFT JOIN agent_devices d ON d.id = pt.agent_device_id
    WHERE 1=1`;
  if (status) { args.push(status); sql += ` AND pt.status=$${args.length}`; }
  if (orderId) { args.push(orderId); sql += ` AND pt.order_id=$${args.length}`; }
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

// Agent App's own "Latest Transactions" dashboard — every payment_transactions
// row this agent's own SMS uploads produced (matched or not, dialed or not),
// newest first. Scoped by sms_logs.agent_id rather than
// payment_transactions.agent_device_id: the latter is only set once a dial
// attempt actually starts (markPaymentProcessing), so a still-'pending' row
// — an SMS that arrived but hasn't been dialed/matched yet — would otherwise
// be invisible here even though it's exactly the kind of row this dashboard
// exists to surface. sms_logs.agent_id is set once, at upload time, and never
// changes, so it's a stable "this came from my phone" identity throughout
// the whole pending -> processing -> completed/failed/duplicate_blocked
// lifecycle.
smsLogsRouter.get("/agent/payment-transactions", requireAuth("agent"), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await query(
    `SELECT pt.id, pt.order_id, pt.customer_phone, pt.amount, pt.status, pt.created_at,
            sl.sender AS sms_sender, c.name AS provider_name
     FROM payment_transactions pt
     JOIN sms_logs sl ON sl.id = pt.sms_log_id
     LEFT JOIN orders o ON o.id = pt.order_id
     LEFT JOIN companies c ON c.id = o.company_id
     WHERE sl.agent_id = $1
     ORDER BY pt.created_at DESC
     LIMIT $2`,
    [req.auth!.sub, limit]
  );
  sendJson(res, 200, rows);
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

// Critical-fix warning badge: every payment_transactions row blocked as a
// duplicate (mirrors stuck-count's exact shape) — this is what proves the
// duplicate-order-processing guard actually caught something, so the
// dashboard can surface it as a warning rather than the admin only finding
// out from a customer complaint.
smsLogsRouter.get("/admin/payment-transactions/duplicate-count", requireStaff(), async (req, res) => {
  const thresholdMinutes = Math.min(Number(req.query.minutes) || 1440, 43200);
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM payment_transactions
     WHERE status = 'duplicate_blocked'
       AND created_at > now() - ($1 || ' minutes')::interval`,
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

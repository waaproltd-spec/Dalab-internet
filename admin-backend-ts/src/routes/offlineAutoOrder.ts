import { query, queryOne } from "../db/pool.js";
import { broadcast } from "../realtime/orderEvents.js";
import { companyKeyFromLabel } from "../lib/phoneValidation.js";

/**
 * Offline Auto-Order: a customer with no internet can't open the app to
 * place an order, so they instead send the exact package price straight to
 * the provider's payment number from their registered sender number — this
 * module is what turns that incoming payment SMS into a real order with no
 * app interaction at all, using the customer's own saved Offline Profile
 * (customers.offline_*, migration 065) instead of a pre-existing pending
 * order.
 *
 * Deliberately its own module rather than inline in smsLogs.routes.ts, same
 * reasoning as resellerSmsMatching.ts: this is a clearly separate matching
 * concern from findMatchingOrder's "does a pending order already exist"
 * check, only ever consulted once that check has already found nothing —
 * see ingestPaymentSms, which only calls matchOrCreateOfflineAutoOrder when
 * the Store matcher's own findMatchingOrder returned no candidate. A real
 * pending online order for this exact payment always wins first.
 *
 * Everything this creates flows through the EXACT same downstream pipeline
 * a matched online order already does — payment_transactions ledger row,
 * requiresManualApproval (a company with automation off still needs an
 * agent's tap, same as any other order), and the Agent App's own existing
 * verify-payment → generate-USSD → dial → complete chain (SmsUploadFlow.kt
 * calls that automatically the instant this function's caller returns a
 * matchedOrderId with requiresManualApproval=false) — nothing about
 * fulfillment itself is reimplemented here, only how the order gets
 * created in the first place.
 */

function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

function orderRef(): string {
  return "DLB" + Math.floor(100000000 + Math.random() * 900000000);
}

// Matches the "Tar: 29/08/26 22:12:34" date+time Hormuud's own SMS already
// includes — deliberately requires BOTH date and time to-the-second, not
// date alone (see buildHormuudEvcPlusFallbackRef below for why).
const HORMUUD_TAR_DATETIME_PATTERN = /Tar:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}:\d{2})/i;

/**
 * Hormuud EVC Plus's real "waxaad ... ka heshay ..." confirmation SMS has
 * no distinct transaction-reference field at all (unlike e.g. Somtel
 * eDahab's "Aqanoosiga" code) — the hard transactionRef requirement below
 * made Offline Auto-Order structurally impossible for Hormuud regardless of
 * how correctly everything else in this file worked. This builds a
 * deterministic, synthetic dedup key from fields already stable in the
 * message itself — the sender phone, the amount, and the SMS's own "Tar:"
 * date+time — nothing invented, only repurposed.
 *
 * Deliberately requires the FULL to-the-second timestamp, not the date
 * alone: two genuinely different real payments from the same sender for the
 * same amount essentially never land in the same second, but two on the
 * same day are a completely ordinary occurrence (repeat top-ups) that a
 * date-only key would wrongly collapse into a single order. Returns null —
 * never a best-effort guess — the instant anything expected is missing or
 * doesn't parse: this only ever makes Offline Auto-Order MORE available for
 * Hormuud, never less safe than the hard-reference requirement it stands in
 * for. Every other provider's real transactionRef (or lack of one) is
 * completely unaffected — this is only ever consulted when parsedProvider
 * is exactly "Hormuud" and the caller has no real transactionRef already.
 */
function buildHormuudEvcPlusFallbackRef(
  parsedProvider: string | null | undefined,
  parsedPhone: string,
  parsedAmount: number,
  body: string | null | undefined
): string | null {
  if (parsedProvider !== "Hormuud" || !body) return null;
  const match = HORMUUD_TAR_DATETIME_PATTERN.exec(body);
  if (!match) return null;
  const [, date, time] = match;
  const phone = normalizePhone(parsedPhone);
  if (!phone) return null;
  return `SYN-HORMUUD-${phone}-${parsedAmount.toFixed(2)}-${date}-${time}`;
}

// Mirrors orders.routes.ts's own MACAASH_POINTS_PER_DOLLAR — kept as a
// separate local constant rather than exported/imported, same as this
// codebase's existing convention for small shared literals (see e.g.
// normalizePhone above, duplicated identically in three matcher modules).
const MACAASH_POINTS_PER_DOLLAR = 10;

export type OfflineAutoOrderMatch = {
  id: string;
  sender_phone: string | null;
  receiver_phone: string | null;
  amount: number;
  company_id: string;
  payment_method_id: string | null;
};

export type OfflineAutoOrderMatchResult = { order: OfflineAutoOrderMatch | null; reason: string | null };

/**
 * Confirms the incoming SMS really did arrive via THIS company's own
 * collection channel — the same device/SIM guardrail findMatchingOrder
 * applies for online orders (company_payment_methods), plus one extra,
 * cheaper check specific to this path: if the SMS's own carrier-parsed
 * provider name is known and doesn't match the profile's company at all,
 * reject outright. This is what stops a Somtel/Somnet/Amtel payment from
 * ever being routed onto a Hormuud-registered Offline Profile (or vice
 * versa) — spec requirement 9.
 */
async function verifyOfflineCompanyMatch(
  companyId: string,
  companyName: string,
  parsedProvider: string | null | undefined,
  uploadingAgentId: string,
  uploadingSimSlot: number | null | undefined
): Promise<{ ok: boolean; reason: string | null }> {
  if (parsedProvider) {
    const expectedKey = companyKeyFromLabel(companyName);
    const parsedKey = companyKeyFromLabel(parsedProvider);
    if (expectedKey && parsedKey && expectedKey !== parsedKey) {
      return { ok: false, reason: `SMS provider "${parsedProvider}" does not match the Offline Profile's company (${companyName})` };
    }
  }

  const methods = await query<{ id: string; device_id: string | null; sim_slot: number | null }>(
    `SELECT id, device_id, sim_slot FROM company_payment_methods WHERE company_id=$1 AND enabled=true`,
    [companyId]
  );
  if (methods.length === 0) return { ok: true, reason: null }; // legacy company, no specific number to verify against — same trust level findMatchingOrder gives it

  const uploadingAgent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [uploadingAgentId]);
  const uploadingDeviceId = uploadingAgent?.device_id ?? null;

  for (const method of methods) {
    if (!method.device_id) return { ok: true, reason: null }; // not linked to a device yet — accept, same fallback findMatchingOrder uses
    if (method.device_id !== uploadingDeviceId) continue;
    if (method.sim_slot != null && method.sim_slot !== uploadingSimSlot) continue;
    return { ok: true, reason: null };
  }
  return { ok: false, reason: `SMS arrived on a device/SIM not configured for ${companyName}'s payment collection` };
}

/**
 * This function creates the order itself (rather than only reading one,
 * like findMatchingOrder) because sms_logs.matched_order_id is a foreign
 * key — the order must already exist before the SMS row that references it
 * can be inserted. Two truly concurrent calls carrying the identical
 * effective reference (a live upload racing a resweep pass, or two resweep
 * passes landing on the same still-unmatched row — see
 * resweepUnmatchedSmsLogs in smsLogs.routes.ts) are resolved atomically at
 * the database level via the orders.offline_auto_dedup_key partial unique
 * index (069_offline_auto_order_dedup.sql): the INSERT below uses
 * ON CONFLICT ... DO NOTHING, and the caller that loses the race reads back
 * and returns the order the winner just created, rather than either
 * reporting "unmatched" or creating a second order.
 */
export async function matchOrCreateOfflineAutoOrder(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined,
  parsedProvider: string | null | undefined,
  transactionRef: string | null | undefined,
  uploadingAgentId: string,
  uploadingSimSlot: number | null | undefined,
  body?: string | null
): Promise<OfflineAutoOrderMatchResult> {
  if (parsedAmount == null || !parsedPhone) return { order: null, reason: null };

  // A payment that can't be safely deduplicated must never silently create a
  // real order (spec: "Missing/Invalid Transaction ID"). The online path
  // tolerates a null transactionRef because a human agent still taps Verify
  // Payment before anything is dialed — there is no such human check on
  // this fully-automatic path, so a real reference is a hard requirement
  // here specifically. Every provider with a real reference keeps requiring
  // one, completely unchanged; Hormuud EVC Plus (which never has one) gets
  // one shot at a safe, deterministic fallback before this rejects it — see
  // buildHormuudEvcPlusFallbackRef above.
  const effectiveTransactionRef = transactionRef || buildHormuudEvcPlusFallbackRef(parsedProvider, parsedPhone, parsedAmount, body);
  if (!effectiveTransactionRef) {
    return { order: null, reason: "requires a transaction reference to safely dedupe — SMS had none" };
  }

  const target = normalizePhone(parsedPhone);
  if (!target) return { order: null, reason: null };

  // Primary customer-matching key (spec requirement 8): the registered
  // Offline sender number. All four Offline fields are always saved
  // together (see customers.routes.ts's PUT /customer/offline-profile), so
  // requiring all four here just guards against a partially-migrated or
  // hand-edited row rather than any real partial-save state this API can
  // produce.
  const candidates = await query<{
    id: string;
    offline_sender_number: string;
    offline_destination_number: string;
    offline_company_id: string;
    offline_package_id: string;
  }>(
    `SELECT id, offline_sender_number, offline_destination_number, offline_company_id, offline_package_id
     FROM customers
     WHERE offline_sender_number IS NOT NULL AND offline_destination_number IS NOT NULL
       AND offline_company_id IS NOT NULL AND offline_package_id IS NOT NULL
       AND status='active'
       AND RIGHT(regexp_replace(offline_sender_number, '\\D', '', 'g'), 9) = $1`,
    [target]
  );
  if (candidates.length === 0) return { order: null, reason: null }; // no Offline Profile for this sender — not an offline-specific failure worth logging
  if (candidates.length > 1) {
    return { order: null, reason: `${candidates.length} Offline Profiles are registered for phone ...${target} — ambiguous, refusing to auto-order` };
  }
  const profile = candidates[0];

  const company = await queryOne<{ id: string; name: string; status: string; payment_number: string | null; payment_ussd_template: string | null }>(
    `SELECT id, name, status, payment_number, payment_ussd_template FROM companies WHERE id=$1 AND deleted_at IS NULL`,
    [profile.offline_company_id]
  );
  if (!company) return { order: null, reason: "Offline Profile's saved company no longer exists" };
  if (company.status === "offline") return { order: null, reason: `${company.name} is currently offline` };

  const pkg = await queryOne<{ id: string; price: string; provider_amount: string | null; company_id: string }>(
    `SELECT id, price, provider_amount, company_id FROM packages WHERE id=$1 AND active=true`,
    [profile.offline_package_id]
  );
  if (!pkg || pkg.company_id !== company.id) {
    return { order: null, reason: "Offline Profile's saved package is no longer valid for its company" };
  }

  // Package + amount matching (spec requirement 10) — the package is
  // already fixed by the profile, never chosen by amount; this only
  // confirms the payment actually matches what that specific package costs.
  if (Math.abs(parsedAmount - Number(pkg.price)) >= 0.01) {
    return { order: null, reason: `Offline Profile expects $${pkg.price} for its package but the payment was $${parsedAmount}` };
  }

  const companyCheck = await verifyOfflineCompanyMatch(company.id, company.name, parsedProvider, uploadingAgentId, uploadingSimSlot);
  if (!companyCheck.ok) return { order: null, reason: companyCheck.reason };

  const id = orderRef();
  const price = Number(pkg.price);
  const inserted = await query<{ id: string }>(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, sender_phone, receiver_phone, payment_method, channel, macaash_earned, payment_number_used, payment_ussd_template_used, offline_auto_dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,'offline_auto',$10,$11,$12,$13)
     ON CONFLICT (offline_auto_dedup_key) WHERE offline_auto_dedup_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      id,
      profile.id,
      company.id,
      pkg.id,
      price,
      pkg.provider_amount ?? price,
      // The customer's own saved numbers — never re-entered, never
      // overridden by anything the SMS itself parsed (spec requirement 11).
      profile.offline_sender_number,
      profile.offline_destination_number,
      company.name,
      Math.round(price * MACAASH_POINTS_PER_DOLLAR),
      company.payment_number,
      company.payment_ussd_template,
      effectiveTransactionRef,
    ]
  );

  if (inserted.length === 0) {
    // Lost the atomic race — a concurrent call already created the order
    // for this exact reference. Return THAT order rather than reporting
    // "unmatched" and losing the payment, or creating a second one.
    const existing = await queryOne<{
      id: string;
      company_id: string;
      sender_phone: string | null;
      receiver_phone: string | null;
      amount: string;
    }>(`SELECT id, company_id, sender_phone, receiver_phone, amount FROM orders WHERE offline_auto_dedup_key=$1`, [effectiveTransactionRef]);
    if (!existing) {
      // Unreachable in practice — DO NOTHING only fires when a conflicting
      // row already exists — but fail safe rather than silently drop the
      // payment if it somehow ever is.
      return { order: null, reason: "concurrent Offline Auto-Order creation could not be resolved" };
    }
    return {
      order: {
        id: existing.id,
        sender_phone: existing.sender_phone,
        receiver_phone: existing.receiver_phone,
        amount: Number(existing.amount),
        company_id: existing.company_id,
        payment_method_id: null,
      },
      reason: null,
    };
  }

  broadcast({ type: "order.created", orderId: id });

  return {
    order: {
      id,
      sender_phone: profile.offline_sender_number,
      receiver_phone: profile.offline_destination_number,
      amount: price,
      company_id: company.id,
      payment_method_id: null,
    },
    reason: null,
  };
}

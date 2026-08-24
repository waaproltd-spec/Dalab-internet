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
 * Note on a narrow theoretical race: this function creates the order itself
 * (rather than only reading one, like findMatchingOrder) because sms_logs.
 * matched_order_id is a foreign key — the order must already exist before
 * the SMS row that references it can be inserted. If the exact same
 * transactionRef were somehow uploaded via two truly concurrent requests
 * (not a redelivery — ingestPaymentSms already rejects that before this is
 * ever called), both could theoretically pass this function before either
 * has inserted its sms_logs row, creating two orders where only one gets
 * linked. This is not a double-fulfillment risk (only the linked order ever
 * gets a payment_transactions row, so only it can be verified/dialed) — at
 * worst it leaves a second, harmless 'pending' order visible for an admin
 * to notice and cancel. Given how narrow the window is (two requests for
 * the literal same SMS, not two different payments), this is the same
 * order of risk the rest of this codebase already accepts elsewhere (see
 * findMatchingOrder's own comment on its candidate lock only protecting the
 * SELECT itself, not the full pending → in_progress transition).
 */
export async function matchOrCreateOfflineAutoOrder(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined,
  parsedProvider: string | null | undefined,
  transactionRef: string | null | undefined,
  uploadingAgentId: string,
  uploadingSimSlot: number | null | undefined
): Promise<OfflineAutoOrderMatchResult> {
  if (parsedAmount == null || !parsedPhone) return { order: null, reason: null };

  // A payment that can't be safely deduplicated must never silently create a
  // real order (spec: "Missing/Invalid Transaction ID"). The online path
  // tolerates a null transactionRef because a human agent still taps Verify
  // Payment before anything is dialed — there is no such human check on
  // this fully-automatic path, so a real reference is a hard requirement
  // here specifically.
  if (!transactionRef) {
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
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, sender_phone, receiver_phone, payment_method, channel, macaash_earned, payment_number_used, payment_ussd_template_used)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,'offline_auto',$10,$11,$12)`,
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
    ]
  );
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

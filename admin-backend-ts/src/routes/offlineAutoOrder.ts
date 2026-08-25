import { query, queryOne } from "../db/pool.js";
import { broadcast } from "../realtime/orderEvents.js";

/**
 * Offline Auto-Order: a customer with no internet can't open the app to
 * place an order, so they instead send the exact package price straight to
 * the provider's payment number from their registered sender number — this
 * module is what turns that incoming payment SMS into a real order with no
 * app interaction at all, using the customer's own saved Offline Profile
 * (customers.offline_*, migrations 065/066) instead of a pre-existing
 * pending order. The profile's offline_payment_method_id (066) pins it to
 * one specific company_payment_methods row -- EVC Plus/eDahab/JEEB/... --
 * exactly like an Online order's own payment_method_id, so provider
 * identity is verified the same mechanical device/SIM way findMatchingOrder
 * already does, not a separate parallel check.
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

type OfflinePaymentMethodInfo = { id: string; label: string; payment_number: string | null; ussd_template: string | null };

/**
 * Confirms the incoming SMS really did arrive via the customer's own
 * configured payment method's collection channel — the EXACT same
 * device/SIM verification findMatchingOrder (smsLogs.routes.ts) applies to
 * an Online order's own payment_method_id, reused here rather than
 * reinvented (per spec: don't build a separate/weaker matching system for
 * Offline Auto-Order). This replaces the previous provider-name-string
 * heuristic (comparing the SMS's parsed carrier name against the profile's
 * company name) entirely — Online never does a string comparison like that
 * either; provider identity is established purely by which physical
 * device/SIM the payment SMS actually arrived on, which is what
 * distinguishes a genuine EVC Plus payment from an eDahab one even when
 * both happen to be collected for the same company.
 *
 * A profile with no payment method configured (offline_payment_method_id
 * null — either saved before this field existed, or the company has none
 * configured) is treated exactly like a legacy order with no
 * payment_method_id: accepted at the same trust level findMatchingOrder
 * already gives that case.
 */
async function verifyOfflinePaymentMethod(
  paymentMethodId: string | null,
  uploadingAgentId: string,
  uploadingSimSlot: number | null | undefined
): Promise<{ ok: boolean; reason: string | null; paymentMethod: OfflinePaymentMethodInfo | null }> {
  if (!paymentMethodId) return { ok: true, reason: null, paymentMethod: null };

  const method = await queryOne<{
    id: string;
    label: string;
    payment_number: string | null;
    ussd_template: string | null;
    device_id: string | null;
    sim_slot: number | null;
  }>(`SELECT id, label, payment_number, ussd_template, device_id, sim_slot FROM company_payment_methods WHERE id=$1`, [paymentMethodId]);
  if (!method) return { ok: false, reason: "Offline Profile's saved payment method no longer exists", paymentMethod: null };
  const methodInfo: OfflinePaymentMethodInfo = {
    id: method.id,
    label: method.label,
    payment_number: method.payment_number,
    ussd_template: method.ussd_template,
  };

  const uploadingAgent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [uploadingAgentId]);
  const uploadingDeviceId = uploadingAgent?.device_id ?? null;

  if (!method.device_id) {
    // Not yet linked to a device — accept (same fallback findMatchingOrder
    // uses) and auto-link this method to the device/slot this SMS just
    // arrived on, since a real amount+phone-matched payment is concrete
    // proof that's where it's collected. Every payment after this one is
    // strictly verified against the link just learned here.
    if (uploadingDeviceId) {
      await query(`UPDATE company_payment_methods SET device_id=$1, sim_slot=COALESCE(sim_slot, $2) WHERE id=$3`, [
        uploadingDeviceId,
        uploadingSimSlot ?? null,
        method.id,
      ]);
    }
    return { ok: true, reason: null, paymentMethod: methodInfo };
  }
  if (method.device_id !== uploadingDeviceId) {
    return {
      ok: false,
      reason: `SMS arrived on a device not configured for ${method.label}'s payment collection (expects device ${method.device_id}, got ${uploadingDeviceId ?? "(agent has no device_id set)"})`,
      paymentMethod: null,
    };
  }
  if (method.sim_slot != null && method.sim_slot !== uploadingSimSlot) {
    return {
      ok: false,
      reason: `SMS arrived on the wrong SIM slot for ${method.label}'s payment collection (expects slot ${method.sim_slot}, got ${uploadingSimSlot ?? "(unresolved)"})`,
      paymentMethod: null,
    };
  }
  return { ok: true, reason: null, paymentMethod: methodInfo };
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
    offline_payment_method_id: string | null;
  }>(
    `SELECT id, offline_sender_number, offline_destination_number, offline_company_id, offline_package_id, offline_payment_method_id
     FROM customers
     WHERE offline_sender_number IS NOT NULL AND offline_destination_number IS NOT NULL
       AND offline_company_id IS NOT NULL AND offline_package_id IS NOT NULL
       AND status='active'
       AND RIGHT(regexp_replace(offline_sender_number, '\\D', '', 'g'), 9) = $1`,
    [target]
  );
  // No Offline Profile registered for this sender -- always logged (never
  // silent) so an admin reviewing Payment History can tell "this customer
  // simply hasn't set up Offline Auto-Order" apart from every other failure
  // reason, rather than seeing a blank Offline Auto-Order segment.
  if (candidates.length === 0) return { order: null, reason: `No Offline Profile registered for phone ...${target}` };
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

  const methodCheck = await verifyOfflinePaymentMethod(profile.offline_payment_method_id, uploadingAgentId, uploadingSimSlot);
  if (!methodCheck.ok) return { order: null, reason: methodCheck.reason };
  const method = methodCheck.paymentMethod;

  const id = orderRef();
  const price = Number(pkg.price);
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, provider_amount, status, sender_phone, receiver_phone, payment_method, channel, macaash_earned, payment_number_used, payment_ussd_template_used, payment_method_id)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,'offline_auto',$10,$11,$12,$13)`,
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
      // Same precedence orders.routes.ts's own POST /orders uses:
      // the specific method's own label/number/template when one is
      // configured, falling back to the company's single legacy
      // number/template only when it isn't.
      method?.label || company.name,
      Math.round(price * MACAASH_POINTS_PER_DOLLAR),
      method?.payment_number || company.payment_number,
      method?.ussd_template || company.payment_ussd_template,
      profile.offline_payment_method_id,
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
      payment_method_id: profile.offline_payment_method_id,
    },
    reason: null,
  };
}

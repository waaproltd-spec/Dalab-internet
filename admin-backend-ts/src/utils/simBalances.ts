import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { broadcast } from "../realtime/orderEvents.js";

/**
 * Balance-mention patterns, EXTRACTION ONLY — pulls the number out of a
 * confirmed real "remaining balance" phrase, but never guesses which
 * provider sent it. That used to be a single hardcoded label per pattern
 * (see git history), which was flatly wrong: several providers phrase their
 * own remaining-balance line identically —
 *   - Hormuud EVC Plus:            "...haraagagu waa $2.965." (real carrier
 *     spelling — one fewer "a" than the phrase below)
 *   - Hormuud E-Voucher (provider/dial SIM): "...Haraagaagu waa $1.64."
 *   - Somnet/Jeeb:                 "...Haraagaagu waa $0.19."
 *   - Somtel (reseller-transfer confirmation, no "$"): "Haraagaagu waa: 5.50."
 * A hardcoded "this phrase always means Somnet" mapping silently attributed
 * Hormuud's own balance to Somnet's dashboard card. Attribution is now done
 * separately and reliably — see resolveCompanyForDeviceSlot below — by which
 * physical device+SIM-slot the SMS actually arrived on, the same signal
 * findMatchingOrder (smsLogs.routes.ts) already trusts for payment-number
 * verification. A body that doesn't match any of these simply yields no
 * automatic update, never a wrong one.
 */
const BALANCE_VALUE_PATTERNS: Array<{ regex: RegExp; kind?: string }> = [
  // eDahab/Somtel: "Haraagaaga Cusubi Waa: 31.34 Dollar" — its "Cusubi"/
  // "Dollar" wording never collides with the generic pattern below.
  { regex: /Haraagaaga\s+Cusubi\s+Waa\s*:?\s*([\d,]+(?:\.\d+)?)\s*Dollar/i },
  // Hormuud's own Evoucher-stock purchase confirmation: "[-EVCPlus-]Waxaad
  // iibsatay Evoucher $0.6. Haraagaaga Evoucher-ka waa $0.61." — confirmed
  // live on Hormuud's sender "740", the SAME sender as its plain Send Data
  // balance below, but a genuinely separate balance (reseller Evoucher
  // stock, not the Send Data SIM's own airtime, and not the EVC Plus
  // wallet either, which is sender 192). "kind" lets resolveBalanceProvider
  // disambiguate it from the generic "Haraag(a?a)gu waa" pattern right
  // below, which this text would otherwise also partially resemble.
  { regex: /Evoucher-ka\s+waa\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i, kind: "hormuud_evoucher" },
  // Hormuud (EVC Plus + E-Voucher) and Somnet/Jeeb all phrase their own
  // remaining balance as some spelling of "Haraag(a)agu waa", with or
  // without a "$" sign, with a colon or plain space before the number.
  { regex: /Haraag(?:a?a)gu\s+waa\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i },
  // Amtel: "Now your balance is $+1.15." — the literal "+" before the
  // digits is part of Amtel's own SMS format (also on its "Amount is
  // $+1.00" line), not a typo to strip.
  { regex: /balance\s+is\s*\$?\+?\s*([\d,]+(?:\.\d+)?)/i },
];

export function extractBalanceFromSms(body: string): { balance: number; kind?: string } | null {
  for (const pattern of BALANCE_VALUE_PATTERNS) {
    const match = pattern.regex.exec(body);
    if (match) {
      const balance = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(balance)) return pattern.kind ? { balance, kind: pattern.kind } : { balance };
    }
  }
  return null;
}

/**
 * Which company's own provider SIM is registered at this exact physical
 * device+slot — the forward direction of sim_routing (device+slot -> company),
 * the same table the dashboard/USSD dialing already trust as the source of
 * truth for "which SIM belongs to which provider". Deliberately does NOT fall
 * back to guessing across slots when simSlot is unresolved: an unresolved
 * slot means we genuinely don't know which of a dual-purpose device's SIMs
 * received this SMS, and a balance update must never be attributed to a
 * provider we're not certain about.
 */
export async function resolveCompanyForDeviceSlot(deviceId: string, simSlot: number): Promise<string | null> {
  const row = await queryOne<{ company_id: string }>(
    `SELECT company_id FROM sim_routing WHERE device_id=$1 AND sim_slot=$2 ORDER BY priority ASC LIMIT 1`,
    [deviceId, simSlot]
  );
  return row?.company_id ?? null;
}

/**
 * Six provider identities a balance-report SMS can genuinely come from —
 * the 4 top-up companies (Hormuud, Somtel, Somnet, Amtel) plus their own
 * EVC Plus / eDahab mobile-money collection SIMs, each of which is its own
 * physical device+slot (company_payment_methods.device_id/sim_slot,
 * 036_payment_method_device.sql — deliberately a different phone from the
 * one dialing top-up USSD, so it's almost never also in sim_routing).
 * Checked first: a device+slot registered as an EVC Plus/eDahab collection
 * method is that identity (and that method's OWN company_id — e.g.
 * Hormuud for evc_plus, Somtel for edahab — is what sim_balances gets
 * attributed to, same as any other provider) even if it also happens to
 * appear in sim_routing; otherwise falls back to sim_routing's top-up
 * company, then the caller's own fallback company (e.g. a matched order's
 * company — same fallback resolveCompanyForDeviceSlot's caller in
 * smsLogs.routes.ts already used before this function existed).
 *
 * providerIdentity is the company's own NAME, lowercased — not its
 * id/primary key. companies.id happens to already equal the lowercase name
 * in production ('hormuud', 'somtel', ...), but BALANCE_SENDER_ID below
 * must never be keyed to a raw id string that a differently-seeded
 * environment (or a test fixture using its own throwaway id) could give a
 * different value — name is the one thing every environment agrees
 * actually identifies the provider. evc_plus/edahab are returned as their
 * own literal identity (never resolved to a company name) since they are
 * genuinely a different Sender ID from that same company's own top-up SIM.
 */
export async function resolveBalanceProvider(
  deviceId: string,
  simSlot: number,
  sender: string | null | undefined,
  fallbackCompanyId?: string | null,
  providerHint?: string | null
): Promise<{ companyId: string | null; providerIdentity: string | null }> {
  const candidates: Array<{ companyId: string; providerIdentity: string }> = [];

  // Filtered to ONLY the methods this function knows how to interpret --
  // a device+slot can carry other, unrelated company_payment_methods rows
  // (e.g. JEEB) that have nothing to do with balance identity resolution.
  // Without this filter, LIMIT 1 with no ORDER BY can nondeterministically
  // return one of those unrelated rows instead of the real evc/edahab one
  // sharing the same slot -- confirmed live (production Mobile 1/SIM 1 has
  // both Hormuud's own 'evc' row and Amtel's unrelated 'jeeb' row).
  const method = await queryOne<{ method: string; company_id: string }>(
    `SELECT method, company_id FROM company_payment_methods
     WHERE device_id=$1 AND sim_slot=$2 AND enabled=true AND method IN ('evc','evc_plus','edahab')
     LIMIT 1`,
    [deviceId, simSlot]
  );
  if (method?.method === "evc" || method?.method === "evc_plus") {
    candidates.push({ companyId: method.company_id, providerIdentity: "evc_plus" });
  } else if (method?.method === "edahab") {
    candidates.push({ companyId: method.company_id, providerIdentity: "edahab" });
  }

  const routedCompanyId = (await resolveCompanyForDeviceSlot(deviceId, simSlot)) ?? fallbackCompanyId ?? null;
  if (routedCompanyId) {
    const company = await queryOne<{ name: string }>(`SELECT name FROM companies WHERE id=$1`, [routedCompanyId]);
    if (company?.name) {
      const baseIdentity = company.name.trim().toLowerCase();
      // A company's own Sender ID can itself be overloaded across more than
      // one balance type -- confirmed live: Hormuud's "740" sends both its
      // plain Send Data balance AND a separate Evoucher-stock purchase
      // confirmation, with no wording difference sender-matching alone can
      // use to tell them apart (both candidates below would satisfy the
      // exact same Sender ID check). providerHint (extractBalanceFromSms's
      // own "kind", set only when the SMS body matched that specific
      // pattern) is what disambiguates -- pushed BEFORE the generic company
      // identity so the .find() below prefers it when both match the
      // sender; never applied outside the same company this identity was
      // already routed to.
      if (providerHint === "hormuud_evoucher" && baseIdentity === "hormuud") {
        candidates.push({ companyId: routedCompanyId, providerIdentity: "hormuud_evoucher" });
      }
      candidates.push({ companyId: routedCompanyId, providerIdentity: baseIdentity });
    }
  }

  if (candidates.length === 0) return { companyId: null, providerIdentity: null };

  // A device+slot can legitimately carry TWO identities at once: its own
  // company's Send Data line AND an EVC Plus/eDahab collection line, both
  // on the exact same physical SIM -- confirmed live for Hormuud's Mobile
  // 1/SIM 1, which sends both "[-E-Voucher-]... Haraagaagu waa $X" (sender
  // 740) and "[-EVCPLUS-]... haraagagu waa $Y" (sender 192). Which one a
  // given SMS actually is comes down to which candidate's own Sender ID
  // the message matches -- never a fixed priority order (checking
  // company_payment_methods unconditionally first was the exact bug: a
  // real "740" Send Data SMS got misidentified as "evc_plus" and rejected,
  // because that device+slot also had an evc_plus row). No match at all
  // just reports the first candidate, purely so the caller's own mismatch
  // log line names a real identity instead of nothing.
  const matched = candidates.find((c) => isExpectedBalanceSender(c.providerIdentity, sender));
  return matched ?? candidates[0];
}

/**
 * The exact SMS Sender ID each provider's own balance-report SMS arrives
 * from, exactly as the raw incoming sender appears — no "sms" prefix/suffix
 * added or assumed. Confirmed against real device SMS (e.g. EVC Plus's own
 * balance SMS arrives from the bare sender "192", not "192sms" — an earlier
 * version of this map guessed "192sms" and every real EVC Plus balance SMS
 * was silently rejected as a sender mismatch until corrected here).
 * Never guessed or shared across providers. Used ONLY to gate automatic
 * balance-SMS detection (smsLogs.routes.ts); the manual override endpoint
 * (PUT /admin/sim-balances/:deviceId/:simSlot) is unaffected — it has no
 * SMS sender to check in the first place (e.g. Amtel, which has no
 * balance-report SMS to auto-detect from at all).
 */
export const BALANCE_SENDER_ID: Record<string, string> = {
  evc_plus: "192",
  edahab: "edahab",
  hormuud: "740",
  somtel: "Reseller",
  amtel: "913",
  somnet: "801",
  // Hormuud's own Evoucher-stock balance -- same raw sender as its plain
  // Send Data line above (both "740"), disambiguated by message content
  // via providerHint in resolveBalanceProvider, not by sender ID.
  hormuud_evoucher: "740",
};

/**
 * Strict match only — no fallback to another provider's Sender ID, and no
 * match at all for a provider identity this file doesn't recognize.
 * Case-insensitive/trimmed since the exact casing an SMS sender ID arrives
 * with can vary slightly by carrier delivery, but the sender itself must
 * still be this exact provider's own registered ID, never a substring or
 * fuzzy match against a different provider's.
 */
export function isExpectedBalanceSender(providerIdentity: string, sender: string | null | undefined): boolean {
  const expected = BALANCE_SENDER_ID[providerIdentity];
  if (!expected) return false;
  return String(sender ?? "").trim().toLowerCase() === expected.toLowerCase();
}

export async function applyBalanceUpdate(params: {
  deviceId: string;
  simSlot: number;
  newBalance: number;
  companyId?: string | null;
  providerKey?: string | null;
  phoneNumber?: string | null;
  orderId?: string | null;
  smsLogId?: string | null;
  source: "sms" | "manual";
  changedBy?: string | null;
}): Promise<void> {
  // A single physical SIM can report TWO genuinely separate balances via
  // two different carrier SMS types from the same number -- confirmed
  // live: Hormuud's Mobile 1/SIM 1 sends both its own Send Data balance
  // ("[-E-Voucher-]... Haraagaagu waa $X", sender 740) and its EVC Plus
  // mobile-money wallet balance ("[-EVCPLUS-]... haraagagu waa $Y",
  // sender 192) -- not the same value reported twice, two different real
  // balances. Matching on provider_key too (not just device+slot) is what
  // keeps them as two rows instead of the second one silently overwriting
  // the first (095_sim_balance_provider_key.sql's original device+slot-
  // only uniqueness let exactly this happen: an EVC Plus update reset
  // Hormuud's own Send Data row's provider_key, making its dashboard card
  // revert to "Unknown"). IS NOT DISTINCT FROM (not =) so a NULL
  // providerKey still matches an existing NULL-provider_key row, same
  // COALESCE-preserve semantics as everywhere else in this function.
  const existing = await queryOne<{ id: string; balance: string | null }>(
    `SELECT id, balance FROM sim_balances WHERE device_id=$1 AND sim_slot=$2 AND provider_key IS NOT DISTINCT FROM $3`,
    [params.deviceId, params.simSlot, params.providerKey ?? null]
  );

  let simBalanceId: string;
  let previousBalance: number | null = null;

  if (existing) {
    simBalanceId = existing.id;
    previousBalance = existing.balance == null ? null : Number(existing.balance);
    // provider_key, like company_id, is COALESCEd rather than overwritten
    // with NULL — a manual balance/threshold/phone-only edit (no
    // providerKey passed) must never blank out a SIM's already-known
    // 6-way identity.
    await query(
      `UPDATE sim_balances
       SET balance=$1,
           company_id=COALESCE($2, company_id),
           provider_key=COALESCE($3, provider_key),
           phone_number=COALESCE($4, phone_number),
           last_source=$5,
           last_sms_log_id=$6,
           updated_at=now()
       WHERE id=$7`,
      [
        params.newBalance,
        params.companyId ?? null,
        params.providerKey ?? null,
        params.phoneNumber ?? null,
        params.source,
        params.smsLogId ?? null,
        simBalanceId,
      ]
    );
  } else {
    simBalanceId = randomUUID();
    await query(
      `INSERT INTO sim_balances (id, device_id, sim_slot, company_id, provider_key, phone_number, balance, last_source, last_sms_log_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        simBalanceId,
        params.deviceId,
        params.simSlot,
        params.companyId ?? null,
        params.providerKey ?? null,
        params.phoneNumber ?? null,
        params.newBalance,
        params.source,
        params.smsLogId ?? null,
      ]
    );
  }

  // 3 decimals to match sim_balances.balance's own precision (real carrier
  // balance SMS report a third decimal, e.g. EVC Plus's "$2.965") — a
  // 2-decimal round here would silently throw away the same precision the
  // column itself was widened to keep.
  const changeAmount = previousBalance == null ? null : Number((params.newBalance - previousBalance).toFixed(3));

  await query(
    `INSERT INTO sim_balance_history
       (id, sim_balance_id, previous_balance, new_balance, change_amount, order_id, sms_log_id, source, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      simBalanceId,
      previousBalance,
      params.newBalance,
      changeAmount,
      params.orderId ?? null,
      params.smsLogId ?? null,
      params.source,
      params.changedBy ?? null,
    ]
  );

  broadcast({ type: "sim_balance.updated", deviceId: params.deviceId, simSlot: params.simSlot });
}

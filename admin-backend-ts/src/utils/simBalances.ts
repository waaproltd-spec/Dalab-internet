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
const BALANCE_VALUE_PATTERNS: RegExp[] = [
  // eDahab/Somtel: "Haraagaaga Cusubi Waa: 31.34 Dollar" — its "Cusubi"/
  // "Dollar" wording never collides with the generic pattern below.
  /Haraagaaga\s+Cusubi\s+Waa\s*:?\s*([\d,]+(?:\.\d+)?)\s*Dollar/i,
  // Hormuud (EVC Plus + E-Voucher) and Somnet/Jeeb all phrase their own
  // remaining balance as some spelling of "Haraag(a)agu waa", with or
  // without a "$" sign, with a colon or plain space before the number.
  /Haraag(?:a?a)gu\s+waa\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  // Amtel: "Now your balance is $+1.15." — the literal "+" before the
  // digits is part of Amtel's own SMS format (also on its "Amount is
  // $+1.00" line), not a typo to strip.
  /balance\s+is\s*\$?\+?\s*([\d,]+(?:\.\d+)?)/i,
];

export function extractBalanceFromSms(body: string): { balance: number } | null {
  for (const pattern of BALANCE_VALUE_PATTERNS) {
    const match = pattern.exec(body);
    if (match) {
      const balance = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(balance)) return { balance };
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

export async function applyBalanceUpdate(params: {
  deviceId: string;
  simSlot: number;
  newBalance: number;
  companyId?: string | null;
  phoneNumber?: string | null;
  orderId?: string | null;
  smsLogId?: string | null;
  source: "sms" | "manual";
  changedBy?: string | null;
}): Promise<void> {
  const existing = await queryOne<{ id: string; balance: string | null }>(
    `SELECT id, balance FROM sim_balances WHERE device_id=$1 AND sim_slot=$2`,
    [params.deviceId, params.simSlot]
  );

  let simBalanceId: string;
  let previousBalance: number | null = null;

  if (existing) {
    simBalanceId = existing.id;
    previousBalance = existing.balance == null ? null : Number(existing.balance);
    await query(
      `UPDATE sim_balances
       SET balance=$1,
           company_id=COALESCE($2, company_id),
           phone_number=COALESCE($3, phone_number),
           last_source=$4,
           last_sms_log_id=$5,
           updated_at=now()
       WHERE id=$6`,
      [params.newBalance, params.companyId ?? null, params.phoneNumber ?? null, params.source, params.smsLogId ?? null, simBalanceId]
    );
  } else {
    simBalanceId = randomUUID();
    await query(
      `INSERT INTO sim_balances (id, device_id, sim_slot, company_id, phone_number, balance, last_source, last_sms_log_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [simBalanceId, params.deviceId, params.simSlot, params.companyId ?? null, params.phoneNumber ?? null, params.newBalance, params.source, params.smsLogId ?? null]
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

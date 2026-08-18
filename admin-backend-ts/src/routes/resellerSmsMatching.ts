import { query, queryOne, withTransaction } from "../db/pool.js";
import { adjustResellerWallet } from "../utils/resellerWallet.js";
import { recordActivity } from "../utils/activityLog.js";

/**
 * Reseller Deposit's automatic SMS matcher — same shape and same safety
 * properties as findMatchingOrder/findMatchingExchangeOrder in
 * smsLogs.routes.ts (candidate row lock, phone match, device/SIM
 * verification with auto-link-on-first-match), just against
 * reseller_deposits instead of orders/exchange_orders. Deliberately its own
 * module rather than added inline to smsLogs.routes.ts, so the Reseller
 * feature's SMS-matching code stays clearly separated from the Internet
 * Store/eBadal matchers it must never interfere with — see ingestPaymentSms,
 * which only ever calls this once BOTH of those have already found nothing
 * for a given SMS. "Deposit is only for receiving money" (product
 * instruction) — no rate or bonus is computed here, the wallet is credited
 * for exactly the confirmed amount.
 */

const MATCH_WINDOW_HOURS = 24;

function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

type ResellerDepositCandidate = {
  id: string;
  from_number: string;
  amount: number;
  method: string;
};

export type ResellerDepositMatchResult = { deposit: ResellerDepositCandidate | null; reason: string | null };

export async function findMatchingResellerDeposit(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined,
  uploadingAgentId: string,
  uploadingSimSlot: number | null | undefined
): Promise<ResellerDepositMatchResult> {
  if (parsedAmount == null || !parsedPhone) {
    return { deposit: null, reason: "SMS did not parse a usable amount and/or sender phone number" };
  }
  const target = normalizePhone(parsedPhone);
  if (!target) return { deposit: null, reason: "Parsed phone number had no digits after normalization" };

  const candidates = await withTransaction((client) =>
    client
      .query<ResellerDepositCandidate>(
        `SELECT id, from_number, amount, method FROM reseller_deposits
         WHERE status='pending' AND ABS(amount - $1) < 0.01 AND updated_at > now() - interval '${MATCH_WINDOW_HOURS} hours'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED`,
        [parsedAmount]
      )
      .then((r) => r.rows)
  );
  if (candidates.length === 0) {
    return { deposit: null, reason: `No pending reseller deposit for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h` };
  }
  const phoneMatches = candidates.filter((d) => normalizePhone(d.from_number) === target);
  if (phoneMatches.length === 0) {
    return {
      deposit: null,
      reason: `${candidates.length} pending reseller deposit(s) for $${parsedAmount} in the last ${MATCH_WINDOW_HOURS}h, but none for phone ...${target}`,
    };
  }

  const uploadingAgent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [uploadingAgentId]);
  const uploadingDeviceId = uploadingAgent?.device_id ?? null;

  const skipped: string[] = [];
  for (const candidate of phoneMatches) {
    const method = await queryOne<{ device_id: string | null; sim_slot: number | null }>(
      `SELECT device_id, sim_slot FROM reseller_deposit_methods WHERE method=$1`,
      [candidate.method]
    );
    if (!method) {
      skipped.push(`deposit ${candidate.id}: its payment method (${candidate.method}) no longer exists`);
      continue;
    }
    if (!method.device_id) {
      // Not yet linked to a device — accept, same fallback findMatchingOrder
      // uses, and auto-link this method to the device/slot this SMS arrived
      // on since a real amount+phone-matched deposit just proved that's
      // where it's collected.
      if (uploadingDeviceId) {
        await query(
          `UPDATE reseller_deposit_methods SET device_id=$1, sim_slot=COALESCE(sim_slot, $2) WHERE method=$3`,
          [uploadingDeviceId, uploadingSimSlot ?? null, candidate.method]
        );
      }
      return { deposit: candidate, reason: null };
    }
    if (method.device_id !== uploadingDeviceId) {
      skipped.push(`deposit ${candidate.id}: expects device ${method.device_id}, this SMS arrived on device ${uploadingDeviceId ?? "(agent has no device_id set)"}`);
      continue;
    }
    if (method.sim_slot != null && method.sim_slot !== uploadingSimSlot) {
      skipped.push(`deposit ${candidate.id}: expects SIM slot ${method.sim_slot}, this SMS arrived on slot ${uploadingSimSlot ?? "(unresolved)"}`);
      continue;
    }
    return { deposit: candidate, reason: null };
  }
  return { deposit: null, reason: `Matched by amount+phone but rejected by device/SIM verification — ${skipped.join("; ")}` };
}

/**
 * Flips the deposit to 'verified' and credits the wallet, exactly mirroring
 * PUT /admin/reseller-deposits/:id/verify's own logic (resellerDepositsWithdrawals.routes.ts)
 * but with source:'sms' and no admin attached — this IS the "SMS Agent
 * confirms the payment" step, automated.
 *
 * The CAS claim runs FIRST, before any wallet credit — not after. Two
 * concurrent callers (a live SMS upload racing the 15s resweep, or two
 * resweep passes) can both reach this function for the same deposit; only
 * the one whose UPDATE...WHERE status='pending' actually flips a row is
 * allowed to credit the wallet, so a race can never double-credit. (An
 * earlier draft credited first and claimed second — that ordering allowed
 * exactly that double-credit and was caught before shipping.)
 */
export async function confirmResellerDepositViaSms(
  deposit: ResellerDepositCandidate,
  smsLogId: string
): Promise<{ credited: boolean; newBalance?: number }> {
  const claimed = await query<{ id: string; reseller_id: string }>(
    `UPDATE reseller_deposits SET status='verified', verified_at=now(), matched_sms_log_id=$1, updated_at=now()
     WHERE id=$2 AND status='pending' RETURNING id, reseller_id`,
    [smsLogId, deposit.id]
  );
  if (claimed.length === 0) {
    // Lost the race, or already resolved by an admin/other path — no credit.
    return { credited: false };
  }

  const walletResult = await adjustResellerWallet({
    resellerId: claimed[0].reseller_id,
    changeAmount: Number(deposit.amount),
    referenceType: "deposit",
    referenceId: deposit.id,
    source: "sms",
  });

  await query(`UPDATE sms_logs SET matched_reseller_deposit_id=$1 WHERE id=$2`, [deposit.id, smsLogId]);
  await recordActivity({
    adminId: undefined,
    action: "reseller_deposit_verified_via_sms",
    entityType: "reseller_deposit",
    entityId: deposit.id,
    oldValue: null,
    newValue: { smsLogId, amount: deposit.amount, newBalance: walletResult.newBalance },
  });
  return { credited: true, newBalance: walletResult.newBalance };
}

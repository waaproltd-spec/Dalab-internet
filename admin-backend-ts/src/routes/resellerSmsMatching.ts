import { query, queryOne, withTransaction } from "../db/pool.js";
import { adjustResellerWallet } from "../utils/resellerWallet.js";
import { recordActivity } from "../utils/activityLog.js";

/**
 * Reseller Deposit and Withdraw's automatic SMS matchers. Same shape and
 * same safety properties as findMatchingOrder/findMatchingExchangeOrder in
 * smsLogs.routes.ts (candidate row lock, phone+amount match, atomic
 * claim-before-money-moves), just against reseller_deposits/
 * reseller_withdrawals instead of orders/exchange_orders. Deliberately its
 * own module rather than added inline to smsLogs.routes.ts, so the
 * Reseller feature's SMS-matching code stays clearly separated from the
 * Internet Store/eBadal matchers it must never interfere with — see
 * ingestPaymentSms, which only ever calls either of these once Store,
 * Exchange, AND (for Withdraw) Reseller Deposit have already found nothing
 * for a given SMS. "Deposit is only for receiving money" (product
 * instruction) — no commission or bonus is computed on the Deposit side,
 * the wallet is credited for exactly the confirmed amount.
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

/**
 * Reseller Withdraw's automatic SMS matcher — confirms the OUTGOING payout
 * SMS the reseller's own phone receives after dialing "Dial to Pay" (send-
 * money), the opposite direction from findMatchingResellerDeposit above.
 * Matches on customer_receives_amount (what the SMS will actually show as
 * sent — commission included, not the raw wallet amount) + destination_number
 * + the payout company (product instruction: "Hormuud SMS -> Hormuud
 * Withdraw only. Amtel SMS -> Amtel Withdraw only." — never cross-matched,
 * even if amount+phone happened to coincide with a different company's
 * withdrawal). parsedProvider is the mobile parser's own self-reported
 * operator (see hormuudOutgoingParser/amtelOutgoingParser in the agent-app's
 * smsParsers.ts) — compared case-insensitively against companies.name.
 *
 * Open question, deliberately not resolved here: WHO uploads this SMS.
 * Every other matcher in this codebase (Internet Store, eBadal, Reseller
 * Deposit) confirms a payment that lands on a Dalab-controlled collection
 * device already running the native Agent App's SMS listener. A Reseller
 * Withdraw's payout SMS instead lands on the RESELLER'S OWN phone, running
 * the separate Reseller Flutter app — which has no SMS-listening capability
 * today and isn't a registered agent_devices entry. This function will only
 * ever see traffic once something (a future addition to the Reseller app,
 * or routing payouts through a Dalab-controlled device instead of the
 * reseller's own) actually delivers that SMS to POST /agent/sms-logs. No
 * device/SIM verification is applied here as a result — see this file's
 * device_id/sim_slot handling in findMatchingResellerDeposit for contrast.
 */

const WITHDRAWAL_MATCH_WINDOW_HOURS = 24;

type ResellerWithdrawalCandidate = {
  id: string;
  destination_number: string;
  amount: number;
  customer_receives_amount: number;
  company_name: string;
};

export type ResellerWithdrawalMatchResult = { withdrawal: ResellerWithdrawalCandidate | null; reason: string | null };

export async function findMatchingResellerWithdrawal(
  parsedAmount: number | undefined,
  parsedPhone: string | undefined,
  parsedProvider: string | undefined | null
): Promise<ResellerWithdrawalMatchResult> {
  if (parsedAmount == null || !parsedPhone) {
    return { withdrawal: null, reason: "SMS did not parse a usable amount and/or recipient phone number" };
  }
  const target = normalizePhone(parsedPhone);
  if (!target) return { withdrawal: null, reason: "Parsed phone number had no digits after normalization" };
  if (!parsedProvider) return { withdrawal: null, reason: "SMS did not identify a payout company" };

  const candidates = await withTransaction((client) =>
    client
      .query<ResellerWithdrawalCandidate>(
        `SELECT w.id, w.destination_number, w.amount, w.customer_receives_amount, c.name AS company_name
         FROM reseller_withdrawals w
         JOIN companies c ON c.id = w.company_id
         WHERE w.status IN ('reserved','sent') AND ABS(w.customer_receives_amount - $1) < 0.01
           AND w.updated_at > now() - interval '${WITHDRAWAL_MATCH_WINDOW_HOURS} hours'
         ORDER BY w.created_at ASC
         FOR UPDATE SKIP LOCKED`,
        [parsedAmount]
      )
      .then((r) => r.rows)
  );
  if (candidates.length === 0) {
    return { withdrawal: null, reason: `No in-flight reseller withdrawal sending $${parsedAmount} in the last ${WITHDRAWAL_MATCH_WINDOW_HOURS}h` };
  }
  const companyMatches = candidates.filter((w) => w.company_name.toLowerCase() === parsedProvider.toLowerCase());
  if (companyMatches.length === 0) {
    return {
      withdrawal: null,
      reason: `${candidates.length} in-flight reseller withdrawal(s) sending $${parsedAmount} in the last ${WITHDRAWAL_MATCH_WINDOW_HOURS}h, but none for company '${parsedProvider}'`,
    };
  }
  const phoneMatch = companyMatches.find((w) => normalizePhone(w.destination_number) === target);
  if (!phoneMatch) {
    return {
      withdrawal: null,
      reason: `${companyMatches.length} in-flight '${parsedProvider}' reseller withdrawal(s) sending $${parsedAmount} in the last ${WITHDRAWAL_MATCH_WINDOW_HOURS}h, but none to phone ...${target}`,
    };
  }
  return { withdrawal: phoneMatch, reason: null };
}

/**
 * Flips the withdrawal to 'completed' and deducts the wallet — this IS "the
 * Wallet amount is deducted only after the outgoing payment is successfully
 * confirmed" (product instruction), automated. Same claim-before-deduct
 * ordering as confirmResellerDepositViaSms and the manual /complete
 * endpoint: the CAS runs first, and only a successful claim is allowed to
 * touch the wallet, so this function, the manual endpoint, and a
 * concurrent resweep pass can never double-deduct the same withdrawal.
 *
 * The claim and the wallet debit run in one transaction — required now
 * that withdrawal creation no longer reserves any wallet capacity (see
 * POST /reseller/withdrawals' doc comment): a reseller can have several
 * withdrawals open that collectively exceed the wallet, so
 * adjustResellerWallet's negative-balance floor can genuinely fire here in
 * normal operation now, not just as a defensive check that can never
 * trigger. If it does, the whole transaction rolls back — the claim itself
 * is undone, so the withdrawal lands back at its prior status ('reserved'/
 * 'sent') instead of getting stuck 'completed' with no matching deduction —
 * and this is reported as `completed: false` with a needsReconciliation
 * flag rather than thrown, so a real payout the Agent already sent
 * successfully surfaces for a Super Admin to resolve by hand instead of
 * crashing SMS ingestion.
 */
export async function confirmResellerWithdrawalViaSms(
  withdrawal: ResellerWithdrawalCandidate,
  smsLogId: string
): Promise<{ completed: boolean; newBalance?: number; needsReconciliation?: boolean }> {
  try {
    return await withTransaction(async (client) => {
      const claimed = await client.query<{ id: string; reseller_id: string }>(
        `UPDATE reseller_withdrawals SET status='completed', completed_at=now(), matched_sms_log_id=$1, updated_at=now()
         WHERE id=$2 AND status IN ('reserved','sent') RETURNING id, reseller_id`,
        [smsLogId, withdrawal.id]
      );
      if (claimed.rows.length === 0) {
        // Lost the race, or already resolved (admin Complete, or cancelled/failed) — no deduction.
        return { completed: false };
      }

      const walletResult = await adjustResellerWallet({
        resellerId: claimed.rows[0].reseller_id,
        changeAmount: -Number(withdrawal.amount),
        referenceType: "withdrawal",
        referenceId: withdrawal.id,
        source: "sms",
        client,
      });

      await client.query(`UPDATE sms_logs SET matched_reseller_withdrawal_id=$1 WHERE id=$2`, [withdrawal.id, smsLogId]);
      return { completed: true, newBalance: walletResult.newBalance };
    }).then(async (result) => {
      if (result.completed) {
        await recordActivity({
          adminId: undefined,
          action: "reseller_withdrawal_completed_via_sms",
          entityType: "reseller_withdrawal",
          entityId: withdrawal.id,
          oldValue: null,
          newValue: { smsLogId, amount: withdrawal.amount, customerReceivesAmount: withdrawal.customer_receives_amount, newBalance: result.newBalance },
        });
      }
      return result;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Insufficient wallet balance") {
      // The Agent's payout SMS confirmed real money went out, but this
      // reseller's wallet can't cover it — almost certainly because another
      // of their withdrawals was paid out and completed first. Never silent:
      // logged for a Super Admin to reconcile manually (e.g. Admin ->
      // Resellers -> Withdrawals -> Complete, once the wallet is topped up
      // or the conflicting withdrawal is resolved).
      await recordActivity({
        adminId: undefined,
        action: "reseller_withdrawal_completion_wallet_insufficient",
        entityType: "reseller_withdrawal",
        entityId: withdrawal.id,
        oldValue: null,
        newValue: { smsLogId, amount: withdrawal.amount, reason: "SMS matched but wallet balance could not cover the debit — needs manual reconciliation" },
      });
      return { completed: false, needsReconciliation: true };
    }
    throw err;
  }
}

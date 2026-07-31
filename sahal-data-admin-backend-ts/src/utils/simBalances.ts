import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { broadcast } from "../realtime/orderEvents.js";

/**
 * Balance-mention patterns lifted directly from the exact real SMS samples
 * already confirmed and documented in agent-app's PaymentSmsParsers.kt (not
 * guessed): Somtel eDahab's "Haraagaaga Cusubi Waa: 2.61 Dollar", Somnet's
 * "Haraagaagu waa $4.95.", and Hormuud's own "Your balance is $0.27." phrase
 * (confirmed on its E-Voucher/outgoing-transfer SMS, and reused here since
 * it's the same telecom's standard balance phrasing). Amtel has no parser —
 * per the existing PaymentSmsParsers.kt design note, Amtel doesn't send
 * payment SMS at all, so its balance can only ever be set manually.
 * Best-effort by construction: a body that doesn't match any of these simply
 * yields no automatic update, never a wrong one.
 */
const BALANCE_PATTERNS: { provider: "Hormuud" | "Somtel" | "Somnet"; pattern: RegExp }[] = [
  { provider: "Somtel", pattern: /Haraagaaga\s+Cusubi\s+Waa\s*:?\s*([\d,]+(?:\.\d+)?)\s*Dollar/i },
  { provider: "Somnet", pattern: /Haraagaagu\s+waa\s*\$?\s*([\d,]+(?:\.\d+)?)/i },
  { provider: "Hormuud", pattern: /balance\s+is\s*\$?\s*([\d,]+(?:\.\d+)?)/i },
];

export function extractBalanceFromSms(body: string): { provider: string; balance: number } | null {
  for (const { provider, pattern } of BALANCE_PATTERNS) {
    const match = pattern.exec(body);
    if (match) {
      const balance = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(balance)) return { provider, balance };
    }
  }
  return null;
}

/** The highest-priority (primary) device+slot currently routed to handle
 * this company's payments — same resolution order the Agent App's own
 * SimRoutingRepository/dial pipeline already uses, so the balance is
 * attributed to whichever physical SIM is actually expected to be
 * collecting this provider's payments. */
export async function resolveDeviceSlotForCompany(companyId: string): Promise<{ deviceId: string; simSlot: number } | null> {
  const row = await queryOne<{ device_id: string; sim_slot: number }>(
    `SELECT device_id, sim_slot FROM sim_routing WHERE company_id=$1 ORDER BY priority ASC LIMIT 1`,
    [companyId]
  );
  return row ? { deviceId: row.device_id, simSlot: row.sim_slot } : null;
}

/** Case-insensitive match against a provider's display name — used when a
 * payment SMS didn't resolve to a specific matched order (so there's no
 * order.company_id to trust directly), only a parsed provider label. */
export async function resolveCompanyIdByProviderName(providerName: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM companies WHERE lower(name)=lower($1)`, [providerName]);
  return row?.id ?? null;
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
  const existing = await queryOne<{ id: string; balance: string }>(
    `SELECT id, balance FROM sim_balances WHERE device_id=$1 AND sim_slot=$2`,
    [params.deviceId, params.simSlot]
  );

  let simBalanceId: string;
  let previousBalance: number | null = null;

  if (existing) {
    simBalanceId = existing.id;
    previousBalance = Number(existing.balance);
    await query(
      `UPDATE sim_balances
       SET balance=$1,
           company_id=COALESCE($2, company_id),
           phone_number=COALESCE($3, phone_number),
           updated_at=now()
       WHERE id=$4`,
      [params.newBalance, params.companyId ?? null, params.phoneNumber ?? null, simBalanceId]
    );
  } else {
    simBalanceId = randomUUID();
    await query(
      `INSERT INTO sim_balances (id, device_id, sim_slot, company_id, phone_number, balance)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [simBalanceId, params.deviceId, params.simSlot, params.companyId ?? null, params.phoneNumber ?? null, params.newBalance]
    );
  }

  const changeAmount = previousBalance == null ? null : Number((params.newBalance - previousBalance).toFixed(2));

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

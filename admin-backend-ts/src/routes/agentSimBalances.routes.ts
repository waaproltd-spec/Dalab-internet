import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * AGENT APP "SIM balances": every SIM the admin has configured in this
 * system, each one separately -- network, phone number, which phone and
 * SIM slot -- with its last confirmed balance, or the real reason there
 * isn't one. Never a made-up $0.
 *
 * "Configured" = a SIM balance row (created by the admin on the Balance
 * Dashboard, or by a balance message the Sender-ID gate accepted for that
 * exact phone/slot/network) or a SIM Routing entry for a network on that
 * phone/slot. Nothing else is listed. Balances come from the carriers' own
 * messages on that SIM (balance SMS, USSD replies) or an admin's manual
 * entry -- the same data the Balance Dashboard shows. Read-only.
 */
export const agentSimBalancesRouter = Router();

/** Network and label for each balance identity. */
export const SIM_PROVIDERS: Record<string, { label: string; network: string; order: number }> = {
  evc_plus: { label: "EVC Plus", network: "Hormuud", order: 1 },
  hormuud: { label: "Hormuud data", network: "Hormuud", order: 2 },
  hormuud_evoucher: { label: "Hormuud E-Voucher", network: "Hormuud", order: 3 },
  edahab: { label: "eDahab", network: "Somnet", order: 4 },
  somnet: { label: "Somnet data", network: "Somnet", order: 5 },
  somtel: { label: "Somtel", network: "Somtel", order: 6 },
  amtel: { label: "Amtel", network: "Amtel", order: 7 },
};

export const STALE_HOURS = 24;
export const DEVICE_OFFLINE_MINUTES = 10;

export type SimStatus = "ok" | "no_balance_yet" | "sim_missing" | "device_offline" | "stale";

/** The SIM's state and the message the agent sees. Pure; unit-tested. */
export function simBalanceStatus(
  row: { balance: unknown; updated_at: Date | string | null; sim_present: boolean | null; last_heartbeat_at: Date | string | null; sim_slot: number; device_name: string },
  now: Date = new Date()
): { status: SimStatus; message: string | null } {
  if (row.sim_present === false) {
    return { status: "sim_missing", message: `SIM ${row.sim_slot} is not detected in ${row.device_name} — check the SIM card.` };
  }
  if (row.balance === null || row.balance === undefined) {
    return { status: "no_balance_yet", message: "No balance received yet for this SIM — it appears after its next balance message or USSD reply." };
  }
  const beat = row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null;
  if (!beat || now.getTime() - beat.getTime() > DEVICE_OFFLINE_MINUTES * 60_000) {
    const ago = beat ? ` since ${Math.round((now.getTime() - beat.getTime()) / 60_000)} min` : "";
    return { status: "device_offline", message: `${row.device_name} is offline${ago} — this balance may be out of date.` };
  }
  const at = row.updated_at ? new Date(row.updated_at) : null;
  if (at && now.getTime() - at.getTime() > STALE_HOURS * 3_600_000) {
    return { status: "stale", message: `Last update ${Math.floor((now.getTime() - at.getTime()) / 3_600_000)} h ago — no newer balance message since.` };
  }
  return { status: "ok", message: null };
}

const CONFIGURED_SIMS_SQL = `
  WITH configured AS (
    SELECT sb.device_id, sb.sim_slot, COALESCE(sb.provider_key, sb.company_id) AS provider_key, sb.id::text AS balance_id,
           sb.balance, sb.updated_at, sb.last_source, COALESCE(sb.phone_number, c.payment_number) AS phone_number, c.name AS company_name
      FROM sim_balances sb LEFT JOIN companies c ON c.id = sb.company_id
     WHERE COALESCE(sb.provider_key, sb.company_id) IS NOT NULL
    UNION ALL
    SELECT sr.device_id, sr.sim_slot, sr.company_id, NULL, NULL, NULL, NULL, c.payment_number, c.name
      FROM sim_routing sr JOIN companies c ON c.id = sr.company_id
     WHERE sr.device_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sim_balances sb WHERE sb.device_id = sr.device_id AND sb.sim_slot = sr.sim_slot
                         AND COALESCE(sb.provider_key, sb.company_id) = sr.company_id)
  )
  SELECT cf.*, d.name AS device_name, d.last_heartbeat_at,
         CASE cf.sim_slot WHEN 1 THEN d.sim1_present ELSE d.sim2_present END AS sim_present
    FROM configured cf JOIN agent_devices d ON d.id = cf.device_id
   ORDER BY d.name, cf.sim_slot`;

type Row = {
  device_id: string; sim_slot: number; provider_key: string; balance_id: string | null; balance: string | null;
  updated_at: Date | null; last_source: string | null; phone_number: string | null; company_name: string | null;
  device_name: string; last_heartbeat_at: Date | null; sim_present: boolean | null;
};

agentSimBalancesRouter.get("/agent/sim-balances", requireAuth("agent"), async (_req, res) => {
  const rows = await query<Row>(CONFIGURED_SIMS_SQL);
  const now = new Date();
  const sims = rows
    .map((r) => {
      const p = SIM_PROVIDERS[r.provider_key] ?? { label: r.company_name ?? r.provider_key, network: r.company_name ?? r.provider_key, order: 99 };
      const { status, message } = simBalanceStatus(r, now);
      return {
        id: r.balance_id ?? `${r.device_id}:${r.sim_slot}:${r.provider_key}`,
        provider_key: r.provider_key,
        label: p.label,
        network: p.network,
        phone_number: r.phone_number,
        device_id: r.device_id,
        device_name: r.device_name,
        sim_slot: r.sim_slot,
        balance: r.balance === null ? null : Number(r.balance),
        updated_at: r.updated_at,
        source: r.last_source,
        status,
        message,
        _order: p.order,
      };
    })
    .sort((a, b) => a._order - b._order || a.device_name.localeCompare(b.device_name) || a.sim_slot - b.sim_slot)
    .map(({ _order, ...s }) => s);
  sendJson(res, 200, { sims, stale_hours: STALE_HOURS, generated_at: now.toISOString() });
});

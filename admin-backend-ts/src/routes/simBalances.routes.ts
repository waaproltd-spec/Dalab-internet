import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { applyBalanceUpdate } from "../utils/simBalances.js";

export const simBalancesRouter = Router();

// Agent App's own "Wallet Balances" dashboard — the same SIM-balance data
// the Super Admin's Balance Dashboard shows (see SIM_BALANCE_LIST_SQL
// below), scoped to just the calling agent's own device. An agent with no
// device assigned yet (device_id null) has nothing to show — empty list,
// not an error.
simBalancesRouter.get("/agent/wallet-balances", requireAuth("agent"), async (req, res) => {
  const agent = await queryOne<{ device_id: string | null }>(`SELECT device_id FROM agents WHERE id=$1`, [req.auth!.sub]);
  if (!agent?.device_id) return sendJson(res, 200, []);
  const rows = await query(
    `SELECT
       slot.n AS sim_slot,
       COALESCE(sb.company_id, sr.company_id) AS company_id,
       COALESCE(c2.name, c.name) AS provider_name,
       COALESCE(c2.color_hex, c.color_hex) AS color_hex,
       COALESCE(sb.phone_number, c.payment_number) AS phone_number,
       COALESCE(sb.balance, 0) AS balance,
       COALESCE(sb.low_balance_threshold, 5) AS low_balance_threshold,
       sb.updated_at AS balance_updated_at
     FROM (VALUES (1),(2)) AS slot(n)
     LEFT JOIN sim_balances sb ON sb.device_id = $1 AND sb.sim_slot = slot.n
     LEFT JOIN sim_routing sr ON sr.device_id = $1 AND sr.sim_slot = slot.n
     LEFT JOIN companies c ON c.id = sr.company_id
     LEFT JOIN companies c2 ON c2.id = sb.company_id
     ORDER BY slot.n`,
    [agent.device_id]
  );
  sendJson(res, 200, rows);
});

// Every physical SIM slot (1 and 2) on every registered device, whenever
// that slot isn't confirmed absent (sim1Present/sim2Present is TRUE or
// unknown/NULL — only an explicit FALSE hides the row) — this is the
// complete "every payment phone/SIM" inventory the dashboard needs, not
// just the ones that happen to already have a balance row. Provider/phone
// number resolve from sim_routing/companies as a fallback when this SIM's
// own sim_balances row hasn't been manually given an override.
//
// balance is passed through NULL, not COALESCEd to 0 — a SIM slot with no
// row at all, or a row that's only ever had metadata (company/phone/
// threshold) assigned without a real SMS-or-manual balance update, has
// never had a confirmed balance and must render as "Unknown"/"No recent
// balance", never a fake $0.00 (migration 068). last_source lets the
// dashboard show whether that confirmed value came from an SMS or a manual
// override.
const SIM_BALANCE_LIST_SQL = `
  SELECT
    d.id AS device_id, d.name AS device_name,
    (d.enabled AND d.network_online AND d.last_heartbeat_at > now() - interval '5 minutes') AS online,
    d.last_heartbeat_at,
    slot.n AS sim_slot,
    COALESCE(sb.company_id, sr.company_id) AS company_id,
    COALESCE(c2.name, c.name) AS provider_name,
    COALESCE(sb.phone_number, c.payment_number) AS phone_number,
    sb.id AS balance_id,
    sb.balance AS balance,
    sb.last_source AS last_source,
    COALESCE(sb.low_balance_threshold, 5) AS low_balance_threshold,
    sb.updated_at AS balance_updated_at
  FROM agent_devices d
  CROSS JOIN (VALUES (1),(2)) AS slot(n)
  LEFT JOIN sim_balances sb ON sb.device_id = d.id AND sb.sim_slot = slot.n
  LEFT JOIN sim_routing sr ON sr.device_id = d.id AND sr.sim_slot = slot.n
  LEFT JOIN companies c ON c.id = sr.company_id
  LEFT JOIN companies c2 ON c2.id = sb.company_id
  WHERE (slot.n = 1 AND d.sim1_present IS NOT FALSE) OR (slot.n = 2 AND d.sim2_present IS NOT FALSE)
  ORDER BY d.name, slot.n
`;

simBalancesRouter.get("/admin/sim-balances", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(SIM_BALANCE_LIST_SQL));
});

// Overall + per-provider + per-device totals, plus today's spend/receive —
// "spent" is any negative change (balance went down, i.e. USSD/data
// delivered), "received" is any positive change (a top-up/reload landed).
simBalancesRouter.get("/admin/sim-balances/summary", requireStaff(), async (_req, res) => {
  const totalRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(balance), 0) AS total FROM sim_balances`
  );
  // known_sim_count (COUNT ignores NULLs) lets the dashboard tell "$0 total
  // because every SIM confirmed a real $0 balance" apart from "$0 total
  // because none of this provider's SIMs have a confirmed balance yet" —
  // sim_count (COUNT(*)) still counts every row regardless of balance.
  const byProvider = await query(
    `SELECT sb.company_id, c.name AS provider_name, COALESCE(SUM(sb.balance), 0) AS total,
            COUNT(*) AS sim_count, COUNT(sb.balance) AS known_sim_count
     FROM sim_balances sb
     LEFT JOIN companies c ON c.id = sb.company_id
     GROUP BY sb.company_id, c.name
     ORDER BY total DESC`
  );
  const byDevice = await query(
    `SELECT sb.device_id, d.name AS device_name, COALESCE(SUM(sb.balance), 0) AS total, COUNT(*) AS sim_count
     FROM sim_balances sb
     LEFT JOIN agent_devices d ON d.id = sb.device_id
     GROUP BY sb.device_id, d.name
     ORDER BY total DESC`
  );
  const todayRow = await queryOne<{ received: string; spent: string }>(
    `SELECT
       COALESCE(SUM(change_amount) FILTER (WHERE change_amount > 0 AND created_at >= date_trunc('day', now())), 0) AS received,
       COALESCE(SUM(-change_amount) FILTER (WHERE change_amount < 0 AND created_at >= date_trunc('day', now())), 0) AS spent
     FROM sim_balance_history`
  );
  const dailyChanges = await query(
    `SELECT date_trunc('day', created_at) AS day, COALESCE(SUM(change_amount), 0) AS net_change
     FROM sim_balance_history
     WHERE created_at >= now() - interval '14 days'
     GROUP BY day ORDER BY day DESC`
  );
  sendJson(res, 200, {
    totalBalance: Number(totalRow?.total ?? 0),
    totalReceivedToday: Number(todayRow?.received ?? 0),
    totalSpentToday: Number(todayRow?.spent ?? 0),
    byProvider,
    byDevice,
    dailyChanges,
  });
});

simBalancesRouter.get("/admin/sim-balances/low-balance-count", requireStaff(), async (_req, res) => {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM sim_balances WHERE balance < low_balance_threshold`
  );
  sendJson(res, 200, { count: Number(row?.count ?? 0) });
});

simBalancesRouter.get("/admin/sim-balances/:deviceId/:simSlot/history", requireStaff(), async (req, res) => {
  const simSlot = Number(req.params.simSlot);
  const balance = await queryOne<{ id: string }>(
    `SELECT id FROM sim_balances WHERE device_id=$1 AND sim_slot=$2`,
    [req.params.deviceId, simSlot]
  );
  if (!balance) return sendJson(res, 200, []);
  sendJson(
    res,
    200,
    await query(
      `SELECT h.*, o.package_id, o.customer_id
       FROM sim_balance_history h
       LEFT JOIN orders o ON o.id = h.order_id
       WHERE h.sim_balance_id=$1
       ORDER BY h.created_at DESC
       LIMIT 200`,
      [balance.id]
    )
  );
});

// Manual balance/threshold/provider/phone-number override — covers Amtel
// (no payment SMS exists to auto-detect from) and any correction an admin
// needs to make regardless of provider.
simBalancesRouter.put("/admin/sim-balances/:deviceId/:simSlot", requirePermission("devices.manage"), async (req, res) => {
  const simSlot = Number(req.params.simSlot);
  if (![1, 2].includes(simSlot)) return sendJson(res, 400, { error: "simSlot must be 1 or 2" });

  const device = await queryOne(`SELECT id FROM agent_devices WHERE id=$1`, [req.params.deviceId]);
  if (!device) return sendJson(res, 404, { error: "Device not found" });

  let { companyId } = req.body ?? {};
  const { balance, threshold, phoneNumber } = req.body ?? {};

  if (companyId) {
    const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [companyId]);
    if (!company) return sendJson(res, 400, { error: "Company not found" });
  } else {
    // Not explicitly sent — default to whatever sim_routing already says
    // this device+slot serves, so a plain "just fix the balance" edit on a
    // brand-new row (no sim_balances row yet) never silently leaves the
    // provider unassigned.
    const routed = await queryOne<{ company_id: string }>(
      `SELECT company_id FROM sim_routing WHERE device_id=$1 AND sim_slot=$2`,
      [req.params.deviceId, simSlot]
    );
    companyId = routed?.company_id ?? null;
  }

  if (balance !== undefined) {
    const num = Number(balance);
    if (!Number.isFinite(num)) return sendJson(res, 400, { error: "balance must be a number" });
    await applyBalanceUpdate({
      deviceId: req.params.deviceId,
      simSlot,
      newBalance: num,
      companyId: companyId ?? null,
      phoneNumber: phoneNumber ?? null,
      source: "manual",
      changedBy: req.auth!.sub,
    });
  } else if (companyId || phoneNumber) {
    // Metadata-only change (assign provider/phone without touching balance)
    // — upsert without writing a history row, since no balance actually
    // moved. balance is left NULL (not defaulted to 0) on a brand-new row:
    // assigning a provider/phone number is not the same as confirming a
    // real balance, and a fake $0.00 here is exactly the stale/invented
    // value the dashboard must never show (migration 068).
    await query(
      `INSERT INTO sim_balances (id, device_id, sim_slot, company_id, phone_number)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       ON CONFLICT (device_id, sim_slot) DO UPDATE
       SET company_id=COALESCE($3, sim_balances.company_id),
           phone_number=COALESCE($4, sim_balances.phone_number),
           updated_at=now()`,
      [req.params.deviceId, simSlot, companyId ?? null, phoneNumber ?? null]
    );
  }

  if (threshold !== undefined) {
    const num = Number(threshold);
    if (!Number.isFinite(num) || num < 0) return sendJson(res, 400, { error: "threshold must be a non-negative number" });
    await query(
      `INSERT INTO sim_balances (id, device_id, sim_slot, low_balance_threshold)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT (device_id, sim_slot) DO UPDATE SET low_balance_threshold=$3, updated_at=now()`,
      [req.params.deviceId, simSlot, num]
    );
  }

  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_sim_balance",
    entityType: "sim_balance",
    entityId: `${req.params.deviceId}:${simSlot}`,
    oldValue: null,
    newValue: { deviceId: req.params.deviceId, simSlot, balance, threshold, companyId, phoneNumber },
  });

  const row = await queryOne(
    `SELECT * FROM (${SIM_BALANCE_LIST_SQL}) rows WHERE device_id=$1 AND sim_slot=$2`,
    [req.params.deviceId, simSlot]
  );
  sendJson(res, 200, row ?? { deviceId: req.params.deviceId, simSlot });
});

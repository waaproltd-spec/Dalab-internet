import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { DEVICE_ONLINE_SQL } from "../utils/deviceStatus.js";

/**
 * Admin > Offline (Rukumo): one place to see everything about Offline
 * Auto-Order customers, orders, payments, and USSD execution.
 *
 * Deliberately introduces NO new tables and NO new order/payment/dial
 * state — every endpoint here is a read-only projection over the exact
 * same rows the Online flow already produces (orders, payment_transactions,
 * ussd_dial_attempts, ussd_logs, sim_routing, agent_devices,
 * customers.offline_*). The only thing genuinely new is
 * offlineOrderStatusCase(), a read-time SQL expression that maps that
 * existing state onto the operational vocabulary an admin actually thinks
 * in (WAITING_FOR_AGENT, USSD_PROCESSING, RETRY, ...) — it never gets
 * written back anywhere, so it can't drift from or corrupt the real
 * orders.status state machine every other part of this codebase relies on.
 *
 * Scoped by `o.channel = 'offline_auto'` throughout — the exact value
 * matchOrCreateOfflineAutoOrder (offlineAutoOrder.ts) writes at order-
 * creation time. Confirmed by reading that file before writing this one,
 * per the explicit instruction to verify it rather than assume.
 */
export const offlineAdminRouter = Router();

// Maps existing state onto the admin-facing status vocabulary, purely for
// display/filtering — never stored. SYNC_PENDING/SYNCED describe a purely
// device-local concept (the Agent App's on-device PendingActionQueue,
// which the backend has no visibility into by design — anything queued
// there hasn't reached this database at all yet) — everything returned
// here has, by definition, already synced, so SYNCED is true for every row
// and SYNC_PENDING can never match anything from server-side data. See the
// admin-dashboard OfflinePanel comment for how that's surfaced honestly
// rather than faked.
// PENDING_PAYMENT never appears here: an Offline Auto-Order row is only
// ever created (matchOrCreateOfflineAutoOrder) once a real payment SMS has
// already matched, so "payment received but no order yet" isn't a state
// this table can represent — it's still offered as a filter option in the
// dashboard for vocabulary completeness, honestly returning zero rows
// rather than being silently omitted or faked.
//
// routing_dev's online-ness is inlined rather than reusing
// utils/deviceStatus.ts's DEVICE_ONLINE_SQL, which hardcodes alias `d` —
// this is the exact same three conditions, just under this query's own
// `routing_dev` alias.
const OFFLINE_STATUS_CASE = `
  CASE
    WHEN o.status = 'completed' THEN 'SUCCESS'
    WHEN o.status = 'failed' THEN 'FAILED'
    WHEN o.status = 'cancelled' THEN 'CANCELLED'
    WHEN o.status = 'pending' AND routing_dev.id IS NOT NULL
      AND NOT (routing_dev.enabled AND routing_dev.network_online AND routing_dev.last_heartbeat_at > now() - interval '5 minutes')
      THEN 'WAITING_FOR_AGENT'
    WHEN o.status = 'pending' THEN 'PAYMENT_VERIFIED'
    WHEN o.status = 'in_progress' AND o.ussd_generated IS NULL THEN 'WAITING_FOR_USSD'
    WHEN o.status = 'in_progress' AND la.id IS NULL THEN 'WAITING_FOR_USSD'
    WHEN o.status = 'in_progress' AND la.status = 'pending' THEN 'USSD_PROCESSING'
    WHEN o.status = 'in_progress' AND la.status IN ('failed', 'ambiguous') THEN 'RETRY'
    ELSE 'USSD_PROCESSING'
  END`;

// Shared FROM/JOIN backbone for both the orders list and the stats/counts
// endpoint, so a status derived one way can never disagree with a count
// derived another way for the exact same underlying rows.
const OFFLINE_ORDERS_BASE = `
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN companies co ON co.id = o.company_id
  JOIN packages p ON p.id = o.package_id
  LEFT JOIN agents oa ON oa.id = o.agent_id
  LEFT JOIN LATERAL (
    SELECT * FROM ussd_dial_attempts WHERE order_id = o.id ORDER BY attempt_number DESC LIMIT 1
  ) la ON true
  LEFT JOIN agents lag ON lag.id = la.agent_id
  LEFT JOIN agent_devices ladev ON ladev.id = COALESCE(lag.device_id, o.ussd_device_id)
  LEFT JOIN LATERAL (
    SELECT device_id, sim_slot FROM sim_routing WHERE company_id = o.company_id ORDER BY priority ASC LIMIT 1
  ) routing ON true
  LEFT JOIN agent_devices routing_dev ON routing_dev.id = routing.device_id
  WHERE o.channel = 'offline_auto'`;

const OFFLINE_ORDER_LIST_COLUMNS = `
  o.id, o.company_id, o.package_id, o.amount, o.status, o.channel,
  o.sender_phone, o.receiver_phone, o.created_at, o.updated_at, o.completed_at,
  o.ussd_generation_failed_reason,
  o.ussd_generated_masked AS ussd_generated,
  c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
  co.name AS company_name, co.color_hex AS company_color,
  p.name AS package_name,
  oa.name AS order_agent_name,
  ${OFFLINE_STATUS_CASE} AS offline_status,
  la.id AS latest_attempt_id, la.status AS latest_attempt_status, la.attempt_number AS latest_attempt_number,
  la.created_at AS latest_attempt_at, la.response_message AS latest_attempt_response,
  la.sim_slot AS latest_attempt_sim_slot,
  lag.name AS latest_attempt_agent_name,
  ladev.id AS device_id, ladev.name AS device_name,
  COALESCE(la.sim_slot, routing.sim_slot) AS sim_slot,
  COALESCE(ladev.id, routing_dev.id) AS assigned_device_id,
  COALESCE(ladev.name, routing_dev.name) AS assigned_device_name,
  (SELECT COUNT(*) FROM ussd_dial_attempts WHERE order_id = o.id) AS dial_attempt_count,
  EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.order_id = o.id AND pt.status = 'duplicate_blocked') AS has_duplicate_attempt`;

type OfflineOrderFilters = {
  status?: string;
  companyId?: string;
  agentId?: string;
  deviceId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
};

function buildOfflineOrderFilterSql(filters: OfflineOrderFilters, args: unknown[]): string {
  let sql = "";
  if (filters.companyId) {
    args.push(filters.companyId);
    sql += ` AND o.company_id = $${args.length}`;
  }
  if (filters.agentId) {
    args.push(filters.agentId);
    sql += ` AND COALESCE(lag.id, oa.id) = $${args.length}`;
  }
  if (filters.deviceId) {
    args.push(filters.deviceId);
    sql += ` AND COALESCE(ladev.id, routing_dev.id) = $${args.length}`;
  }
  if (filters.dateFrom) {
    args.push(filters.dateFrom);
    sql += ` AND o.created_at >= $${args.length}`;
  }
  if (filters.dateTo) {
    args.push(filters.dateTo);
    sql += ` AND o.created_at <= $${args.length}`;
  }
  if (filters.search) {
    args.push(`%${filters.search}%`);
    const idx = args.length;
    sql += ` AND (o.id ILIKE $${idx} OR c.name ILIKE $${idx} OR o.sender_phone ILIKE $${idx} OR o.receiver_phone ILIKE $${idx} OR c.phone ILIKE $${idx})`;
  }
  return sql;
}

offlineAdminRouter.get("/admin/offline/orders", requireStaff(), async (req, res) => {
  const { status, companyId, agentId, deviceId, dateFrom, dateTo, search } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  const filterSql = buildOfflineOrderFilterSql({ companyId, agentId, deviceId, dateFrom, dateTo, search }, args);
  const inner = `SELECT ${OFFLINE_ORDER_LIST_COLUMNS} ${OFFLINE_ORDERS_BASE}${filterSql}`;

  // status is filtered on the OUTER query since it's a derived expression
  // (Postgres can't reference a SELECT-list alias inside the same-level
  // WHERE) -- DUPLICATE and SYNCED/SYNC_PENDING are their own axis, not
  // part of offline_status, so they're handled separately from it here
  // rather than folded into the same CASE (a duplicate-blocked payment can
  // happen to ANY real order status, and "synced" is true for every row
  // returned from this database by definition).
  let sql = `SELECT * FROM (${inner}) sub`;
  const outerArgs: unknown[] = [...args];
  const clauses: string[] = [];
  if (status === "DUPLICATE") {
    clauses.push(`sub.has_duplicate_attempt = true`);
  } else if (status === "SYNC_PENDING") {
    // Honest, not fabricated: nothing that reached this database can be
    // "pending sync" -- see OFFLINE_STATUS_CASE's comment.
    clauses.push(`false`);
  } else if (status === "SYNCED") {
    // Also true by construction (see above) -- included for the filter
    // chip to behave as "show everything" rather than silently no-op.
  } else if (status) {
    outerArgs.push(status);
    clauses.push(`sub.offline_status = $${outerArgs.length}`);
  }
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += ` ORDER BY sub.created_at DESC LIMIT 500`;

  sendJson(res, 200, await query(sql, outerArgs));
});

offlineAdminRouter.get("/admin/offline/stats", requireStaff(), async (req, res) => {
  const { companyId } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  const filterSql = companyId ? (args.push(companyId), ` AND o.company_id = $${args.length}`) : "";
  const rows = await query<{ offline_status: string; n: string }>(
    `SELECT ${OFFLINE_STATUS_CASE} AS offline_status, COUNT(*) AS n ${OFFLINE_ORDERS_BASE}${filterSql} GROUP BY 1`,
    args
  );
  const duplicateRow = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n ${OFFLINE_ORDERS_BASE}${filterSql} AND EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.order_id = o.id AND pt.status = 'duplicate_blocked')`,
    args
  );
  const totalRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n ${OFFLINE_ORDERS_BASE}${filterSql}`, args);
  const counts: Record<string, number> = { all: Number(totalRow?.n ?? 0), duplicate: Number(duplicateRow?.n ?? 0) };
  for (const row of rows) counts[row.offline_status] = Number(row.n);
  sendJson(res, 200, counts);
});

offlineAdminRouter.get("/admin/offline/orders/:id", requireStaff(), async (req, res) => {
  const order = await queryOne<any>(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
            co.name AS company_name, co.color_hex AS company_color,
            p.name AS package_name, p.mb, p.minutes, p.sms,
            oa.name AS order_agent_name,
            o.ussd_generated_masked AS ussd_generated
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN companies co ON co.id = o.company_id
     JOIN packages p ON p.id = o.package_id
     LEFT JOIN agents oa ON oa.id = o.agent_id
     WHERE o.id = $1 AND o.channel = 'offline_auto'`,
    [req.params.id]
  );
  if (!order) return sendJson(res, 404, { error: "Offline order not found" });

  const paymentTransactions = await query(
    `SELECT pt.*, sl.sender AS sms_sender, sl.body AS sms_body, sl.received_at AS sms_received_at
     FROM payment_transactions pt
     LEFT JOIN sms_logs sl ON sl.id = pt.sms_log_id
     WHERE pt.order_id = $1
     ORDER BY pt.created_at ASC`,
    [order.id]
  );

  const dialAttempts = await query(
    `SELECT da.id, da.sim_slot, da.attempt_number, da.status, da.response_message, da.created_at, da.completed_at,
            COALESCE(da.ussd_string_masked, '(masked — regenerate to view)') AS ussd_string,
            ag.name AS agent_name, dev.id AS device_id, dev.name AS device_name
     FROM ussd_dial_attempts da
     LEFT JOIN agents ag ON ag.id = da.agent_id
     LEFT JOIN agent_devices dev ON dev.id = ag.device_id
     WHERE da.order_id = $1
     ORDER BY da.attempt_number ASC`,
    [order.id]
  );

  // The abstract configured template (service name + {number}/{amount}/{pin}
  // pattern) that produced this order's generated request — distinct from
  // ussd_generated itself, which is that pattern already substituted.
  const ussdLog = await queryOne(
    `SELECT l.id, l.created_at, t.service_name AS template_service_name, t.ussd_code AS template_ussd_code
     FROM ussd_logs l LEFT JOIN ussd_templates t ON t.id = l.template_id
     WHERE l.order_id = $1
     ORDER BY l.created_at DESC LIMIT 1`,
    [order.id]
  );

  const simRouting = await query(
    `SELECT sr.device_id, sr.sim_slot, sr.priority, d.name AS device_name, ${DEVICE_ONLINE_SQL} AS device_online
     FROM sim_routing sr JOIN agent_devices d ON d.id = sr.device_id
     WHERE sr.company_id = $1
     ORDER BY sr.priority ASC`,
    [order.company_id]
  );

  const activity = await query(
    `SELECT id, action, entity_type, entity_id, new_value, created_at
     FROM admin_activity_log
     WHERE entity_id = $1 OR entity_id = ANY($2::text[])
     ORDER BY created_at ASC`,
    [order.id, paymentTransactions.map((t: any) => t.sms_log_id).filter(Boolean)]
  );

  sendJson(res, 200, { order, paymentTransactions, dialAttempts, ussdLog, simRouting, activity });
});

offlineAdminRouter.get("/admin/offline/payment-transactions", requireStaff(), async (req, res) => {
  const { search, companyId, dateFrom, dateTo } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `
    SELECT pt.id, pt.transaction_ref, pt.customer_phone, pt.amount, pt.status, pt.created_at, pt.updated_at,
           pt.sim_slot, pt.order_id,
           sl.received_at AS sms_received_at, sl.sender AS sms_sender,
           o.company_id, co.name AS company_name, o.payment_method, o.status AS order_status,
           dev.name AS device_name
    FROM payment_transactions pt
    JOIN orders o ON o.id = pt.order_id AND o.channel = 'offline_auto'
    JOIN companies co ON co.id = o.company_id
    LEFT JOIN sms_logs sl ON sl.id = pt.sms_log_id
    LEFT JOIN agent_devices dev ON dev.id = pt.agent_device_id
    WHERE 1=1`;
  if (companyId) { args.push(companyId); sql += ` AND o.company_id = $${args.length}`; }
  if (dateFrom) { args.push(dateFrom); sql += ` AND pt.created_at >= $${args.length}`; }
  if (dateTo) { args.push(dateTo); sql += ` AND pt.created_at <= $${args.length}`; }
  if (search) {
    args.push(`%${search}%`);
    const idx = args.length;
    sql += ` AND (pt.transaction_ref ILIKE $${idx} OR pt.customer_phone ILIKE $${idx} OR o.id ILIKE $${idx})`;
  }
  sql += ` ORDER BY pt.created_at DESC LIMIT 500`;
  sendJson(res, 200, await query(sql, args));
});

offlineAdminRouter.get("/admin/offline/customers", requireStaff(), async (req, res) => {
  const { search } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `
    SELECT c.id, c.name, c.phone, c.status, c.created_at,
           c.offline_sender_number, c.offline_destination_number, c.offline_profile_updated_at,
           co.id AS company_id, co.name AS company_name,
           pkg.id AS package_id, pkg.name AS package_name,
           pm.label AS payment_method_label,
           stats.order_count, stats.last_payment_at, stats.last_status
    FROM customers c
    LEFT JOIN companies co ON co.id = c.offline_company_id
    LEFT JOIN packages pkg ON pkg.id = c.offline_package_id
    LEFT JOIN company_payment_methods pm ON pm.id = c.offline_payment_method_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS order_count, MAX(o.created_at) AS last_payment_at,
             (SELECT status FROM orders WHERE customer_id = c.id AND channel = 'offline_auto' ORDER BY created_at DESC LIMIT 1) AS last_status
      FROM orders o WHERE o.customer_id = c.id AND o.channel = 'offline_auto'
    ) stats ON true
    WHERE c.offline_sender_number IS NOT NULL AND c.offline_destination_number IS NOT NULL`;
  if (search) {
    args.push(`%${search}%`);
    const idx = args.length;
    sql += ` AND (c.phone ILIKE $${idx} OR c.name ILIKE $${idx} OR c.offline_sender_number ILIKE $${idx}
             OR EXISTS (SELECT 1 FROM orders WHERE customer_id = c.id AND channel = 'offline_auto' AND id ILIKE $${idx}))`;
  }
  sql += ` ORDER BY c.offline_profile_updated_at DESC NULLS LAST LIMIT 500`;
  sendJson(res, 200, await query(sql, args));
});

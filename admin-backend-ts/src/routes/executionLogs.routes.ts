import { Router } from "express";
import { query } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

export const executionLogsRouter = Router();

/**
 * One row per USSD dial attempt, enriched with the order/customer/agent/
 * company/package context the Device & USSD audit view needs. Multiple rows
 * share an order_id when a dial was retried (attempt_number increases), so
 * the dashboard groups by orderId to show retry history — no new tables
 * needed, this all already exists across ussd_dial_attempts/orders/
 * customers/agents/companies/packages.
 */
executionLogsRouter.get("/admin/execution-logs", requireStaff(), async (req, res) => {
  const { orderId, agentId, companyId, status } = req.query as Record<string, string | undefined>;
  let sql = `
    SELECT da.id, da.order_id, da.sim_slot, da.ussd_string, da.attempt_number,
           da.status, da.response_message, da.created_at,
           o.amount, o.company_id, co.name AS company_name,
           c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
           p.name AS package_name,
           a.id AS agent_id, a.name AS agent_name
    FROM ussd_dial_attempts da
    JOIN orders o ON o.id = da.order_id
    JOIN companies co ON co.id = o.company_id
    JOIN customers c ON c.id = o.customer_id
    JOIN packages p ON p.id = o.package_id
    LEFT JOIN agents a ON a.id = da.agent_id
    WHERE 1=1`;
  const args: unknown[] = [];
  if (orderId) { args.push(orderId); sql += ` AND da.order_id=$${args.length}`; }
  if (agentId) { args.push(agentId); sql += ` AND da.agent_id=$${args.length}`; }
  if (companyId) { args.push(companyId); sql += ` AND o.company_id=$${args.length}`; }
  if (status) { args.push(status); sql += ` AND da.status=$${args.length}`; }
  sql += ` ORDER BY da.order_id DESC, da.attempt_number ASC`;
  sendJson(res, 200, await query(sql, args));
});

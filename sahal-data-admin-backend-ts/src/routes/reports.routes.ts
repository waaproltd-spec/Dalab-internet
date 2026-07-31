import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";

export const reportsRouter = Router();

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  return lines.join("\n");
}

const RANGE_TO_INTERVAL: Record<string, string> = {
  daily: "1 day",
  weekly: "7 days",
  monthly: "1 month",
  yearly: "1 year",
};

// Agent's own sales report — same shape as /admin/reports, scoped to orders
// this agent personally completed, plus running totals for a dashboard tile.
reportsRouter.get("/agent/reports", requireAuth("agent"), async (req, res) => {
  const range = String(req.query.range ?? "weekly");
  const interval = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL.weekly;
  const series = await query(
    `SELECT date(completed_at) AS day, SUM(amount) AS sales, COUNT(*) AS orders
     FROM orders
     WHERE status='completed' AND agent_id=$1 AND completed_at >= now() - $2::interval
     GROUP BY date(completed_at)
     ORDER BY day`,
    [req.auth!.sub, interval]
  );
  const totals = await queryOne(
    `SELECT COALESCE(SUM(amount),0) AS total_sales, COUNT(*) AS total_orders
     FROM orders WHERE status='completed' AND agent_id=$1`,
    [req.auth!.sub]
  );
  sendJson(res, 200, { range, series, totals });
});

reportsRouter.get("/admin/reports", requireStaff(), async (req, res) => {
  const range = String(req.query.range ?? "weekly");
  const interval = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL.weekly;
  const rows = await query(
    `SELECT date(created_at) AS day, SUM(amount) AS sales, COUNT(*) AS orders
     FROM orders
     WHERE status='completed' AND created_at >= now() - $1::interval
     GROUP BY date(created_at)
     ORDER BY day`,
    [interval]
  );
  sendJson(res, 200, { range, series: rows });
});

reportsRouter.get("/admin/reports/companies", requireStaff(), async (req, res) => {
  const range = String(req.query.range ?? "monthly");
  const interval = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL.monthly;
  const rows = await query(
    `SELECT co.id AS company_id, co.name AS company_name,
            COUNT(o.id) FILTER (WHERE o.status='completed') AS completed_orders,
            COALESCE(SUM(o.amount) FILTER (WHERE o.status='completed'), 0) AS total_sales
     FROM companies co
     LEFT JOIN orders o ON o.company_id = co.id AND o.created_at >= now() - $1::interval
     GROUP BY co.id, co.name
     ORDER BY total_sales DESC`,
    [interval]
  );
  sendJson(res, 200, { range, companies: rows });
});

reportsRouter.get("/admin/reports/agents", requireStaff(), async (req, res) => {
  const range = String(req.query.range ?? "monthly");
  const interval = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL.monthly;
  const rows = await query(
    `SELECT a.id AS agent_id, a.name AS agent_name,
            COUNT(o.id) FILTER (WHERE o.status='completed') AS completed_orders,
            COALESCE(SUM(o.amount) FILTER (WHERE o.status='completed'), 0) AS total_sales
     FROM agents a
     LEFT JOIN orders o ON o.agent_id = a.id AND o.created_at >= now() - $1::interval
     GROUP BY a.id, a.name
     ORDER BY total_sales DESC`,
    [interval]
  );
  sendJson(res, 200, { range, agents: rows });
});

reportsRouter.get("/admin/reports/export", requirePermission("reports.export"), async (req, res) => {
  const format = String(req.query.format ?? "json");
  if (!["pdf", "xlsx", "json", "csv"].includes(format)) {
    return sendJson(res, 400, { error: "format must be pdf, xlsx, csv, or json" });
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT o.id, c.name AS customer_name, co.name AS company, o.amount, o.status, o.created_at
     FROM orders o JOIN customers c ON c.id=o.customer_id JOIN companies co ON co.id=o.company_id
     ORDER BY o.created_at DESC`
  );
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=sahal-data-orders-report.csv");
    res.status(200).send(toCsv(rows));
    return;
  }
  if (format !== "json") {
    return sendJson(res, 501, {
      error: `${format.toUpperCase()} generation needs a PDF/XLSX library added to package.json — the same data is available via format=json or format=csv.`,
    });
  }
  sendJson(res, 200, rows);
});

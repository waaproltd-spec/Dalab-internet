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

// My Reports (Agent App) date-range boundaries. today/yesterday need a hard
// calendar-day cutoff (Postgres session TimeZone is pinned to
// Africa/Mogadishu in db/pool.ts, so date_trunc('day', now()) already lands
// on Mogadishu midnight, not UTC midnight) -- every other range is a simple
// rolling window, matching RANGE_TO_INTERVAL's existing convention above.
// start/end are fixed literal SQL fragments from this map only (never raw
// user input), so interpolating them directly below is safe.
const AGENT_REPORT_RANGES: Record<string, { start: string; end?: string }> = {
  today: { start: "date_trunc('day', now())" },
  yesterday: { start: "date_trunc('day', now()) - interval '1 day'", end: "date_trunc('day', now())" },
  week: { start: "now() - interval '7 days'" },
  "1month": { start: "now() - interval '1 month'" },
  "3months": { start: "now() - interval '3 months'" },
  "6months": { start: "now() - interval '6 months'" },
  "1year": { start: "now() - interval '1 year'" },
};

// Fixed 4-company skeleton (not a `companies` table lookup) so a company
// with zero completed orders in range still gets its own $0 / 0-orders row
// instead of silently disappearing from the ranking -- same pattern
// AGENT_BALANCE_CARDS (simBalances.routes.ts) already uses for the same
// reason on the Agent Balance section.
const AGENT_REPORT_COMPANIES: Array<{ companyId: string; companyName: string }> = [
  { companyId: "hormuud", companyName: "Hormuud" },
  { companyId: "somnet", companyName: "Somnet" },
  { companyId: "somtel", companyName: "Somtel" },
  { companyId: "amtel", companyName: "Amtel" },
];

// Agent's own sales report for the Agent App's "My Reports" screen, scoped
// to orders this agent personally completed. totals is the existing
// all-time figure (unchanged calculation, still returned so it stays
// accurate even when the selected period has no completed orders);
// periodTotals/companies/topCustomers are new, all scoped to the selected
// range only.
reportsRouter.get("/agent/reports", requireAuth("agent"), async (req, res) => {
  const requestedRange = String(req.query.range ?? "today");
  const range = AGENT_REPORT_RANGES[requestedRange] ? requestedRange : "today";
  const bounds = AGENT_REPORT_RANGES[range];
  const dateFilter = (col: string) => `${col} >= ${bounds.start}` + (bounds.end ? ` AND ${col} < ${bounds.end}` : "");
  const agentId = req.auth!.sub;

  const totals = await queryOne(
    `SELECT COALESCE(SUM(amount),0) AS total_sales, COUNT(*) AS total_orders
     FROM orders WHERE status='completed' AND agent_id=$1`,
    [agentId]
  );

  const periodTotalsRow = await queryOne<{ total_sales: string; total_orders: string; total_customers: string }>(
    `SELECT COALESCE(SUM(amount),0) AS total_sales, COUNT(*) AS total_orders,
            COUNT(DISTINCT customer_id) AS total_customers
     FROM orders WHERE status='completed' AND agent_id=$1 AND ${dateFilter("completed_at")}`,
    [agentId]
  );
  const periodTotals = {
    total_sales: Number(periodTotalsRow?.total_sales ?? 0),
    total_orders: Number(periodTotalsRow?.total_orders ?? 0),
    total_customers: Number(periodTotalsRow?.total_customers ?? 0),
  };

  const companyRows = await query<{ company_id: string; total_sales: string; total_orders: string }>(
    `SELECT company_id, COALESCE(SUM(amount),0) AS total_sales, COUNT(*) AS total_orders
     FROM orders
     WHERE status='completed' AND agent_id=$1 AND ${dateFilter("completed_at")}
     GROUP BY company_id`,
    [agentId]
  );
  // Ascending by sales (lowest first) so the ranking reads as a leaderboard
  // with the top performer last -- rank is n-minus-index so the highest
  // seller is always #1 regardless of range/data, never a fixed order.
  const companies = AGENT_REPORT_COMPANIES.map((c) => {
    const row = companyRows.find((r) => r.company_id === c.companyId);
    return {
      company_id: c.companyId,
      company_name: c.companyName,
      total_sales: Number(row?.total_sales ?? 0),
      total_orders: Number(row?.total_orders ?? 0),
    };
  })
    .sort((a, b) => a.total_sales - b.total_sales)
    .map((c, index, arr) => ({ ...c, rank: arr.length - index }));

  const topCustomersRows = await query<{ customer_id: string; name: string | null; phone: string; completed_orders: string; total_spent: string }>(
    `SELECT o.customer_id, c.name, c.phone,
            COUNT(*) AS completed_orders, COALESCE(SUM(o.amount),0) AS total_spent
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status='completed' AND o.agent_id=$1 AND ${dateFilter("o.completed_at")}
     GROUP BY o.customer_id, c.name, c.phone
     ORDER BY completed_orders DESC, total_spent DESC
     LIMIT 5`,
    [agentId]
  );
  const topCustomers = topCustomersRows.map((row, index) => ({
    rank: index + 1,
    customer_id: row.customer_id,
    name: row.name,
    phone: row.phone,
    completed_orders: Number(row.completed_orders),
    total_spent: Number(row.total_spent),
  }));

  sendJson(res, 200, { range, totals, periodTotals, companies, topCustomers });
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
    res.setHeader("Content-Disposition", "attachment; filename=dalab-orders-report.csv");
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

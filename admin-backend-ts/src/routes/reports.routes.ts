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

// ---------------- Agent App Reports dashboard ----------------
// The redesigned Agent App "Reports" screen (GET /agent/reports above stays
// unchanged for older app builds). Everything is scoped to this agent's
// orders (agent_id) created in the selected period, and every figure is
// computed per company from that company's own orders -- never combined.
//
// Money, per successfully sent order (status completed, not reversed):
//   company cost   = provider_amount x send_count (what the USSD actually
//                    sends, once per delivery; falls back to amount)
//   selling price  = list_price (the package's original/old price, saved on
//                    the order when it was created -- migration 115)
//   discount       = selling price - amount paid (never below 0)
//   final price    = amount paid ("Successful Value")
//   actual profit  = amount paid - company cost
// start fragments come only from this fixed map, never from user input.
const DASHBOARD_RANGES: Record<string, string | null> = {
  today: "date_trunc('day', now())",
  "7days": "now() - interval '7 days'",
  "30days": "now() - interval '30 days'",
  all: null,
};

const SENT = `o.status = 'completed' AND o.reversed_at IS NULL`;
const COST = `COALESCE(o.provider_amount, o.amount) * COALESCE(o.send_count, 1)`;
const SELLING = `GREATEST(COALESCE(o.list_price, o.amount), o.amount)`;
// Per-group money/status aggregates over orders aliased "o".
const DASHBOARD_AGGREGATES = `
  COUNT(*) FILTER (WHERE ${SENT}) AS sent,
  COUNT(*) FILTER (WHERE o.status = 'failed') AS failed,
  COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled,
  COALESCE(SUM(o.amount) FILTER (WHERE ${SENT}), 0) AS successful_value,
  COALESCE(SUM(${COST}) FILTER (WHERE ${SENT}), 0) AS company_cost,
  COALESCE(SUM(${SELLING}) FILTER (WHERE ${SENT}), 0) AS selling_value,
  COALESCE(SUM(${SELLING} - o.amount) FILTER (WHERE ${SENT}), 0) AS discount`;

type AggregateRow = {
  sent: string | number; failed: string | number; cancelled: string | number;
  successful_value: string | number; company_cost: string | number; selling_value: string | number; discount: string | number;
};

const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function summarize(row: Partial<AggregateRow> | null | undefined) {
  const sent = Number(row?.sent ?? 0);
  const failed = Number(row?.failed ?? 0);
  const cancelled = Number(row?.cancelled ?? 0);
  const totalOrders = sent + failed + cancelled;
  const successfulValue = money(row?.successful_value);
  const companyCost = money(row?.company_cost);
  const sellingValue = money(row?.selling_value);
  const discount = money(row?.discount);
  return {
    total_orders: totalOrders,
    successful_value: successfulValue,
    total_profit: money(successfulValue - companyCost),
    total_discount: discount,
    status: {
      sent, failed, cancelled,
      sent_percent: pct(sent, totalOrders),
      failed_percent: pct(failed, totalOrders),
      cancelled_percent: pct(cancelled, totalOrders),
    },
    // The Profit section: cost + markup = selling; selling - discount =
    // final; final - cost = actual profit.
    profit_breakdown: {
      company_cost: companyCost,
      markup: money(sellingValue - companyCost),
      selling_price: sellingValue,
      discount,
      final_price: successfulValue,
      actual_profit: money(successfulValue - companyCost),
    },
  };
}

function dashboardRange(req: { query: Record<string, unknown> }) {
  const requested = String(req.query.range ?? "all");
  const range = requested in DASHBOARD_RANGES ? requested : "all";
  const start = DASHBOARD_RANGES[range];
  return { range, dateFilter: start ? `AND o.created_at >= ${start}` : "" };
}

reportsRouter.get("/agent/reports/dashboard", requireAuth("agent"), async (req, res) => {
  const { range, dateFilter } = dashboardRange(req);
  const agentId = req.auth!.sub;

  const overall = await queryOne<AggregateRow>(
    `SELECT ${DASHBOARD_AGGREGATES} FROM orders o WHERE o.agent_id = $1 ${dateFilter}`,
    [agentId]
  );
  const summary = summarize(overall);

  // Every live company (from the companies table, so a newly added
  // provider appears automatically), each from its own orders only.
  const companyRows = await query<AggregateRow & { id: string; name: string; color_hex: string | null; has_logo: boolean }>(
    `SELECT c.id, c.name, c.color_hex, (c.logo_data IS NOT NULL) AS has_logo, ${DASHBOARD_AGGREGATES}
     FROM companies c
     LEFT JOIN orders o ON o.company_id = c.id AND o.agent_id = $1 ${dateFilter}
     WHERE c.deleted_at IS NULL
     GROUP BY c.id, c.name, c.color_hex, c.logo_data IS NOT NULL, c.sort_order
     ORDER BY c.sort_order, c.name`,
    [agentId]
  );
  const companies = companyRows.map((row) => {
    const s = summarize(row);
    return {
      company_id: row.id,
      company_name: row.name,
      color_hex: row.color_hex,
      has_logo: row.has_logo,
      total_orders: s.total_orders,
      successful_value: s.successful_value,
      total_profit: s.total_profit,
      total_discount: s.total_discount,
      share_percent: pct(s.total_orders, summary.total_orders),
    };
  });

  sendJson(res, 200, { range, ...summary, companies });
});

// One company's own report: its summary, status split, every package's
// performance, and a worked price example from its most-ordered package.
reportsRouter.get("/agent/reports/dashboard/companies/:companyId", requireAuth("agent"), async (req, res) => {
  const { range, dateFilter } = dashboardRange(req);
  const agentId = req.auth!.sub;
  const company = await queryOne<{ id: string; name: string; color_hex: string | null; has_logo: boolean }>(
    `SELECT id, name, color_hex, (logo_data IS NOT NULL) AS has_logo FROM companies WHERE id = $1`,
    [req.params.companyId]
  );
  if (!company) return sendJson(res, 404, { error: "Company not found" });

  const overall = await queryOne<AggregateRow>(
    `SELECT ${DASHBOARD_AGGREGATES} FROM orders o WHERE o.agent_id = $1 AND o.company_id = $2 ${dateFilter}`,
    [agentId, company.id]
  );
  const summary = summarize(overall);

  const packageRows = await query<AggregateRow & { id: string; name: string; validity: string | null; has_image: boolean }>(
    `SELECT p.id, p.name, p.validity, (p.image_data IS NOT NULL) AS has_image, ${DASHBOARD_AGGREGATES}
     FROM orders o JOIN packages p ON p.id = o.package_id
     WHERE o.agent_id = $1 AND o.company_id = $2 ${dateFilter}
     GROUP BY p.id, p.name, p.validity, p.image_data IS NOT NULL
     ORDER BY COUNT(*) DESC, p.name`,
    [agentId, company.id]
  );
  const packages = packageRows.map((row) => {
    const s = summarize(row);
    return {
      package_id: row.id,
      name: row.name,
      validity: row.validity,
      has_image: row.has_image,
      total_orders: s.total_orders,
      successful_value: s.successful_value,
      total_profit: s.total_profit,
      total_discount: s.total_discount,
    };
  });

  // Worked example for one sale of the most-ordered package, from that
  // package's own current prices.
  let priceExample = null;
  if (packages.length > 0) {
    const pkg = await queryOne<{ name: string; validity: string | null; price: string; old_price: string | null; provider_amount: string | null; send_count: number }>(
      `SELECT name, validity, price, old_price, provider_amount, send_count FROM packages WHERE id = $1`,
      [packages[0].package_id]
    );
    if (pkg) {
      const finalPrice = money(pkg.price);
      const companyCost = money(Number(pkg.provider_amount ?? pkg.price) * Number(pkg.send_count ?? 1));
      const sellingPrice = money(Math.max(Number(pkg.old_price ?? pkg.price), finalPrice));
      priceExample = {
        package_name: pkg.name,
        validity: pkg.validity,
        company_cost: companyCost,
        markup: money(sellingPrice - companyCost),
        selling_price: sellingPrice,
        discount: money(sellingPrice - finalPrice),
        final_price: finalPrice,
        actual_profit: money(finalPrice - companyCost),
      };
    }
  }

  sendJson(res, 200, {
    range,
    company: { company_id: company.id, company_name: company.name, color_hex: company.color_hex, has_logo: company.has_logo },
    ...summary,
    packages,
    price_example: priceExample,
  });
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

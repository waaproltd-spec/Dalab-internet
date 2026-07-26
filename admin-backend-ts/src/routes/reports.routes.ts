import { Router } from "express";
import { query } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

export const reportsRouter = Router();

const RANGE_TO_INTERVAL: Record<string, string> = {
  daily: "1 day",
  weekly: "7 days",
  monthly: "1 month",
  yearly: "1 year",
};

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

reportsRouter.get("/admin/reports/export", requireStaff(), async (req, res) => {
  const format = String(req.query.format ?? "json");
  if (!["pdf", "xlsx", "json"].includes(format)) {
    return sendJson(res, 400, { error: "format must be pdf, xlsx, or json" });
  }
  const rows = await query(
    `SELECT o.id, c.name AS customer_name, co.name AS company, o.amount, o.status, o.created_at
     FROM orders o JOIN customers c ON c.id=o.customer_id JOIN companies co ON co.id=o.company_id
     ORDER BY o.created_at DESC`
  );
  if (format !== "json") {
    return sendJson(res, 501, {
      error: `${format.toUpperCase()} generation needs a PDF/XLSX library added to package.json — the same data is available via format=json.`,
    });
  }
  sendJson(res, 200, rows);
});

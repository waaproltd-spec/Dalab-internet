import { requireAuth } from "../auth/middleware.js";

const RANGE_TO_SQLITE_MODIFIER = {
  daily: "-1 day",
  weekly: "-7 days",
  monthly: "-1 month",
  yearly: "-1 year",
};

export function registerReportRoutes(app, db) {
  app.get("/admin/reports", requireAuth("super_admin"), async (ctx) => {
    const range = ctx.query.range ?? "weekly";
    const modifier = RANGE_TO_SQLITE_MODIFIER[range] ?? RANGE_TO_SQLITE_MODIFIER.weekly;
    const rows = db.prepare(
      `SELECT date(created_at) AS day, SUM(amount) AS sales, COUNT(*) AS orders
       FROM orders
       WHERE status = 'completed' AND created_at >= datetime('now', ?)
       GROUP BY date(created_at)
       ORDER BY day`
    ).all(modifier);
    ctx.json(200, { range, series: rows });
  });

  // A real implementation would stream a generated PDF/XLSX; this sandbox
  // returns the same aggregated data as JSON so the endpoint is real and
  // testable without needing a PDF/XLSX library this environment can't install.
  app.get("/admin/reports/export", requireAuth("super_admin"), async (ctx) => {
    const format = ctx.query.format ?? "json";
    if (!["pdf", "xlsx", "json"].includes(format)) {
      return ctx.json(400, { error: "format must be pdf, xlsx, or json" });
    }
    const rows = db.prepare(
      `SELECT o.id, c.name AS customer_name, co.name AS company, o.amount, o.status, o.created_at
       FROM orders o JOIN customers c ON c.id=o.customer_id JOIN companies co ON co.id=o.company_id
       ORDER BY o.created_at DESC`
    ).all();
    if (format !== "json") {
      return ctx.json(501, {
        error: `${format.toUpperCase()} generation isn't implemented in this sandbox (no network access to install a PDF/XLSX library) — the same data is available via format=json.`,
      });
    }
    ctx.json(200, rows);
  });
}

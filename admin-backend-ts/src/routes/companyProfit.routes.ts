import { Router, Request, Response } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * Company Commission & Profit: the business terms each network (company)
 * gives us, set by the Owner -- separate from a package's own price.
 *
 *   Commission %  what the network pays us on each successful order
 *   Discount %    taken off the commission
 *   Profit %      our own margin, added on top
 *
 * For every SUCCESSFUL (completed) order of that network, priced P:
 *   Net commission = P x (Commission% - Discount%)
 *   Profit         = P x Profit%
 *   Total earned   = Net commission + Profit
 * e.g. Hormuud 15% / 10% / 5%: a $1 order earns $0.05 + $0.05 = $0.10.
 *
 * Read and changed by the Owner (and Admins granted commissions.manage) in
 * the dashboard, and in the Agent App by agents the Owner gave the
 * "Commission & profit" service.
 */
export const companyProfitRouter = Router();

type Period = "today" | "month" | "all";
const PERIOD_SQL: Record<Period, string> = {
  today: "o.completed_at >= date_trunc('day', now())",
  month: "o.completed_at >= date_trunc('month', now())",
  all: "true",
};

const money = (n: number) => Math.round(n * 100) / 100;

async function overview(periodParam: unknown) {
  const period: Period = periodParam === "today" || periodParam === "all" ? periodParam : "month";
  const rows = await query<any>(
    `SELECT c.id, c.name, c.color_hex, c.status,
            t.commission_pct, t.discount_pct, t.profit_pct, t.updated_at,
            COALESCE(s.orders, 0)::int AS orders, COALESCE(s.sales, 0)::float AS sales
       FROM companies c
       LEFT JOIN company_profit_terms t ON t.company_id = c.id
       LEFT JOIN (
         SELECT o.company_id, count(*) AS orders, sum(o.amount) AS sales
           FROM orders o
          WHERE o.status = 'completed' AND ${PERIOD_SQL[period]}
          GROUP BY o.company_id
       ) s ON s.company_id = c.id
      ORDER BY (t.company_id IS NULL), c.name`
  );
  const companies = rows.map((r) => {
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const commission = num(r.commission_pct), discount = num(r.discount_pct), profit = num(r.profit_pct);
    const netPct = commission === null ? null : commission - (discount ?? 0);
    const sales = Number(r.sales);
    const netCommission = netPct === null ? 0 : money((sales * netPct) / 100);
    const profitAmount = profit === null ? 0 : money((sales * profit) / 100);
    return {
      companyId: r.id,
      name: r.name,
      colorHex: r.color_hex ?? null,
      status: r.status,
      configured: commission !== null || discount !== null || profit !== null,
      commissionPct: commission,
      discountPct: discount,
      profitPct: profit,
      netCommissionPct: netPct,
      orders: r.orders,
      sales: money(sales),
      netCommission,
      profit: profitAmount,
      total: money(netCommission + profitAmount),
      updatedAt: r.updated_at ?? null,
    };
  });
  const sum = (k: "orders" | "sales" | "netCommission" | "profit" | "total") => money(companies.reduce((a, c) => a + Number(c[k]), 0));
  return {
    period,
    companies,
    totals: { orders: sum("orders"), sales: sum("sales"), netCommission: sum("netCommission"), profit: sum("profit"), total: sum("total") },
  };
}

/** "" / null = not set; otherwise 0-100 with at most 2 decimals. */
function pct(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : Number(String(v).replace(",", ".").trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

async function save(req: Request, res: Response) {
  const companyId = req.params.companyId;
  const company = await query(`SELECT id FROM companies WHERE id=$1`, [companyId]);
  if (!company.length) return sendJson(res, 404, { error: "Network not found", code: "company_not_found" });

  const c = pct(req.body?.commissionPct), d = pct(req.body?.discountPct), p = pct(req.body?.profitPct);
  if (!c.ok || !d.ok || !p.ok) return sendJson(res, 400, { error: "Each percentage must be a number from 0 to 100, or left empty.", code: "invalid_percent" });
  if (d.value !== null && d.value > (c.value ?? 0)) {
    return sendJson(res, 400, { error: "Discount can't be more than the commission.", code: "discount_exceeds_commission" });
  }
  if (c.value === null && d.value === null && p.value === null) {
    await query(`DELETE FROM company_profit_terms WHERE company_id=$1`, [companyId]);
  } else {
    await query(
      `INSERT INTO company_profit_terms (company_id, commission_pct, discount_pct, profit_pct, updated_at, updated_by_id, updated_by_role)
       VALUES ($1,$2,$3,$4,now(),$5,$6)
       ON CONFLICT (company_id) DO UPDATE
         SET commission_pct=$2, discount_pct=$3, profit_pct=$4, updated_at=now(), updated_by_id=$5, updated_by_role=$6`,
      [companyId, c.value, d.value, p.value, String(req.auth!.sub), req.auth!.role]
    );
  }
  const data = await overview(req.query.period);
  sendJson(res, 200, data.companies.find((x) => x.companyId === companyId));
}

// Dashboard (Owner, or an Admin with commissions.manage).
companyProfitRouter.get("/admin/company-profit", requirePermission("commissions.manage"), async (req, res) => {
  sendJson(res, 200, await overview(req.query.period));
});
companyProfitRouter.put("/admin/company-profit/:companyId", requirePermission("commissions.manage"), save);

// Agent App (agents the Owner gave the "profit" service; agentServiceGate checks it).
companyProfitRouter.get("/agent/company-profit", requireAuth("agent"), async (req, res) => {
  sendJson(res, 200, await overview(req.query.period));
});
companyProfitRouter.put("/agent/company-profit/:companyId", requireAuth("agent"), save);

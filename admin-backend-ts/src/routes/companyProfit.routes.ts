import { Router, Request, Response } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * Company Commission & Profit: the commission each network (company) pays
 * us, set in the Agent App -- separate from a package's own price and from
 * the older commission_rules ledger (utils/commissions.ts), which this does
 * not touch. It only reads orders; it never writes to orders or payments.
 *
 *   Commission %  what the network pays us (Hormuud 15, Somnet 15, ...)
 *   Discount %    taken off the commission
 *   Profit %      what remains: Commission % - Discount %
 *
 * The base is what the agents actually SENT to the network for its
 * successful orders (completed and not reversed -- pending, failed,
 * cancelled and reversed orders never count): the amount dialed per send
 * x the number of sends (provider_amount x send_count, the order's own
 * amount when it has no provider amount). Not what customers paid, and
 * not total system sales. With that sent amount A:
 *   Commission = A x Commission%   Discount = A x Discount%
 *   Profit     = Commission - Discount
 * e.g. Hormuud 15% / 10%: $1 sent -> $0.15 commission, $0.10 discount,
 * $0.05 profit. ?scope=me counts only the signed-in agent's orders;
 * all (the default) every agent's.
 */
export const companyProfitRouter = Router();

// Periods by completion time (the server runs on Mogadishu time). Only
// these fixed fragments ever reach the SQL, never the request's text.
const PERIOD_SQL = {
  today: "o.completed_at >= date_trunc('day', now())",
  yesterday: "o.completed_at >= date_trunc('day', now()) - interval '1 day' AND o.completed_at < date_trunc('day', now())",
  month: "o.completed_at >= date_trunc('month', now())",
  last_month: "o.completed_at >= date_trunc('month', now()) - interval '1 month' AND o.completed_at < date_trunc('month', now())",
  "3months": "o.completed_at >= now() - interval '3 months'",
  "6months": "o.completed_at >= now() - interval '6 months'",
  year: "o.completed_at >= now() - interval '1 year'",
  all: "true",
} as const;
type Period = keyof typeof PERIOD_SQL;

const money = (n: number) => Math.round(n * 100) / 100;
const pct2 = (n: number) => Math.round(n * 100) / 100;

/** What was sent to the network for one order: amount per send x sends. */
export const SENT_AMOUNT_SQL = `COALESCE(o.provider_amount, o.amount) * COALESCE(o.send_count, 1)`;

async function overview(periodParam: unknown, scopeParam: unknown, agentId: string) {
  const period: Period = typeof periodParam === "string" && periodParam in PERIOD_SQL ? (periodParam as Period) : "month";
  const scope = scopeParam === "me" ? "me" : "all";
  // Always mentions $1 so the parameter stays typed.
  const who = scope === "me" ? "o.agent_id = $1" : "(o.agent_id = $1 OR true)";
  const rows = await query<any>(
    `SELECT c.id, c.name, c.color_hex, c.status,
            t.commission_pct, t.discount_pct, t.updated_at,
            COALESCE(s.orders, 0)::int AS orders, COALESCE(s.sales, 0)::float AS sales,
            COALESCE(s.sent, 0)::float AS sent
       FROM companies c
       LEFT JOIN company_profit_terms t ON t.company_id = c.id
       LEFT JOIN (
         SELECT o.company_id, count(*) AS orders, sum(o.amount) AS sales, sum(${SENT_AMOUNT_SQL}) AS sent
           FROM orders o
          WHERE o.status = 'completed' AND o.reversed_at IS NULL AND ${PERIOD_SQL[period]} AND ${who}
          GROUP BY o.company_id
       ) s ON s.company_id = c.id
      ORDER BY (t.company_id IS NULL), c.name`,
    [agentId]
  );
  const companies = rows.map((r) => {
    const commissionPct = r.commission_pct === null || r.commission_pct === undefined ? null : Number(r.commission_pct);
    const discountPct = commissionPct === null ? null : Number(r.discount_pct ?? 0);
    const profitPct = commissionPct === null ? null : pct2(commissionPct - (discountPct ?? 0));
    const sales = Number(r.sales);
    const sent = Number(r.sent);
    const commission = commissionPct === null ? 0 : money((sent * commissionPct) / 100);
    const discount = discountPct === null ? 0 : money((sent * discountPct) / 100);
    return {
      companyId: r.id,
      name: r.name,
      colorHex: r.color_hex ?? null,
      status: r.status,
      configured: commissionPct !== null,
      commissionPct,
      discountPct,
      profitPct,
      orders: r.orders,
      sales: money(sales),
      sentAmount: money(sent),
      commission,
      discount,
      profit: money(commission - discount),
      updatedAt: r.updated_at ?? null,
    };
  });
  const sum = (k: "orders" | "sales" | "sentAmount" | "commission" | "discount" | "profit") => money(companies.reduce((a, c) => a + Number(c[k]), 0));
  return {
    period,
    scope,
    companies,
    totals: { orders: sum("orders"), sales: sum("sales"), sentAmount: sum("sentAmount"), commission: sum("commission"), discount: sum("discount"), profit: sum("profit") },
  };
}

/** "" / null = not given; otherwise 0-100 with at most 2 decimals. */
function pct(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : Number(String(v).replace(",", ".").trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/**
 * Body: commissionPct plus discountPct and/or profitPct (the other one is
 * worked out: discount + profit = commission). An empty commission clears
 * the network's terms.
 */
async function save(req: Request, res: Response) {
  const companyId = req.params.companyId;
  const company = await query(`SELECT id FROM companies WHERE id=$1`, [companyId]);
  if (!company.length) return sendJson(res, 404, { error: "Network not found", code: "company_not_found" });

  const c = pct(req.body?.commissionPct), d = pct(req.body?.discountPct), p = pct(req.body?.profitPct);
  if (!c.ok || !d.ok || !p.ok) return sendJson(res, 400, { error: "Each percentage must be a number from 0 to 100.", code: "invalid_percent" });

  if (c.value === null) {
    if (d.value !== null || p.value !== null) return sendJson(res, 400, { error: "Set the company commission first.", code: "commission_required" });
    await query(`DELETE FROM company_profit_terms WHERE company_id=$1`, [companyId]);
  } else {
    let discount = d.value;
    if (discount === null) discount = p.value === null ? 0 : pct2(c.value - p.value);
    if (discount < 0 || discount > c.value) {
      return sendJson(res, 400, { error: "Discount and profit together must equal the commission.", code: "discount_exceeds_commission" });
    }
    if (p.value !== null && Math.abs(c.value - discount - p.value) > 0.001) {
      return sendJson(res, 400, { error: "Profit must be Commission minus Discount.", code: "profit_mismatch" });
    }
    await query(
      `INSERT INTO company_profit_terms (company_id, commission_pct, discount_pct, profit_pct, updated_at, updated_by_id, updated_by_role)
       VALUES ($1,$2,$3,$4,now(),$5,$6)
       ON CONFLICT (company_id) DO UPDATE
         SET commission_pct=$2, discount_pct=$3, profit_pct=$4, updated_at=now(), updated_by_id=$5, updated_by_role=$6`,
      [companyId, c.value, discount, pct2(c.value - discount), String(req.auth!.sub), req.auth!.role]
    );
  }
  const data = await overview(req.query.period, req.query.scope, String(req.auth!.sub));
  sendJson(res, 200, data.companies.find((x) => x.companyId === companyId));
}

// Agent App (agents the Owner gave the "profit" service; agentServiceGate checks it).
companyProfitRouter.get("/agent/company-profit", requireAuth("agent"), async (req, res) => {
  sendJson(res, 200, await overview(req.query.period, req.query.scope, String(req.auth!.sub)));
});
companyProfitRouter.put("/agent/company-profit/:companyId", requireAuth("agent"), save);

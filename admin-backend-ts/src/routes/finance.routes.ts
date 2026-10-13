import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { SIM_BALANCE_LIST_SQL } from "./simBalances.routes.js";

export const financeRouter = Router();

// A reversed order already had its money given back — commission, referral
// bonus, and redeemed points are all clawed back on reversal (see
// reverseOrderInternal in orders.routes.ts) — so it must never count as
// money received or money spent here, the same way it shouldn't but
// currently doesn't get excluded from /admin/reports or
// /admin/dashboard/stats.
const REAL_ORDER_FILTER = `o.status='completed' AND o.reversed_at IS NULL`;

function parseRangeParam(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function rangeTotals(fromIso: string | null, toIso: string | null) {
  const orderRow = await queryOne<{ money_received: string; data_cost: string }>(
    `SELECT
       COALESCE(SUM(o.amount) FILTER (WHERE ${REAL_ORDER_FILTER}), 0) AS money_received,
       COALESCE(SUM(o.provider_amount) FILTER (WHERE ${REAL_ORDER_FILTER}), 0) AS data_cost
     FROM orders o
     WHERE ($1::timestamptz IS NULL OR o.created_at >= $1)
       AND ($2::timestamptz IS NULL OR o.created_at <= $2)`,
    [fromIso, toIso]
  );
  const expenseRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM finance_expenses
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at <= $2)`,
    [fromIso, toIso]
  );
  const moneyReceived = Number(orderRow?.money_received ?? 0);
  const dataCost = Number(orderRow?.data_cost ?? 0);
  const otherMoneyOut = Number(expenseRow?.total ?? 0);
  const totalMoneyOut = dataCost + otherMoneyOut;
  return {
    moneyReceived,
    dataCost,
    otherMoneyOut,
    totalMoneyOut,
    remainingBalance: moneyReceived - totalMoneyOut,
  };
}

// "Today"/"this month" bucket by the session's TimeZone (set to
// Africa/Mogadishu in db/pool.ts), so these match what a Super Admin in
// Somalia actually means by "today" instead of splitting the day at UTC
// midnight.
async function periodTotals() {
  const orderRow = await queryOne<{
    money_received_today: string;
    data_cost_today: string;
    money_received_month: string;
    data_cost_month: string;
  }>(
    `SELECT
       COALESCE(SUM(o.amount) FILTER (WHERE ${REAL_ORDER_FILTER} AND o.created_at >= date_trunc('day', now())), 0) AS money_received_today,
       COALESCE(SUM(o.provider_amount) FILTER (WHERE ${REAL_ORDER_FILTER} AND o.created_at >= date_trunc('day', now())), 0) AS data_cost_today,
       COALESCE(SUM(o.amount) FILTER (WHERE ${REAL_ORDER_FILTER} AND o.created_at >= date_trunc('month', now())), 0) AS money_received_month,
       COALESCE(SUM(o.provider_amount) FILTER (WHERE ${REAL_ORDER_FILTER} AND o.created_at >= date_trunc('month', now())), 0) AS data_cost_month
     FROM orders o`
  );
  const expenseRow = await queryOne<{ other_today: string; other_month: string }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', now())), 0) AS other_today,
       COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS other_month
     FROM finance_expenses`
  );

  const build = (moneyReceived: number, dataCost: number, otherMoneyOut: number) => {
    const totalMoneyOut = dataCost + otherMoneyOut;
    return { moneyReceived, dataCost, otherMoneyOut, totalMoneyOut, remainingBalance: moneyReceived - totalMoneyOut };
  };

  return {
    today: build(
      Number(orderRow?.money_received_today ?? 0),
      Number(orderRow?.data_cost_today ?? 0),
      Number(expenseRow?.other_today ?? 0)
    ),
    month: build(
      Number(orderRow?.money_received_month ?? 0),
      Number(orderRow?.data_cost_month ?? 0),
      Number(expenseRow?.other_month ?? 0)
    ),
  };
}

// The single source of truth for "real money currently available": the sum
// of every SIM's carrier-reported balance. Queries the EXACT SAME
// SIM_BALANCE_LIST_SQL the Balance Dashboard's /admin/sim-balances and
// /admin/sim-balances/summary read from (imported, not reimplemented), so
// this can never drift into a second hand-maintained "universe" of what
// counts as a SIM — every present slot on every registered device, whether
// or not it happens to have a sim_balances row yet. This is always the
// current figure — it isn't meaningful to ask what the wallet balance "was"
// over a date range, so it ignores from/to. Shown to the Super Admin as
// both "Total Money Available" and "Current Wallet Balance" — same real
// number, since that IS the money the system currently has on hand.
//
// A slot's balance is NULL when it's never had a real SMS-or-manual update
// confirmed (migration 068, and any slot with no sim_balances row at all) —
// excluded from the sum without inventing a $0 contribution, but the raw
// total alone can't tell a Super Admin "this total is missing 2 of our 4
// SIMs" from "this total is genuinely everything". knownSimCount/
// totalSimCount make that coverage explicit instead of silently
// understating the real total.
async function walletBalance(): Promise<{ total: number; knownSimCount: number; totalSimCount: number }> {
  const rows = await query<{ balance: string | null }>(`SELECT balance FROM (${SIM_BALANCE_LIST_SQL}) rows`);
  let total = 0;
  let knownSimCount = 0;
  for (const r of rows) {
    if (r.balance != null) {
      total += Number(r.balance);
      knownSimCount++;
    }
  }
  return { total: Number(total.toFixed(3)), knownSimCount, totalSimCount: rows.length };
}

// GET /admin/finance/overview?from=&to= — the full Financial Overview:
// Money Received -> Data Cost -> Other Money Out -> Remaining Balance, plus
// the real wallet balance and today/this-month breakdowns. from/to are
// optional ISO date bounds on order/expense created_at; all-time when
// omitted. Every number comes straight from orders/finance_expenses/
// sim_balances — nothing here is estimated or hardcoded.
financeRouter.get("/admin/finance/overview", requireStaff(), async (req, res) => {
  const from = parseRangeParam(req.query.from);
  const to = parseRangeParam(req.query.to);

  const [totals, periods, wallet] = await Promise.all([rangeTotals(from, to), periodTotals(), walletBalance()]);

  sendJson(res, 200, {
    range: { from, to },
    totalMoneyAvailable: wallet.total,
    walletKnownSimCount: wallet.knownSimCount,
    walletTotalSimCount: wallet.totalSimCount,
    moneyReceived: totals.moneyReceived,
    totalDataCost: totals.dataCost,
    otherMoneyOut: totals.otherMoneyOut,
    totalMoneyOut: totals.totalMoneyOut,
    currentWalletBalance: wallet.total,
    remainingBalance: totals.remainingBalance,
    // No cost category exists beyond data cost + other expenses, so profit
    // is exactly what's left after money out — same formula as
    // remainingBalance, surfaced under its own name since that's how the
    // Super Admin dashboard should label it.
    profit: totals.remainingBalance,
    today: periods.today,
    month: periods.month,
  });
});

// ---------------- Expenses ("Other Money Out") ----------------

financeRouter.get("/admin/finance/expenses", requireStaff(), async (req, res) => {
  const { from, to, limit, offset } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `
    SELECT fe.*, au.email AS created_by_email
    FROM finance_expenses fe
    LEFT JOIN admin_users au ON au.id = fe.created_by
    WHERE 1=1`;
  if (from) { args.push(from); sql += ` AND fe.created_at >= $${args.length}`; }
  if (to) { args.push(to); sql += ` AND fe.created_at <= $${args.length}`; }

  const cappedLimit = Math.min(Number(limit) || 200, 1000);
  args.push(cappedLimit);
  sql += ` ORDER BY fe.created_at DESC LIMIT $${args.length}`;
  if (offset) { args.push(Number(offset)); sql += ` OFFSET $${args.length}`; }

  sendJson(res, 200, await query(sql, args));
});

financeRouter.post("/admin/finance/expenses", requirePermission("finance.manage"), async (req, res) => {
  const { amount, category, note } = req.body ?? {};
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return sendJson(res, 400, { error: "amount must be a positive number" });
  }
  if (!category || typeof category !== "string") {
    return sendJson(res, 400, { error: "category is required" });
  }

  const id = randomUUID();
  await query(
    `INSERT INTO finance_expenses (id, amount, category, note, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [id, numAmount, category, typeof note === "string" && note.trim() ? note.trim() : null, req.auth!.sub]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_finance_expense",
    entityType: "finance_expense",
    entityId: id,
    oldValue: null,
    newValue: { amount: numAmount, category, note },
  });
  sendJson(res, 201, await queryOne(`SELECT * FROM finance_expenses WHERE id=$1`, [id]));
});

financeRouter.delete("/admin/finance/expenses/:id", requirePermission("finance.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM finance_expenses WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Expense not found" });

  await query(`DELETE FROM finance_expenses WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "delete_finance_expense",
    entityType: "finance_expense",
    entityId: req.params.id,
    oldValue: existing,
    newValue: null,
  });
  sendJson(res, 200, { ok: true });
});

// ---------------- Shirkadda Xisaab (per-company accounts) ----------------
// One telecom company's books for a period: what DALAB paid the company
// (provider_amount, falling back to amount for orders without a separate
// provider cost), what customers paid (amount), the discount given off the
// package's list price, commission earned, and profit = sales - company
// money + commission. Money only counts real orders (completed, not
// reversed); the order list itself can show every status.
const ORDER_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];
const COMPANY_MONEY = `COALESCE(o.provider_amount, o.amount)`;
const ORDER_DISCOUNT = `GREATEST(COALESCE(o.list_price, o.amount) - o.amount, 0)`;
const ORDER_COMMISSION = `COALESCE((SELECT SUM(CASE WHEN cr.kind = 'earned' THEN cr.commission_amount ELSE -cr.commission_amount END)
                                    FROM commission_records cr WHERE cr.order_id = o.id), 0)`;
const MONEY_AGGREGATES = `
  COUNT(o.id) FILTER (WHERE ${REAL_ORDER_FILTER}) AS orders,
  COALESCE(SUM(${COMPANY_MONEY}) FILTER (WHERE ${REAL_ORDER_FILTER}), 0) AS company_amount,
  COALESCE(SUM(o.amount) FILTER (WHERE ${REAL_ORDER_FILTER}), 0) AS sale_amount,
  COALESCE(SUM(${ORDER_DISCOUNT}) FILTER (WHERE ${REAL_ORDER_FILTER}), 0) AS discount,
  COALESCE(SUM(${ORDER_COMMISSION}) FILTER (WHERE ${REAL_ORDER_FILTER}), 0) AS commission`;

type MoneyRow = { orders: string; company_amount: string; sale_amount: string; discount: string; commission: string };

function money(row: MoneyRow) {
  const round = (n: number) => Number(n.toFixed(2));
  const companyAmount = round(Number(row.company_amount));
  const saleAmount = round(Number(row.sale_amount));
  const commission = round(Number(row.commission));
  const profit = round(saleAmount - companyAmount + commission);
  return {
    orders: Number(row.orders),
    companyAmount,
    saleAmount,
    discount: round(Number(row.discount)),
    commission,
    profit,
    profitPercent: companyAmount > 0 ? round((profit / companyAmount) * 100) : 0,
  };
}

financeRouter.get("/admin/finance/company-accounts", requirePermission("finance.manage"), async (req, res) => {
  const from = parseRangeParam(req.query.from);
  const to = parseRangeParam(req.query.to);
  const range = `($1::timestamptz IS NULL OR o.created_at >= $1) AND ($2::timestamptz IS NULL OR o.created_at <= $2)`;

  const companyRows = await query<MoneyRow & { id: string; name: string; color_hex: string }>(
    `SELECT co.id, co.name, co.color_hex, ${MONEY_AGGREGATES}
       FROM companies co
       LEFT JOIN orders o ON o.company_id = co.id AND ${range}
      WHERE co.deleted_at IS NULL
      GROUP BY co.id, co.name, co.color_hex, co.sort_order
      ORDER BY co.sort_order, co.name`,
    [from, to]
  );
  const companies = companyRows.map((r) => ({ id: r.id, name: r.name, colorHex: r.color_hex, ...money(r) }));

  const requested = typeof req.query.companyId === "string" ? req.query.companyId : "";
  const company = companies.find((c) => c.id === requested) ?? companies[0] ?? null;
  if (!company) return sendJson(res, 200, { range: { from, to }, companies, company: null, categories: [], orders: [], totalOrders: 0 });

  const categoryRows = await query<MoneyRow & { name: string }>(
    `SELECT COALESCE(sc.name, 'Other') AS name, ${MONEY_AGGREGATES}
       FROM orders o
       JOIN packages p ON p.id = o.package_id
       LEFT JOIN service_categories sc ON sc.company_id = p.company_id AND sc.slug = p.category_id
      WHERE o.company_id = $3 AND ${range}
      GROUP BY COALESCE(sc.name, 'Other')
     HAVING COUNT(o.id) FILTER (WHERE ${REAL_ORDER_FILTER}) > 0
      ORDER BY 3 DESC, 1`,
    [from, to, company.id]
  );

  const status = typeof req.query.status === "string" && ORDER_STATUSES.includes(req.query.status) ? req.query.status : null;
  const search = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim()}%` : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 5000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const orderFilter = `o.company_id = $3 AND ${range}
    AND ($4::text IS NULL OR o.status = $4)
    AND ($5::text IS NULL OR o.id ILIKE $5 OR p.name ILIKE $5 OR o.receiver_phone ILIKE $5 OR o.sender_phone ILIKE $5)`;
  const params = [from, to, company.id, status, search];

  const [orderRows, countRow] = await Promise.all([
    query<any>(
      `SELECT o.id, o.created_at, o.status, o.reversed_at, o.receiver_phone, p.name AS package_name, sc.name AS category,
              ${COMPANY_MONEY} AS company_amount, o.amount AS sale_amount, ${ORDER_DISCOUNT} AS discount, ${ORDER_COMMISSION} AS commission
         FROM orders o
         JOIN packages p ON p.id = o.package_id
         LEFT JOIN service_categories sc ON sc.company_id = p.company_id AND sc.slug = p.category_id
        WHERE ${orderFilter}
        ORDER BY o.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    queryOne<{ total: string }>(
      `SELECT COUNT(*) AS total FROM orders o JOIN packages p ON p.id = o.package_id WHERE ${orderFilter}`,
      params
    ),
  ]);

  const orders = orderRows.map((r) => {
    const companyAmount = Number(r.company_amount);
    const saleAmount = Number(r.sale_amount);
    const commission = Number(r.commission);
    return {
      id: r.id,
      createdAt: r.created_at,
      status: r.reversed_at ? "reversed" : r.status,
      receiverPhone: r.receiver_phone,
      packageName: r.package_name,
      category: r.category ?? "Other",
      companyAmount,
      saleAmount,
      discount: Number(r.discount),
      commission,
      profit: Number((saleAmount - companyAmount + commission).toFixed(2)),
    };
  });

  sendJson(res, 200, {
    range: { from, to },
    companies,
    company,
    categories: categoryRows.map((r) => ({ name: r.name, ...money(r) })),
    orders,
    totalOrders: Number(countRow?.total ?? 0),
  });
});

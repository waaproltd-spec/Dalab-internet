import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";

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
// of every SIM's carrier-reported balance (see sim_balances / the Balance
// Dashboard). This is always the current figure — it isn't meaningful to
// ask what the wallet balance "was" over a date range, so it ignores
// from/to. Shown to the Super Admin as both "Total Money Available" and
// "Current Wallet Balance" — same real number, since that IS the money the
// system currently has on hand.
async function walletBalance(): Promise<number> {
  const row = await queryOne<{ total: string }>(`SELECT COALESCE(SUM(balance), 0) AS total FROM sim_balances`);
  return Number(row?.total ?? 0);
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
    totalMoneyAvailable: wallet,
    moneyReceived: totals.moneyReceived,
    totalDataCost: totals.dataCost,
    otherMoneyOut: totals.otherMoneyOut,
    totalMoneyOut: totals.totalMoneyOut,
    currentWalletBalance: wallet,
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

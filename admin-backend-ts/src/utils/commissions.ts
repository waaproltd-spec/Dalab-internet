import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";

/**
 * Commission = the money earned by the company/Super Admin from a completed
 * order — configured via commission_rules (percentage or fixed, scoped
 * globally / per company / per package) and calculated automatically the
 * instant an order completes. Mirrors creditMacaashIfNeeded's idempotent
 * insert-catch-23505 pattern exactly (see orders.routes.ts), so a retried or
 * concurrent completion signal can never double-credit a commission.
 */

type CommissionRule = {
  id: string;
  rule_type: "percentage" | "fixed";
  value: string | number;
};

/** Most specific enabled rule wins: a package-scoped rule beats a
 * company-scoped rule, which beats a global rule. If more than one enabled
 * rule exists at the same scope (e.g. two enabled global rules), the most
 * recently updated one wins — callers are expected to disable an old rule
 * before enabling its replacement, but this keeps resolution well-defined
 * either way rather than erroring. */
async function resolveCommissionRule(companyId: string, packageId: string): Promise<CommissionRule | null> {
  return queryOne<CommissionRule>(
    `SELECT id, rule_type, value FROM commission_rules
     WHERE enabled = true AND (
       (scope_type = 'package' AND package_id = $2) OR
       (scope_type = 'company' AND company_id = $1) OR
       (scope_type = 'global')
     )
     ORDER BY CASE scope_type WHEN 'package' THEN 0 WHEN 'company' THEN 1 ELSE 2 END, updated_at DESC
     LIMIT 1`,
    [companyId, packageId]
  );
}

function calculateCommissionAmount(rule: CommissionRule, orderAmount: number): number {
  const value = Number(rule.value);
  const raw = rule.rule_type === "percentage" ? orderAmount * (value / 100) : value;
  return Math.round(raw * 100) / 100;
}

/** Call this from every order-completion code path (completeOrderById,
 * the admin status PUT, and the dial-attempt success report) right where
 * creditMacaashIfNeeded is already called — a no-op if no enabled rule
 * matches this order's company/package. */
export async function creditCommissionIfNeeded(order: {
  id: string;
  company_id: string;
  package_id: string;
  amount: string | number;
}): Promise<void> {
  const rule = await resolveCommissionRule(order.company_id, order.package_id);
  if (!rule) return;
  const orderAmount = Number(order.amount);
  const commissionAmount = calculateCommissionAmount(rule, orderAmount);
  try {
    await query(
      `INSERT INTO commission_records
         (id, order_id, rule_id, company_id, package_id, order_amount, rule_type, rule_value, commission_amount, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'earned')`,
      [randomUUID(), order.id, rule.id, order.company_id, order.package_id, orderAmount, rule.rule_type, rule.value, commissionAmount]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_commission_records_order_earned") throw err;
    // already credited by a concurrent/retried completion signal — no-op
  }
}

/** Call this from reverseOrderInternal, alongside the Macaash clawback —
 * a no-op if this order never earned a commission in the first place. */
export async function reverseCommissionIfNeeded(orderId: string): Promise<void> {
  const earned = await queryOne<{
    rule_id: string | null;
    company_id: string | null;
    package_id: string | null;
    order_amount: string;
    rule_type: "percentage" | "fixed";
    rule_value: string;
    commission_amount: string;
  }>(
    `SELECT rule_id, company_id, package_id, order_amount, rule_type, rule_value, commission_amount
     FROM commission_records WHERE order_id=$1 AND kind='earned'`,
    [orderId]
  );
  if (!earned) return;
  try {
    await query(
      `INSERT INTO commission_records
         (id, order_id, rule_id, company_id, package_id, order_amount, rule_type, rule_value, commission_amount, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reversed')`,
      [
        randomUUID(),
        orderId,
        earned.rule_id,
        earned.company_id,
        earned.package_id,
        earned.order_amount,
        earned.rule_type,
        earned.rule_value,
        -Number(earned.commission_amount),
      ]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_commission_records_order_reversed") throw err;
    // already reversed by a concurrent call — no-op
  }
}

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";

export const commissionsRouter = Router();

const SCOPE_TYPES = ["global", "company", "package"];
const RULE_TYPES = ["percentage", "fixed"];

const RULE_SELECT = `
  SELECT r.*, co.name AS company_name, p.name AS package_name
  FROM commission_rules r
  LEFT JOIN companies co ON co.id = r.company_id
  LEFT JOIN packages p ON p.id = r.package_id
`;

async function loadRule(id: string) {
  return queryOne(`${RULE_SELECT} WHERE r.id=$1`, [id]);
}

/** Validates the scope/company/package combination and, for a package-scoped
 * rule, derives companyId from the package itself rather than trusting the
 * client to have sent a matching one — the same "don't let two fields
 * disagree" precaution used for payment_wallets.company_id elsewhere. */
async function validateScope(scopeType: string, companyId: unknown, packageId: unknown): Promise<{ error?: string; companyId: string | null; packageId: string | null }> {
  if (!SCOPE_TYPES.includes(scopeType)) return { error: `scopeType must be one of ${SCOPE_TYPES.join(", ")}`, companyId: null, packageId: null };

  if (scopeType === "global") return { companyId: null, packageId: null };

  if (scopeType === "company") {
    if (!companyId || typeof companyId !== "string") return { error: "companyId is required for a company-scoped rule", companyId: null, packageId: null };
    const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [companyId]);
    if (!company) return { error: "Company not found", companyId: null, packageId: null };
    return { companyId, packageId: null };
  }

  // scopeType === "package"
  if (!packageId || typeof packageId !== "string") return { error: "packageId is required for a package-scoped rule", companyId: null, packageId: null };
  const pkg = await queryOne<{ id: string; company_id: string }>(`SELECT id, company_id FROM packages WHERE id=$1`, [packageId]);
  if (!pkg) return { error: "Package not found", companyId: null, packageId: null };
  return { companyId: pkg.company_id, packageId: pkg.id };
}

function validateRuleTypeAndValue(ruleType: unknown, value: unknown): { error?: string } {
  if (!RULE_TYPES.includes(ruleType as string)) return { error: `ruleType must be one of ${RULE_TYPES.join(", ")}` };
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return { error: "value must be a non-negative number" };
  if (ruleType === "percentage" && num > 100) return { error: "A percentage rule's value cannot exceed 100" };
  return {};
}

// ---------------- Commission Rules (Super-Admin-delegable via commissions.manage) ----------------

commissionsRouter.get("/admin/commission-rules", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`${RULE_SELECT} ORDER BY r.created_at DESC`));
});

commissionsRouter.post("/admin/commission-rules", requirePermission("commissions.manage"), async (req, res) => {
  const { name, scopeType, companyId, packageId, ruleType, value } = req.body ?? {};
  if (!name || typeof name !== "string") return sendJson(res, 400, { error: "name is required" });

  const scope = await validateScope(scopeType, companyId, packageId);
  if (scope.error) return sendJson(res, 400, { error: scope.error });

  const ruleCheck = validateRuleTypeAndValue(ruleType, value);
  if (ruleCheck.error) return sendJson(res, 400, { error: ruleCheck.error });

  const id = randomUUID();
  await query(
    `INSERT INTO commission_rules (id, name, scope_type, company_id, package_id, rule_type, value)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name, scopeType, scope.companyId, scope.packageId, ruleType, value]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_commission_rule",
    entityType: "commission_rule",
    entityId: id,
    oldValue: null,
    newValue: { name, scopeType, companyId: scope.companyId, packageId: scope.packageId, ruleType, value },
  });
  sendJson(res, 201, await loadRule(id));
});

commissionsRouter.put("/admin/commission-rules/:id", requirePermission("commissions.manage"), async (req, res) => {
  const existing = await loadRule(req.params.id);
  if (!existing) return sendJson(res, 404, { error: "Commission rule not found" });

  const { name, scopeType, companyId, packageId, ruleType, value } = req.body ?? {};
  if (!name || typeof name !== "string") return sendJson(res, 400, { error: "name is required" });

  const scope = await validateScope(scopeType, companyId, packageId);
  if (scope.error) return sendJson(res, 400, { error: scope.error });

  const ruleCheck = validateRuleTypeAndValue(ruleType, value);
  if (ruleCheck.error) return sendJson(res, 400, { error: ruleCheck.error });

  await query(
    `UPDATE commission_rules
     SET name=$1, scope_type=$2, company_id=$3, package_id=$4, rule_type=$5, value=$6, updated_at=now()
     WHERE id=$7`,
    [name, scopeType, scope.companyId, scope.packageId, ruleType, value, req.params.id]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_commission_rule",
    entityType: "commission_rule",
    entityId: req.params.id,
    oldValue: existing,
    newValue: { name, scopeType, companyId: scope.companyId, packageId: scope.packageId, ruleType, value },
  });
  sendJson(res, 200, await loadRule(req.params.id));
});

commissionsRouter.put("/admin/commission-rules/:id/status", requirePermission("commissions.manage"), async (req, res) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean" });

  const existing = await loadRule(req.params.id);
  if (!existing) return sendJson(res, 404, { error: "Commission rule not found" });

  await query(`UPDATE commission_rules SET enabled=$1, updated_at=now() WHERE id=$2`, [enabled, req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_commission_rule_status",
    entityType: "commission_rule",
    entityId: req.params.id,
    oldValue: { enabled: (existing as any).enabled },
    newValue: { enabled },
  });
  sendJson(res, 200, await loadRule(req.params.id));
});

// ---------------- Commission Records (read-only, staff-visible) ----------------

commissionsRouter.get("/admin/commissions", requireStaff(), async (req, res) => {
  const { companyId, packageId, kind, dateFrom, dateTo, search, limit, offset } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `
    SELECT cr.*, co.name AS company_name, p.name AS package_name
    FROM commission_records cr
    LEFT JOIN companies co ON co.id = cr.company_id
    LEFT JOIN packages p ON p.id = cr.package_id
    WHERE 1=1`;
  if (companyId) { args.push(companyId); sql += ` AND cr.company_id=$${args.length}`; }
  if (packageId) { args.push(packageId); sql += ` AND cr.package_id=$${args.length}`; }
  if (kind) { args.push(kind); sql += ` AND cr.kind=$${args.length}`; }
  if (dateFrom) { args.push(dateFrom); sql += ` AND cr.created_at >= $${args.length}`; }
  if (dateTo) { args.push(dateTo); sql += ` AND cr.created_at <= $${args.length}`; }
  if (search) { args.push(`%${search}%`); sql += ` AND cr.order_id ILIKE $${args.length}`; }

  const cappedLimit = Math.min(Number(limit) || 200, 1000);
  args.push(cappedLimit);
  sql += ` ORDER BY cr.created_at DESC LIMIT $${args.length}`;
  if (offset) { args.push(Number(offset)); sql += ` OFFSET $${args.length}`; }
  sendJson(res, 200, await query(sql, args));
});

// Total earned (net of any reversals — reversed rows are stored as negative
// amounts, so a plain SUM already nets them out), today's and this month's
// totals, and a per-company / per-package breakdown so the dashboard can
// show which provider or service generates the highest commission.
commissionsRouter.get("/admin/commissions/summary", requireStaff(), async (_req, res) => {
  const totals = await queryOne<{ total: string; today: string; month: string }>(
    `SELECT
       COALESCE(SUM(commission_amount), 0) AS total,
       COALESCE(SUM(commission_amount) FILTER (WHERE created_at >= date_trunc('day', now())), 0) AS today,
       COALESCE(SUM(commission_amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS month
     FROM commission_records`
  );
  const byCompany = await query(
    `SELECT cr.company_id, co.name AS company_name,
            COALESCE(SUM(cr.commission_amount), 0) AS total,
            COUNT(*) FILTER (WHERE cr.kind = 'earned') AS order_count
     FROM commission_records cr
     LEFT JOIN companies co ON co.id = cr.company_id
     GROUP BY cr.company_id, co.name
     ORDER BY total DESC`
  );
  const byPackage = await query(
    `SELECT cr.package_id, p.name AS package_name, cr.company_id, co.name AS company_name,
            COALESCE(SUM(cr.commission_amount), 0) AS total,
            COUNT(*) FILTER (WHERE cr.kind = 'earned') AS order_count
     FROM commission_records cr
     LEFT JOIN packages p ON p.id = cr.package_id
     LEFT JOIN companies co ON co.id = cr.company_id
     GROUP BY cr.package_id, p.name, cr.company_id, co.name
     ORDER BY total DESC`
  );
  sendJson(res, 200, {
    totalCommission: Number(totals?.total ?? 0),
    todayCommission: Number(totals?.today ?? 0),
    monthCommission: Number(totals?.month ?? 0),
    byCompany,
    byPackage,
  });
});

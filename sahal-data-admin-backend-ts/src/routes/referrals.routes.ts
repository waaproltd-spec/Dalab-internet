import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { ensureReferralCode } from "../utils/referrals.js";

export const referralsRouter = Router();

// Customer-facing: everything a customer needs to see/share their own
// referral program status. referralLink is built here (not stored) so the
// app-facing domain can change without a migration.
referralsRouter.get("/customers/me/referral", requireAuth("customer"), async (req, res) => {
  const customerId = req.auth!.sub;
  const referralCode = await ensureReferralCode(customerId);

  const referred = await query<{ id: string; phone: string; name: string | null; created_at: string; has_completed_purchase: boolean }>(
    `SELECT c.id, c.phone, c.name, c.created_at,
            EXISTS(SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'completed') AS has_completed_purchase
     FROM customers c
     WHERE c.referred_by_customer_id = $1
     ORDER BY c.created_at DESC`,
    [customerId]
  );

  const pointsFromReferrals = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(points), 0) AS total FROM macaash_transactions
     WHERE customer_id = $1 AND kind IN ('referral_bonus', 'referral_bonus_reversal')`,
    [customerId]
  );
  const pointsUsedForDiscounts = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(-points), 0) AS total FROM macaash_transactions
     WHERE customer_id = $1 AND kind = 'redeemed'`,
    [customerId]
  );
  const customer = await queryOne<{ macaash_points: number }>(`SELECT macaash_points FROM customers WHERE id=$1`, [customerId]);
  const rule = await queryOne<{ points_per_dollar_discount: number }>(`SELECT points_per_dollar_discount FROM referral_reward_rules LIMIT 1`);

  sendJson(res, 200, {
    referralCode,
    referralLink: `${process.env.CUSTOMER_APP_URL ?? "https://app.sahaldata.so"}/join?ref=${referralCode}`,
    pointsBalance: customer?.macaash_points ?? 0,
    pointsEarnedFromReferrals: Math.max(0, Number(pointsFromReferrals?.total ?? 0)),
    pointsUsedForDiscounts: Math.max(0, Number(pointsUsedForDiscounts?.total ?? 0)),
    pointsPerDollarDiscount: rule?.points_per_dollar_discount ?? 100,
    referrals: referred.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      joinedAt: r.created_at,
      hasCompletedPurchase: r.has_completed_purchase,
    })),
  });
});

// Staff-facing: view the reward rule and referral activity for oversight.
referralsRouter.get("/admin/referral-rules", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await queryOne(`SELECT * FROM referral_reward_rules LIMIT 1`));
});

referralsRouter.put("/admin/referral-rules", requirePermission("referrals.manage"), async (req, res) => {
  const { pointsPerReferralPurchase, pointsPerDollarDiscount, enabled } = req.body ?? {};
  if (pointsPerReferralPurchase !== undefined && (typeof pointsPerReferralPurchase !== "number" || pointsPerReferralPurchase < 0)) {
    return sendJson(res, 400, { error: "pointsPerReferralPurchase must be a non-negative number" });
  }
  if (pointsPerDollarDiscount !== undefined && (typeof pointsPerDollarDiscount !== "number" || pointsPerDollarDiscount <= 0)) {
    return sendJson(res, 400, { error: "pointsPerDollarDiscount must be a positive number" });
  }

  const existing = await queryOne<any>(`SELECT * FROM referral_reward_rules LIMIT 1`);
  await query(
    `UPDATE referral_reward_rules
     SET points_per_referral_purchase = COALESCE($1, points_per_referral_purchase),
         points_per_dollar_discount = COALESCE($2, points_per_dollar_discount),
         enabled = COALESCE($3, enabled),
         updated_at = now(),
         updated_by = $4
     WHERE id = $5`,
    [pointsPerReferralPurchase ?? null, pointsPerDollarDiscount ?? null, enabled ?? null, req.auth!.sub, existing.id]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_referral_rules",
    entityType: "referral_reward_rules",
    entityId: existing.id,
    oldValue: existing,
    newValue: { pointsPerReferralPurchase, pointsPerDollarDiscount, enabled },
  });
  sendJson(res, 200, await queryOne(`SELECT * FROM referral_reward_rules LIMIT 1`));
});

// Read-only oversight list: every customer who has referred at least one
// other customer, with counts of converted (completed-purchase) referrals.
referralsRouter.get("/admin/referrals", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT
         referrer.id AS referrer_id, referrer.name AS referrer_name, referrer.phone AS referrer_phone,
         COUNT(referred.id) AS total_referrals,
         COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM orders o WHERE o.customer_id = referred.id AND o.status = 'completed')) AS converted_referrals,
         (SELECT COALESCE(SUM(mt.points), 0) FROM macaash_transactions mt
          WHERE mt.customer_id = referrer.id AND mt.kind IN ('referral_bonus', 'referral_bonus_reversal')) AS total_points_paid
       FROM customers referrer
       JOIN customers referred ON referred.referred_by_customer_id = referrer.id
       GROUP BY referrer.id, referrer.name, referrer.phone
       ORDER BY total_referrals DESC`
    )
  );
});

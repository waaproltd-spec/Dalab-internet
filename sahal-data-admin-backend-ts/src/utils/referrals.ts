import { randomBytes, randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";

/**
 * Referral / Loyalty Points: reuses the existing Macaash balance/ledger
 * (customers.macaash_points + macaash_transactions) as the one points
 * currency, per explicit product decision, rather than a second parallel
 * system. Points are only ever credited on a referred customer's first
 * completed order — never for merely sharing a link or creating an account.
 */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I)

function randomCode(length = 7): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Lazily generates and persists a unique referral code for a customer who
 * doesn't have one yet — called from GET /customers/me/referral so every
 * customer gets one on first use, with no bulk-generation migration step. */
export async function ensureReferralCode(customerId: string): Promise<string> {
  const existing = await queryOne<{ referral_code: string | null }>(
    `SELECT referral_code FROM customers WHERE id=$1`,
    [customerId]
  );
  if (existing?.referral_code) return existing.referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await query(`UPDATE customers SET referral_code=$1 WHERE id=$2`, [code, customerId]);
      return code;
    } catch (err: any) {
      if (err?.code !== "23505") throw err;
      // Extremely unlikely collision — retry with a fresh code.
    }
  }
  throw new Error("Could not generate a unique referral code after 5 attempts");
}

async function getRewardRule(): Promise<{ points_per_referral_purchase: number; points_per_dollar_discount: number; enabled: boolean } | null> {
  return queryOne(`SELECT points_per_referral_purchase, points_per_dollar_discount, enabled FROM referral_reward_rules LIMIT 1`);
}

/** Call this from every order-completion code path (completeOrderById, the
 * admin status PUT, and the dial-attempt success report), right alongside
 * creditMacaashIfNeeded/creditCommissionIfNeeded — a no-op unless this is the
 * referred customer's own first completed order. */
export async function creditReferralBonusIfNeeded(order: { id: string; customer_id: string }): Promise<void> {
  const rule = await getRewardRule();
  if (!rule || !rule.enabled || rule.points_per_referral_purchase <= 0) return;

  const customer = await queryOne<{ referred_by_customer_id: string | null }>(
    `SELECT referred_by_customer_id FROM customers WHERE id=$1`,
    [order.customer_id]
  );
  const referrerId = customer?.referred_by_customer_id;
  if (!referrerId) return;

  // Only the *first* completed order from the referred customer counts as
  // "a successful referral purchase" — later purchases by the same customer
  // don't earn the referrer more points.
  const priorCompleted = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM orders WHERE customer_id=$1 AND status='completed' AND id != $2`,
    [order.customer_id, order.id]
  );
  if (Number(priorCompleted?.count ?? 0) > 0) return;

  try {
    await query(
      `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason, kind)
       VALUES ($1,$2,$3,$4,$5,'referral_bonus')`,
      [randomUUID(), referrerId, order.id, rule.points_per_referral_purchase, `Referral bonus for order ${order.id}`]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_macaash_tx_order_referral_bonus") throw err;
    return; // already credited by a concurrent/retried completion signal — no-op
  }
  await query(`UPDATE customers SET macaash_points = macaash_points + $1 WHERE id=$2`, [rule.points_per_referral_purchase, referrerId]);
}

/** Call this from reverseOrderInternal, alongside the Macaash/commission
 * clawback — a no-op if this order never triggered a referral bonus. */
export async function reverseReferralBonusIfNeeded(orderId: string): Promise<void> {
  const earned = await queryOne<{ customer_id: string; points: number }>(
    `SELECT customer_id, points FROM macaash_transactions WHERE order_id=$1 AND kind='referral_bonus'`,
    [orderId]
  );
  if (!earned) return;
  try {
    await query(
      `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason, kind)
       VALUES ($1,$2,$3,$4,$5,'referral_bonus_reversal')`,
      [randomUUID(), earned.customer_id, orderId, -earned.points, `Reversed referral bonus for order ${orderId}`]
    );
  } catch (err: any) {
    if (err?.code !== "23505" || err?.constraint !== "idx_macaash_tx_order_referral_bonus_reversal") throw err;
    return; // already reversed by a concurrent call — no-op
  }
  await query(`UPDATE customers SET macaash_points = GREATEST(0, macaash_points - $1) WHERE id=$2`, [earned.points, earned.customer_id]);
}

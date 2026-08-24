-- Referral / Loyalty Points: customers earn points (reusing the existing
-- Macaash balance/ledger, per explicit product decision) only when their
-- referral link produces a successful paid purchase -- never for merely
-- sharing the link or creating an account.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_customers_referred_by ON customers(referred_by_customer_id);

-- Single-row admin-configurable reward rule (points per successful referral
-- purchase, and how many points equal a $1 discount).
CREATE TABLE IF NOT EXISTS referral_reward_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  points_per_referral_purchase INTEGER NOT NULL DEFAULT 100 CHECK (points_per_referral_purchase >= 0),
  points_per_dollar_discount INTEGER NOT NULL DEFAULT 100 CHECK (points_per_dollar_discount > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
INSERT INTO referral_reward_rules (id)
  SELECT gen_random_uuid()
  WHERE NOT EXISTS (SELECT 1 FROM referral_reward_rules);

-- The macaash_transactions_kind_check constraint itself is intentionally NOT
-- set here anymore. migrate.ts replays every migration file on every deploy
-- (no tracking table), so this file must stay safe to re-run indefinitely.
-- This block used to unconditionally narrow the constraint to
-- ('earn','reversal','manual','referral_bonus','referral_bonus_reversal',
-- 'redeemed') on every replay -- fine on a fresh database, but once
-- 039_redeemed_points_refund.sql's later, wider constraint (which adds
-- 'redeemed_refund') has actually been applied and a real redeemed_refund
-- row exists, replaying THIS narrower version first on every subsequent
-- deploy fails with "check constraint ... is violated by some row" and
-- blocks every migration after it, forever -- confirmed live on production,
-- same failure mode 894b1b1 already fixed for 030_feedback.sql's
-- notifications_type_check.
-- 039_redeemed_points_refund.sql (which runs after this file, sorted by
-- filename) is the sole source of truth for this constraint's final,
-- correct value. Adds 'referral_bonus'/'referral_bonus_reversal'/'redeemed'
-- support for a fresh database only implicitly, via 039 running later in
-- the same replay -- not a behavior change for any real deploy.

CREATE UNIQUE INDEX IF NOT EXISTS idx_macaash_tx_order_referral_bonus
  ON macaash_transactions(order_id) WHERE kind = 'referral_bonus' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_macaash_tx_order_referral_bonus_reversal
  ON macaash_transactions(order_id) WHERE kind = 'referral_bonus_reversal' AND order_id IS NOT NULL;

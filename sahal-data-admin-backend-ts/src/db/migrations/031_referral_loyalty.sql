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

-- Widen the existing Macaash ledger's kind enum: 'referral_bonus' credits the
-- referring customer on their referral's first completed purchase;
-- 'referral_bonus_reversal' claws it back if that order is later reversed;
-- 'redeemed' debits points spent as a discount on a future purchase.
ALTER TABLE macaash_transactions DROP CONSTRAINT IF EXISTS macaash_transactions_kind_check;
ALTER TABLE macaash_transactions ADD CONSTRAINT macaash_transactions_kind_check
  CHECK (kind IN ('earn', 'reversal', 'manual', 'referral_bonus', 'referral_bonus_reversal', 'redeemed'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_macaash_tx_order_referral_bonus
  ON macaash_transactions(order_id) WHERE kind = 'referral_bonus' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_macaash_tx_order_referral_bonus_reversal
  ON macaash_transactions(order_id) WHERE kind = 'referral_bonus_reversal' AND order_id IS NOT NULL;

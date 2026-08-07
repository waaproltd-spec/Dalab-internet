-- A customer's redeemed Macaash points (checkout discount, see POST /orders'
-- useLoyaltyPoints) must come back if the order they were spent on never
-- actually delivers value — 'redeemed_refund' is a new ledger kind,
-- symmetric with 'referral_bonus'/'referral_bonus_reversal'.
ALTER TABLE macaash_transactions DROP CONSTRAINT IF EXISTS macaash_transactions_kind_check;
ALTER TABLE macaash_transactions ADD CONSTRAINT macaash_transactions_kind_check
  CHECK (kind IN ('earn', 'reversal', 'manual', 'referral_bonus', 'referral_bonus_reversal', 'redeemed', 'redeemed_refund'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_macaash_tx_order_redeemed_refund
  ON macaash_transactions(order_id) WHERE kind = 'redeemed_refund' AND order_id IS NOT NULL;

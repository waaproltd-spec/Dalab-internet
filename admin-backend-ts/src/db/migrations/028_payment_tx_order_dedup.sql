-- Critical Fix: prevent an order from ever having more than one active
-- (non-duplicate_blocked) payment_transactions row. Confirmed root cause:
-- findMatchingOrder() matches an order by status='pending' before that order
-- is "claimed" anywhere, so two SMS with different transaction_ref values
-- (createPaymentTransaction's only prior dedup guard was scoped to
-- transaction_ref, never order_id) could both insert a 'pending' row for the
-- same order_id. Mirrors idx_payment_tx_ref_active's exact pattern, scoped to
-- order_id instead of transaction_ref.
--
-- Step 1: reclassify existing violations (this table already has live
-- duplicate rows in production per the reported screenshot) before adding the
-- unique index, so the CREATE UNIQUE INDEX below doesn't fail against them.
-- Keeps the single most-recently-updated active row per order_id; every
-- older one becomes duplicate_blocked.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY order_id
           ORDER BY updated_at DESC, created_at DESC
         ) AS rn
  FROM payment_transactions
  WHERE order_id IS NOT NULL AND status <> 'duplicate_blocked'
)
UPDATE payment_transactions
SET status = 'duplicate_blocked', updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_tx_order_active
  ON payment_transactions(order_id) WHERE order_id IS NOT NULL AND status <> 'duplicate_blocked';

-- Prevent re-visiting Checkout from creating multiple sibling pending orders
-- for the exact same purchase (same customer, company, package, amount).
-- Confirmed root cause of a real incident: CheckoutScreen.kt generates a
-- fresh clientRequestId per screen composition, so 3 separate visits to
-- Checkout for the same package legitimately created 3 distinct orders,
-- only one of which a payment SMS ever actually completed.
--
-- Scoped to scheduled_at IS NULL: two deliberately-scheduled recharges of
-- the same package at different future times are a legitimate, distinct
-- use case and must never be collapsed into one order.
--
-- Production already contains legitimate-at-the-time duplicate pending
-- orders from before this constraint existed (the exact repeated-Checkout
-- incident described above), which made the index creation below fail on
-- every deploy since this migration was introduced. Cancel every duplicate
-- except the oldest per group (same "oldest pending order wins" rule this
-- feature already applies going forward) before creating the index -- never
-- deleting rows, so order history/audit stays intact.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY customer_id, company_id, package_id, amount
           ORDER BY created_at ASC
         ) AS rn
  FROM orders
  WHERE status = 'pending' AND scheduled_at IS NULL
)
UPDATE orders
SET status = 'cancelled'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_content_dedup
  ON orders (customer_id, company_id, package_id, amount)
  WHERE status = 'pending' AND scheduled_at IS NULL;

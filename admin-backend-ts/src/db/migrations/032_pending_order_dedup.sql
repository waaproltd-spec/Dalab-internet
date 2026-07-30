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
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_content_dedup
  ON orders (customer_id, company_id, package_id, amount)
  WHERE status = 'pending' AND scheduled_at IS NULL;

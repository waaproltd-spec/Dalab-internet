-- Phase 4 of the expanded Shop spec: Returns / Exchange / Refund
-- *requests* -- a distinct, customer-visible progress tracker
-- (Requested -> Approved/Rejected -> Processing -> Completed), separate
-- from shop_orders.status's own terminal 'returned'/'refunded' values
-- (which already cover the order's own resting state once some process
-- concludes -- see migration 077's header comment). This table is the
-- process itself: why the customer wants it, and Admin's stage-by-stage
-- handling of that request. Deliberately not auto-synced back onto
-- shop_orders.status -- Admin still uses the existing order-status route
-- for that, keeping this table's own lifecycle simple and independent.
--
-- Scoped to the whole order (not a single order item) -- nothing else in
-- this Shop implementation tracks returns at item granularity, and the
-- spec doesn't ask for it either. Only a delivered order can have a
-- request opened against it (enforced in the route), and the partial
-- unique index below caps it at one active (not yet rejected/completed)
-- request per order at a time, so a customer can't stack duplicate
-- requests for the same order while one is already in flight.
CREATE TABLE IF NOT EXISTS shop_return_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('return', 'exchange', 'refund')),
  reason       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'approved', 'rejected', 'processing', 'completed')),
  admin_note   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_return_requests_customer ON shop_return_requests(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_return_requests_status ON shop_return_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_return_requests_active_per_order
  ON shop_return_requests(order_id) WHERE status IN ('requested', 'approved', 'processing');

-- Widened again (same pattern as 030/041/073/075 before it) for this
-- request workflow's own status-change notifications.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign','shop_order_update','shop_return_update'));

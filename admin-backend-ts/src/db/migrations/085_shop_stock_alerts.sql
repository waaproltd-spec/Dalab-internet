-- Low-stock alerts: an admin-configurable per-product threshold (defaults
-- to 5) -- GET /admin/shop/products/low-stock surfaces every active
-- product at or below its own threshold, the same "Admin reads a dashboard
-- list" pattern this codebase already uses for Feedback & Suggestions
-- rather than a push-to-admin pipeline this app has no admin-device
-- registration for.
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0);

-- Back-in-stock notifications: a customer taps "Notify Me" on an
-- out-of-stock product; when an Admin later raises that product's stock
-- above zero, every un-notified subscriber gets a real notifyCustomer()
-- push+in-app notification and is marked notified. The partial unique
-- index (WHERE notified=false) lets the same customer re-subscribe after
-- being notified once (e.g. it sold out again later) without a duplicate
-- pending row, while still being idempotent against a double-tap of
-- "Notify Me" before the first notification has gone out.
CREATE TABLE IF NOT EXISTS shop_stock_notify_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  notified    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_stock_notify_pending_unique
  ON shop_stock_notify_requests (customer_id, product_id) WHERE notified = false;
CREATE INDEX IF NOT EXISTS idx_shop_stock_notify_product ON shop_stock_notify_requests(product_id) WHERE notified = false;

-- Widened again (same pattern as 030/041/073/075/080 before it) for this
-- feature's own back-in-stock push+in-app notification.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign','shop_order_update','shop_return_update','shop_back_in_stock'));

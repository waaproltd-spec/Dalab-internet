-- Phase 5 of the expanded Shop spec: order status timeline, saved
-- delivery addresses, and product-view tracking (powers both Recently
-- Viewed and Recommended Products).

-- Every status an order passes through, in order, independent of
-- shop_orders' own single current-status column -- so the Customer App
-- can render a real Pending -> Processing -> Shipped -> Delivered
-- timeline with a timestamp per stage, not just "here's where it is now".
CREATE TABLE IF NOT EXISTS shop_order_status_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_order_status_history_order ON shop_order_status_history(order_id, changed_at);

-- Backfill one 'pending' entry for every order that predates this
-- migration, using its own created_at, so no existing order's timeline
-- starts blank.
INSERT INTO shop_order_status_history (order_id, status, changed_at)
SELECT id, 'pending', created_at FROM shop_orders
WHERE NOT EXISTS (SELECT 1 FROM shop_order_status_history h WHERE h.order_id = shop_orders.id);

-- A customer's saved delivery addresses -- Checkout picks one and copies
-- its fields into the same deliveryName/Phone/Address the order-creation
-- route already accepts, so POST /shop/orders itself needs no change.
-- Only one default at a time per customer, enforced by the partial
-- unique index below (the route clears any prior default in the same
-- transaction before setting a new one).
CREATE TABLE IF NOT EXISTS shop_delivery_addresses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label          TEXT NOT NULL DEFAULT '',
  recipient_name TEXT NOT NULL,
  phone          TEXT NOT NULL,
  address_text   TEXT NOT NULL,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_delivery_addresses_customer ON shop_delivery_addresses(customer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_delivery_addresses_one_default
  ON shop_delivery_addresses(customer_id) WHERE is_default = true;

-- One row per (customer, product) -- upserted (viewed_at bumped) on every
-- product-detail view, not an append-only log, since only "when did they
-- last look at this" matters for Recently Viewed / Recommended, not a
-- full view history.
CREATE TABLE IF NOT EXISTS shop_product_views (
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  viewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_product_views_customer ON shop_product_views(customer_id, viewed_at DESC);

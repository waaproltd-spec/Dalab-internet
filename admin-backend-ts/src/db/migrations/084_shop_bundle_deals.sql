-- Bundle Deals: a fixed set of products sold together at a single bundle
-- price, cheaper than buying each separately. A bundle purchase becomes a
-- single shop_order_items row (bundle_id set, product_id NULL) rather than
-- one row per constituent product -- the customer bought "the bundle", and
-- the constituent products/quantities are recorded on
-- shop_bundle_deal_items, looked up by bundle_id whenever the order needs
-- to know what to restore to stock (cancel/status-change), never
-- duplicated onto the order item itself.
CREATE TABLE IF NOT EXISTS shop_bundle_deals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  bundle_price  NUMERIC(10,2) NOT NULL CHECK (bundle_price >= 0),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_bundle_deal_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id   UUID NOT NULL REFERENCES shop_bundle_deals(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  UNIQUE (bundle_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_bundle_deal_items_bundle ON shop_bundle_deal_items(bundle_id);

-- Snapshotted at order time (bundle_name), same reasoning as
-- product_name/unit_price above -- a later bundle rename/deletion must
-- never alter the historical record of what a customer actually bought.
ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS bundle_id UUID REFERENCES shop_bundle_deals(id) ON DELETE SET NULL;
ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS bundle_name TEXT;

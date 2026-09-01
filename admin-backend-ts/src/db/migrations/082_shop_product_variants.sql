-- Product Variants: size/color/model/storage/etc, each with its own
-- optional price override and its own stock count. `attributes` is a small
-- JSONB bag (e.g. {"size":"XL","color":"Red"}) rather than fixed size/color
-- columns, since the spec's "model/storage/etc." makes the actual attribute
-- set open-ended per product -- a shoe has size+color, a phone has
-- storage+color, and neither needs a schema change to add. `label` is the
-- admin-entered display string shown as-is in the Customer App (e.g.
-- "Red / XL"), so the UI never has to reconstruct one from `attributes`.
--
-- price NULL means "use the parent product's own price" -- most variants
-- of a product cost the same, so this avoids forcing every variant row to
-- duplicate the base price and then needing every future product price
-- edit to also touch every variant row.
CREATE TABLE IF NOT EXISTS shop_product_variants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  price         NUMERIC(10,2) CHECK (price >= 0),
  stock         INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sku           TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_product_variants_product ON shop_product_variants(product_id, position);

-- Snapshotted at order time, same reasoning as product_name/unit_price on
-- this same table (migration 074's header comment) -- a later variant edit
-- or deletion must never alter the historical record of what a customer
-- actually bought, hence ON DELETE SET NULL rather than RESTRICT/CASCADE.
ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES shop_product_variants(id) ON DELETE SET NULL;
ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS variant_label TEXT;

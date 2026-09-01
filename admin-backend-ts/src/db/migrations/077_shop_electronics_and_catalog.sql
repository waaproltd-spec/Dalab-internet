-- Phase 1 of the expanded Shop spec:
--  1. "Shoes" becomes "Electronics" -- renamed in place (never deleted +
--     re-inserted) so any product already filed under the old category_id
--     keeps a valid, correctly-labelled category rather than being orphaned
--     or hitting the ON DELETE RESTRICT on shop_products.category_id.
--  2. Electronics needs admin-defined subcategories (Phone Covers,
--     Chargers, ...) without a code change per subcategory -- a normal
--     child table, not an enum or hardcoded list. Scoped to shop_categories
--     generically (not hardcoded to Electronics's id) so any future
--     category could use subcategories too, but only Electronics's admin UI
--     surfaces them for now.
--  3. Catalog fields the spec calls for: brand (free text), oldPrice (a
--     second price column, following the exact oldPrice/price > discount
--     convention `packages` already uses -- see Package.hasDiscount in the
--     Customer App), and three independent admin-set merchandising flags
--     (featured/new arrival/best seller) rather than derived logic, per the
--     spec's "Admin can mark as ..." wording. sold_count is maintained by
--     the application (incremented per order item at order-creation time)
--     to support "sort by popularity" without a live aggregate query on
--     every catalog page load.
--  4. shop_orders needs a courier_name field (distinct from
--     tracking_reference/tracking_note, which already cover "tracking
--     number" and "delivery notes") and three more terminal/near-terminal
--     statuses (failed/returned/refunded) alongside the existing
--     pending/processing/shipped/delivered/cancelled set.
--  5. Duplicate-order protection: the same "one unique index, scoped to the
--     not-yet-resolved state" pattern migration 032 already established for
--     Internet Store orders (re-visiting Checkout re-creating the same
--     pending order). dedup_key is a deterministic signature of this
--     order's cart contents + payment method; the partial unique index only
--     applies while the order is still 'pending', so a customer placing the
--     exact same cart again later (after the first order resolves one way
--     or another) is never blocked -- only a same-instant double-submit is.

-- Plain "UPDATE ... WHERE name='Shoes'" is not safe to replay: every
-- migrate run replays 074 first (no tracking table), and once this rename
-- has happened, 074's seed INSERT no longer conflicts with anything named
-- 'Shoes' (there isn't one), so it silently re-inserts a fresh 'Shoes' row
-- on every subsequent run -- confirmed by hand, not hypothetical. That
-- freshly re-seeded row can never have any products against it (nothing
-- can place an order between two statements of one migration run), so it's
-- always safe to just delete it once Electronics already exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shop_categories WHERE name = 'Electronics') THEN
    DELETE FROM shop_categories WHERE name = 'Shoes';
  ELSE
    UPDATE shop_categories SET name = 'Electronics', emoji = '📱' WHERE name = 'Shoes';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS shop_subcategories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   UUID NOT NULL REFERENCES shop_categories(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, name)
);
CREATE INDEX IF NOT EXISTS idx_shop_subcategories_category ON shop_subcategories(category_id);

ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS subcategory_id UUID REFERENCES shop_subcategories(id) ON DELETE SET NULL;
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS old_price NUMERIC(10,2) CHECK (old_price >= 0);
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS is_new_arrival BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS best_seller BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS sold_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_shop_products_subcategory ON shop_products(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_shop_products_brand ON shop_products(brand);

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS courier_name TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS dedup_key TEXT NOT NULL DEFAULT '';

ALTER TABLE shop_orders DROP CONSTRAINT IF EXISTS shop_orders_status_check;
ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_status_check
  CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'failed', 'returned', 'refunded'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_orders_pending_dedup
  ON shop_orders (customer_id, dedup_key)
  WHERE status = 'pending';

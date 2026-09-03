-- Flash Sales: a time-boxed sale price on specific products. Deliberately
-- separate from shop_products.old_price (which is a plain, indefinite
-- "was/now" discount an Admin sets directly on the product) -- a flash sale
-- has a start/end window and can be scheduled ahead of time without
-- touching the product's normal price at all.
CREATE TABLE IF NOT EXISTS shop_flash_sales (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_flash_sale_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flash_sale_id  UUID NOT NULL REFERENCES shop_flash_sales(id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  sale_price     NUMERIC(10,2) NOT NULL CHECK (sale_price >= 0),
  UNIQUE (flash_sale_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_flash_sale_items_product ON shop_flash_sale_items(product_id);

-- Single source of truth for "what does this product actually cost right
-- now" -- the lowest currently-active flash-sale price for it, or its own
-- base price if none applies. STABLE (not IMMUTABLE, since it reads now())
-- so Postgres can still cache the result within one statement/transaction
-- but must re-evaluate it on the next one -- exactly the freshness a live
-- price needs. Used everywhere shop_products.price is read (catalog reads,
-- order creation, cart validation) so a flash sale is automatically
-- reflected without duplicating this lookup at every call site.
CREATE OR REPLACE FUNCTION shop_effective_price(p_product_id UUID, p_base_price NUMERIC)
RETURNS NUMERIC AS $$
  SELECT COALESCE(
    (SELECT MIN(fsi.sale_price)
     FROM shop_flash_sale_items fsi
     JOIN shop_flash_sales fs ON fs.id = fsi.flash_sale_id
     WHERE fsi.product_id = p_product_id AND fs.active = true
       AND now() BETWEEN fs.starts_at AND fs.ends_at),
    p_base_price
  );
$$ LANGUAGE sql STABLE;

-- The "was" price to show struck through: when a flash sale is currently
-- active for the product, that's the product's own normal price (so the
-- discount reads correctly even for a product with no independent
-- old_price of its own); otherwise it's whatever old_price already was.
CREATE OR REPLACE FUNCTION shop_effective_old_price(p_product_id UUID, p_base_price NUMERIC, p_old_price NUMERIC)
RETURNS NUMERIC AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM shop_flash_sale_items fsi
      JOIN shop_flash_sales fs ON fs.id = fsi.flash_sale_id
      WHERE fsi.product_id = p_product_id AND fs.active = true
        AND now() BETWEEN fs.starts_at AND fs.ends_at
    ) THEN COALESCE(p_old_price, p_base_price)
    ELSE p_old_price
  END;
$$ LANGUAGE sql STABLE;

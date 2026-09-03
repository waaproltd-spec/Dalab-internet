-- Phase 3 of the expanded Shop spec: Favorites/Wishlist and purchase-gated
-- Reviews & Ratings.
--
-- shop_favorites is a plain join table (composite PK, no surrogate id
-- needed since a customer can only favorite a given product once) --
-- ON DELETE CASCADE both ways so a deleted product or customer never
-- leaves an orphaned row behind.
--
-- shop_reviews ties a review to the specific shop_order_items row that
-- was purchased (not just "this customer bought this product at some
-- point"), matching the spec's "must be linked to real completed orders"
-- requirement precisely -- the route layer additionally checks that
-- order's status is 'delivered' before accepting a review. order_item_id
-- is UNIQUE so the same purchase can't be reviewed twice; buying the same
-- product again creates a new order_item_id and so a legitimate second
-- review opportunity. photo is a single optional image, BYTEA like
-- shop_product_images, following the same "no S3/Cloudinary pipeline in
-- this codebase" reasoning migration 074 already gave.
CREATE TABLE IF NOT EXISTS shop_favorites (
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_favorites_product ON shop_favorites(product_id);

CREATE TABLE IF NOT EXISTS shop_reviews (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id    UUID NOT NULL UNIQUE REFERENCES shop_order_items(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rating           INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text      TEXT NOT NULL DEFAULT '',
  photo_data       BYTEA,
  photo_mime_type  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_reviews_product ON shop_reviews(product_id, created_at DESC);

-- Lets an admin upload a real icon image for a Shop category instead of (or
-- alongside) its emoji -- emoji stays as the always-available fallback both
-- here and in the Customer App, so a category with no uploaded image still
-- renders exactly as it did before this migration. Single image per
-- category (not a gallery like shop_product_images) since a category icon
-- is one small badge, not something a customer swipes through.
ALTER TABLE shop_categories ADD COLUMN IF NOT EXISTS image_data BYTEA;
ALTER TABLE shop_categories ADD COLUMN IF NOT EXISTS image_mime_type TEXT;

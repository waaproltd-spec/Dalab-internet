-- One image (icon) per package, shown in the Customer App's package list --
-- mirrors companies.logo_data/logo_mime_type exactly (migration 020's
-- company logo columns), not shop_product_images' multi-image gallery
-- shape, since a package needs exactly one icon. See companies.routes.ts's
-- PACKAGE_COLUMNS for why every list/detail query explicitly excludes
-- image_data (a has_image boolean instead) and only the dedicated
-- GET /packages/:id/image route ever selects the raw bytes.
ALTER TABLE packages ADD COLUMN IF NOT EXISTS image_data BYTEA;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS image_mime_type TEXT;

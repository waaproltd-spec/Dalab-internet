-- Richer "Add Company"/"Add Provider" form: a descriptive slug, a
-- description, an explicit display sort order within each group, and a
-- real uploaded logo (BYTEA, same pattern as promo_images.image_data) —
-- today's `id` stays the immutable primary key referenced by every FK
-- (packages, orders, sim_routing, ...); `slug` is a separate, purely
-- cosmetic field so renaming/re-slugging a company never risks breaking
-- those references.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_data BYTEA;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_mime_type TEXT;

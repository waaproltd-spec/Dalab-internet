-- Promotional ad popup (Customer App, shown once per 24h per customer on
-- app open) -- deliberately a separate table from promo_images (the
-- existing inline Home-screen carousel banner, image-only, Super-Admin-
-- managed). This one carries its own headline/body text and is managed
-- from the Agent App, not the Admin Dashboard.
CREATE TABLE IF NOT EXISTS promo_ads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_data  BYTEA NOT NULL,
  mime_type   TEXT NOT NULL,
  title       TEXT,
  body        TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promo_ads_enabled_position ON promo_ads(enabled, position);

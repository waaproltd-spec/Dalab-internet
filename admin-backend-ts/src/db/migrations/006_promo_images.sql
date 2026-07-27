-- Super Admin-managed promotional images shown as a carousel on the
-- Customer App Home screen. Images are stored directly in Postgres
-- (no external object storage configured for this project) and served
-- through a dedicated binary-response endpoint rather than embedded in
-- the JSON list, so GET /promo-images stays small regardless of image size.
CREATE TABLE IF NOT EXISTS promo_images (
  id            UUID PRIMARY KEY,
  image_data    BYTEA NOT NULL,
  mime_type     TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 1,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promo_images_active_position ON promo_images (active, position);

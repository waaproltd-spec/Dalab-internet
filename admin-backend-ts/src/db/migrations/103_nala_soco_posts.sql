-- Nala Soco ("Follow Us") -- a Super Admin/Admin-managed feed of
-- announcements/promos/news shown as the Customer App's own bottom-nav
-- tab (Internet Store only -- see the customer-app's RootShell). image_data
-- follows promo_images' own pattern (stored directly in Postgres, served
-- through a dedicated binary-response route) since no external object
-- storage is configured for this project; the image is optional here,
-- unlike promo_images, since a post can be text-only.
CREATE TABLE IF NOT EXISTS nala_soco_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  image_data      BYTEA,
  image_mime_type TEXT,
  published       BOOLEAN NOT NULL DEFAULT true,
  created_by_id   UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nala_soco_posts_published_created ON nala_soco_posts (published, created_at DESC);

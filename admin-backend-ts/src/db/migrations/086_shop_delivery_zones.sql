-- Delivery zones: per-area delivery fees (e.g. "Hodan" $2, "Outside
-- Mogadishu" $5), on top of shop_settings.delivery_fee's single flat rate
-- from migration 078. A saved delivery address can optionally be tagged
-- with a zone; Checkout then uses that zone's fee instead of the flat one.
-- Deliberately additive, not a replacement: shop_settings.delivery_fee
-- stays the fallback for a customer/address with no zone chosen, so
-- nothing about the existing flat-fee flow breaks.
CREATE TABLE IF NOT EXISTS shop_delivery_zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  fee         NUMERIC(10,2) NOT NULL CHECK (fee >= 0),
  active      BOOLEAN NOT NULL DEFAULT true,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE shop_delivery_addresses ADD COLUMN IF NOT EXISTS zone_id UUID REFERENCES shop_delivery_zones(id) ON DELETE SET NULL;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS delivery_zone_id UUID REFERENCES shop_delivery_zones(id) ON DELETE SET NULL;

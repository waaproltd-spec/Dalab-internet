-- 1. VIP Number Package discounts -- same was/now pair Shop products
-- already use (shop_products.old_price/price, see migration 077): a
-- package is discounted whenever old_price IS NOT NULL AND old_price >
-- price. No separate discount-type/percentage column, matching Shop's
-- own pattern exactly -- the admin enters both numbers directly.
ALTER TABLE vip_number_packages ADD COLUMN IF NOT EXISTS old_price NUMERIC(10,2) CHECK (old_price >= 0);

-- 2. VIP Numbers working hours / open-close -- a dedicated singleton
-- settings row mirroring shop_settings' own shape/columns exactly
-- (migration 078) so the admin-facing behavior matches Shop's Open/Close
-- system as closely as possible (working_days using the same
-- EXTRACT(DOW ...) 0=Sunday..6=Saturday convention, manual_override
-- pinning the state regardless of schedule). Deliberately its own row
-- rather than reusing shop_settings itself: VIP Numbers has no delivery
-- fee, and the two lines of business need independently settable hours
-- (closing Shop for a delivery-team break shouldn't silently also close
-- VIP Number sales). Governs both the individual ("1 Number") and
-- Package purchase flows -- there is only one open/closed switch for VIP
-- Numbers as a whole, not one per flow.
CREATE TABLE IF NOT EXISTS vip_number_settings (
  id               BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
  working_days     INTEGER[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
  opening_time     TIME NOT NULL DEFAULT '08:00',
  closing_time     TIME NOT NULL DEFAULT '22:00',
  manual_override  TEXT CHECK (manual_override IN ('open', 'closed')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID REFERENCES admin_users(id) ON DELETE SET NULL
);
INSERT INTO vip_number_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- 3. A distinct 'expired' status for both order tables' status CHECK
-- constraints -- a pending order whose customer never paid within the
-- 15-minute reservation window (see vipNumbers.routes.ts's and
-- vipNumberPackages.routes.ts's new expiry sweep) is neither
-- customer-cancelled nor admin-marked-failed, so it gets its own status
-- rather than overloading either of those. Widened the same
-- drop-then-recreate way notifications_type_check's own precedent
-- (073/075/080/085/087/088) does, carrying forward every existing value.
--
-- NOT VALID: migrate.ts replays every migration file on every deploy (no
-- tracking table). This is the only widening of these two constraints
-- today, but a future migration adding yet another status would widen
-- them again the same way -- NOT VALID here means that future ALTER can
-- never fail re-validating rows this migration already made valid (see
-- notifications_type_check's own NOT VALID comments in 073/075/080/085/
-- 087/088 for the live production failure this exact pattern caused once
-- real data outran an earlier, narrower replayed constraint).
ALTER TABLE vip_number_orders DROP CONSTRAINT IF EXISTS vip_number_orders_status_check;
ALTER TABLE vip_number_orders ADD CONSTRAINT vip_number_orders_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'failed', 'expired')) NOT VALID;

ALTER TABLE vip_number_package_orders DROP CONSTRAINT IF EXISTS vip_number_package_orders_status_check;
ALTER TABLE vip_number_package_orders ADD CONSTRAINT vip_number_package_orders_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'failed', 'expired')) NOT VALID;

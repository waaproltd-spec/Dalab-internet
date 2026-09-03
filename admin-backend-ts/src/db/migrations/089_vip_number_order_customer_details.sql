-- The VIP Number checkout flow now collects a customer's city/location,
-- district, and mother's name alongside their full name (see
-- vipNumbers.routes.ts's POST /vip-numbers/orders) -- required for
-- DALAB's real-world number registration/porting after payment, same
-- reason customer_full_name itself is required. Nullable here (no NOT
-- NULL/default): any order rows created before this migration have no
-- value for these, and requiredness for every NEW order is enforced in
-- the route itself, not the schema, matching how this table already
-- treats most of its own requiredness checks.
ALTER TABLE vip_number_orders ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE vip_number_orders ADD COLUMN IF NOT EXISTS district TEXT;
ALTER TABLE vip_number_orders ADD COLUMN IF NOT EXISTS mother_name TEXT;

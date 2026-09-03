-- VIP Number Package checkout collects the same Customer Information as
-- the individual flow (migration 089's own columns on vip_number_orders)
-- on its own screen 1 of 2 -- these are the package-order equivalent.
-- Nullable, no NOT NULL/default, to avoid breaking pre-existing package
-- order rows; requiredness enforced at the route layer only for new
-- orders (see vipNumberPackages.routes.ts).
ALTER TABLE vip_number_package_orders ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE vip_number_package_orders ADD COLUMN IF NOT EXISTS district TEXT;
ALTER TABLE vip_number_package_orders ADD COLUMN IF NOT EXISTS mother_name TEXT;

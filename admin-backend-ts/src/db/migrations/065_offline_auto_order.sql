-- Customer-owned Offline Auto-Order profile -- stored directly on customers,
-- the same pattern evc_plus_number/edahab_number (migration 044) already
-- established for "a customer's own saved payment info that auto-fills a
-- flow instead of being retyped every time," rather than a separate profile
-- table. Nothing here is Admin-managed per customer -- see
-- customers.routes.ts's PUT /customer/offline-profile, the only writer.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS offline_sender_number TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS offline_destination_number TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS offline_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS offline_package_id UUID REFERENCES packages(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS offline_profile_updated_at TIMESTAMPTZ;

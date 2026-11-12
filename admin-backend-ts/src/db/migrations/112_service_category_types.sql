-- Lets an Admin give a service ONE, TWO OR ALL THREE Service Types (wifi,
-- wireless, call) instead of exactly one -- e.g. "Anfac Plus" = WiFi +
-- Call. The Customer App shows every selected type's icon on the service.
--
-- Purely additive: the single service_type column from migration 111 is
-- kept (never dropped) and stays in sync with the first selected type, so
-- older app builds that only read serviceType keep working. Existing
-- single types are copied into the new list; nothing is deleted.
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS service_types TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_categories_service_types_check'
  ) THEN
    ALTER TABLE service_categories ADD CONSTRAINT service_categories_service_types_check
      CHECK (service_types <@ ARRAY['wifi', 'wireless', 'call']::TEXT[]);
  END IF;
END $$;

-- Copy each existing single type into the list (only where the list is
-- still empty, so re-running this migration never overwrites admin edits).
UPDATE service_categories
   SET service_types = ARRAY[service_type]
 WHERE service_type IS NOT NULL AND service_types = '{}';

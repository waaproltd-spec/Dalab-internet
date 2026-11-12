-- Adds 'data' (mobile data, the up/down arrows icon) as a fourth Admin-only
-- Service Type next to wifi / wireless / call. Only widens the two CHECK
-- constraints from migrations 111/112 -- no rows are changed or deleted.
-- Idempotent: each constraint is rebuilt only while it doesn't allow 'data'
-- yet, so replaying this on every boot is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'service_categories_service_type_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%data%'
  ) THEN
    ALTER TABLE service_categories DROP CONSTRAINT service_categories_service_type_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_categories_service_type_check') THEN
    ALTER TABLE service_categories ADD CONSTRAINT service_categories_service_type_check
      CHECK (service_type IN ('wifi', 'wireless', 'call', 'data'));
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'service_categories_service_types_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%data%'
  ) THEN
    ALTER TABLE service_categories DROP CONSTRAINT service_categories_service_types_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_categories_service_types_check') THEN
    ALTER TABLE service_categories ADD CONSTRAINT service_categories_service_types_check
      CHECK (service_types <@ ARRAY['wifi', 'wireless', 'call', 'data']::TEXT[]);
  END IF;
END $$;

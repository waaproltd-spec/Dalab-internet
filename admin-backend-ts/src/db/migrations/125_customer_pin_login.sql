-- One Number + PIN login screen (POST /auth/customer/enter): a number
-- that isn't registered gets a new account automatically, so two spellings
-- of the same number ("252615551234", "+252615551234", "615551234") must
-- never become two accounts. customers.phone is already UNIQUE, but only
-- byte-for-byte; this adds the same guarantee on the 9-digit local number.
--
-- Nothing is deleted or changed. If the table already holds two rows for
-- the same number in different spellings, the index can't be built: the
-- migration says so (NOTICE, with the count) and leaves everything as it
-- is -- the endpoint still looks up every spelling before creating, and the
-- duplicates can be merged by hand, after which this file can be re-run.
DO $$
DECLARE dupes INTEGER;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT regexp_replace(regexp_replace(phone, '\D', '', 'g'), '^252(\d{9})$', '\1')
      FROM customers
     GROUP BY 1 HAVING COUNT(*) > 1
  ) d;
  IF dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_local
      ON customers ((regexp_replace(regexp_replace(phone, '\D', '', 'g'), '^252(\d{9})$', '\1')));
  ELSE
    RAISE NOTICE 'idx_customers_phone_local NOT created: % number(s) have more than one customer row in different spellings', dupes;
  END IF;
END $$;

-- Wrong-PIN attempts per number (not per IP, so changing networks doesn't
-- reset them): after 5 wrong PINs in 15 minutes the number is locked for
-- 15 minutes. Survives a server restart, unlike the in-memory IP limiter.
CREATE TABLE IF NOT EXISTS customer_login_failures (
  phone_local     TEXT PRIMARY KEY,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until    TIMESTAMPTZ
);

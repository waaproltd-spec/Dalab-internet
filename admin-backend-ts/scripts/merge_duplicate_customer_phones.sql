-- Merge customers that are the same phone number stored in two spellings
-- (9 digits "615551234" and "252615551234"), so migration 125's unique
-- index can be created. Run by hand, never on boot:
--
--   dry run (shows what would happen, then ROLLBACK):
--     psql "$DB" -f scripts/merge_duplicate_customer_phones.sql
--   apply (same, then COMMIT):
--     psql "$DB" -v apply=1 -f scripts/merge_duplicate_customer_phones.sql
--
-- Take a backup first (pg_dump). Nothing is deleted. For each number with
-- exactly one 9-digit row and one "252" + 9-digit row:
--  - the "252..." row is kept: it is the account the Customer App signs in
--    to (it sends "252" + 9 digits) and the one every lookup now picks;
--  - every row in every table that references the other customer (orders,
--    points history, notifications, devices, ...; found from the foreign
--    keys, so a table added later is covered too) is moved to the kept
--    customer, one row at a time. A row that can't move because the kept
--    customer already has its unique counterpart (the same device, a
--    prediction for the same match, a second open support chat, ...)
--    stays where it is and is listed;
--  - the kept customer gains the other row's points, and its PIN, password,
--    name, email and referrer where it has none;
--  - the other row stays, blocked, with its sessions ended and its phone
--    changed to "merged:<kept id>:<old phone>", so no number reaches it.
-- Any other shape (3 rows, two 9-digit rows, ...) is left alone and listed.
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE merge_report (
  phone_last4 TEXT, kept_id UUID, merged_id UUID, item TEXT, moved INTEGER, left_behind INTEGER
) ON COMMIT DROP;

DO $$
DECLARE
  g RECORD;
  keep_row customers%ROWTYPE;
  drop_row customers%ROWTYPE;
  fk RECORD;
  ids TID[];
  t TID;
  moved INTEGER;
  left_behind INTEGER;
BEGIN
  FOR g IN
    SELECT regexp_replace(regexp_replace(phone, '\D', '', 'g'), '^252(\d{9})$', '\1') AS n,
           array_agg(id ORDER BY created_at) AS ids, count(*) AS c
      FROM customers
     GROUP BY 1 HAVING count(*) > 1
  LOOP
    IF g.c <> 2
       OR (SELECT count(*) FROM customers WHERE id = ANY(g.ids) AND phone = '252' || g.n) <> 1
       OR (SELECT count(*) FROM customers WHERE id = ANY(g.ids) AND phone = g.n) <> 1 THEN
      INSERT INTO merge_report VALUES (right(g.n, 4), NULL, NULL, 'SKIPPED: not one 9-digit + one 252 row, merge by hand', NULL, NULL);
      CONTINUE;
    END IF;
    SELECT * INTO keep_row FROM customers WHERE id = ANY(g.ids) AND phone = '252' || g.n;
    SELECT * INTO drop_row FROM customers WHERE id = ANY(g.ids) AND phone = g.n;

    -- Free the old row's phone first, so nothing can match it any more.
    UPDATE customers SET phone = 'merged:' || keep_row.id || ':' || drop_row.phone, status = 'blocked'
     WHERE id = drop_row.id;

    FOR fk IN
      SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'customers'::regclass
       ORDER BY 1, 2
    LOOP
      EXECUTE format('SELECT array_agg(ctid) FROM %s WHERE %I = $1', fk.tbl, fk.col) INTO ids USING drop_row.id;
      CONTINUE WHEN ids IS NULL;
      moved := 0; left_behind := 0;
      FOREACH t IN ARRAY ids LOOP
        BEGIN
          -- Never make the kept customer its own referrer / friend.
          IF fk.tbl = 'customers' THEN
            EXECUTE format('UPDATE customers SET %I = $1 WHERE ctid = $2 AND id <> $1', fk.col) USING keep_row.id, t;
          ELSE
            EXECUTE format('UPDATE %s SET %I = $1 WHERE ctid = $2', fk.tbl, fk.col) USING keep_row.id, t;
          END IF;
          moved := moved + 1;
        EXCEPTION WHEN unique_violation OR check_violation THEN
          left_behind := left_behind + 1;
        END;
      END LOOP;
      INSERT INTO merge_report VALUES (right(g.n, 4), keep_row.id, drop_row.id, fk.tbl || '.' || fk.col, moved, left_behind);
    END LOOP;

    UPDATE customers SET
      macaash_points = macaash_points + drop_row.macaash_points,
      pin_hash = COALESCE(pin_hash, drop_row.pin_hash),
      password_hash = COALESCE(password_hash, drop_row.password_hash),
      name = COALESCE(name, drop_row.name),
      email = COALESCE(email, drop_row.email),
      referred_by_customer_id = COALESCE(referred_by_customer_id, NULLIF(drop_row.referred_by_customer_id, keep_row.id))
     WHERE id = keep_row.id;
    -- The points now live on the kept customer (their history moved with
    -- macaash_transactions above).
    UPDATE customers SET macaash_points = 0 WHERE id = drop_row.id;
    UPDATE refresh_tokens SET revoked = true, rotated_at = NULL WHERE subject_id = drop_row.id::text AND revoked = false;

    INSERT INTO merge_report VALUES (right(g.n, 4), keep_row.id, drop_row.id,
      format('points %s + %s; pin %s; password %s', keep_row.macaash_points, drop_row.macaash_points,
             CASE WHEN keep_row.pin_hash IS NOT NULL THEN 'kept' WHEN drop_row.pin_hash IS NOT NULL THEN 'copied' ELSE 'none' END,
             CASE WHEN keep_row.password_hash IS NOT NULL THEN 'kept' WHEN drop_row.password_hash IS NOT NULL THEN 'copied' ELSE 'none' END),
      NULL, NULL);
  END LOOP;
END $$;

SELECT phone_last4, item, moved, left_behind FROM merge_report ORDER BY phone_last4, item;
SELECT count(*) AS numbers_still_duplicated FROM (
  SELECT regexp_replace(regexp_replace(phone, '\D', '', 'g'), '^252(\d{9})$', '\1') FROM customers GROUP BY 1 HAVING count(*) > 1
) d;

\if :{?apply}
COMMIT;
\echo 'APPLIED. Now run migration 125 again to create the unique index.'
\else
ROLLBACK;
\echo 'DRY RUN: nothing was changed. Run again with -v apply=1 to apply.'
\endif

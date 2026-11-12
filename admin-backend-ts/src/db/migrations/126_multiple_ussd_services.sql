-- Multiple menu (interactive) USSD services, created from the dashboard
-- (POST /admin/interactive-services), each with its own first code, menu
-- steps, packages and on/off switch.
--
-- Additive only. Nothing existing is changed: Somtel Dhameys Plus (made by
-- migration 118) keeps its template, packages, category and settings, and
-- every order keeps the menu plan it was created with (orders.ussd_plan).
-- Safe to run more than once.

-- 1. A service's own category -------------------------------------------------
-- A service made from the dashboard owns one service category (its on/off
-- switch, and where its packages are filed), recorded here by slug. NULL =
-- a service from before this migration (Dhameys Plus), whose category is
-- still found from its packages exactly as before.
ALTER TABLE ussd_templates ADD COLUMN IF NOT EXISTS menu_category_slug TEXT;

-- 2. One active package per menu option, per service --------------------------
-- The dashboard and API already refuse a second active package on the same
-- menu option of the same menu service (two packages on one option would
-- buy the same carrier package). This repeats that rule in the database so
-- no route, race or duplicate can break it. It only looks at rows whose
-- active flag, option or service is being written, so existing rows are
-- never re-checked and unrelated updates (prices, counters) are untouched.
CREATE OR REPLACE FUNCTION packages_unique_menu_option() RETURNS trigger AS $$
DECLARE
  clash TEXT;
BEGIN
  IF NEW.active IS NOT TRUE OR NEW.ussd_template_id IS NULL OR COALESCE(TRIM(NEW.code), '') = '' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ussd_templates t
     WHERE t.id = NEW.ussd_template_id
       AND t.dial_mode = 'interactive'
       AND t.reply_steps @> '[{"reply": "{packageCode}"}]'::jsonb
  ) THEN
    RETURN NEW;
  END IF;
  SELECT p.name INTO clash
    FROM packages p
   WHERE p.ussd_template_id = NEW.ussd_template_id
     AND p.active
     AND TRIM(p.code) = TRIM(NEW.code)
     AND p.id <> NEW.id
   LIMIT 1;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'Menu option % is already used by "%" in this USSD service.', TRIM(NEW.code), clash
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'packages_unique_menu_option';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_packages_unique_menu_option ON packages;
CREATE TRIGGER trg_packages_unique_menu_option
  BEFORE INSERT OR UPDATE OF active, code, ussd_template_id ON packages
  FOR EACH ROW EXECUTE PROCEDURE packages_unique_menu_option();

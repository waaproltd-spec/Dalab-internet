-- Somtel Dhameys Plus, and interactive (menu-driven) USSD for packages.
--
-- Until now every package was delivered by one one-shot dial string
-- (ussd_templates.ussd_code, e.g. *831*{number}*{amountSplit}*{pin}#).
-- Somtel's Dhameys Plus is only reachable through its menu:
--   *101#  ->  4 (Dhameys Plus)  ->  package option  ->  2 (for another
--   number)  ->  receiver number  ->  eDahab PIN
-- so a template can now be 'interactive': ussd_code is the first dial and
-- reply_steps the ordered replies, each with checks the Agent App runs on
-- the carrier's screen before replying (e.g. the package option really is
-- the expected price, and the final screen shows the right amount and
-- number before the PIN is sent).
--
-- Additive only: no existing row is changed or deleted, every existing
-- template stays 'one_shot', and every existing package keeps its exact
-- behavior (all new package columns default to today's behavior). Safe to
-- run more than once -- nothing is duplicated on a re-run.

-- 1. Templates ---------------------------------------------------------------

ALTER TABLE ussd_templates ADD COLUMN IF NOT EXISTS dial_mode TEXT NOT NULL DEFAULT 'one_shot';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ussd_templates_dial_mode_check') THEN
    ALTER TABLE ussd_templates ADD CONSTRAINT ussd_templates_dial_mode_check CHECK (dial_mode IN ('one_shot', 'interactive'));
  END IF;
END $$;
-- [{ "reply": "4" | "{packageCode}" | "{number}" | "{pin}" | digits,
--    "expect": ["text", ...],          -- all must appear on the screen
--    "checkMenuPrice": bool,           -- the line "<reply>. $x" must show the package price
--    "checkAmount": bool,              -- the screen must show the package price
--    "checkNumber": bool }]            -- the screen must show the receiver number
ALTER TABLE ussd_templates ADD COLUMN IF NOT EXISTS reply_steps JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Words in the carrier's final message that confirm success (in addition
-- to the Agent App's built-in list). Unknown text is never success.
ALTER TABLE ussd_templates ADD COLUMN IF NOT EXISTS success_keywords TEXT[] NOT NULL DEFAULT '{}';

-- 2. Packages ----------------------------------------------------------------

ALTER TABLE packages ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS visible_customer_app BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS visible_agent_app BOOLEAN NOT NULL DEFAULT true;
-- false = shown but "temporarily unavailable": no new orders.
ALTER TABLE packages ADD COLUMN IF NOT EXISTS orders_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION packages_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_packages_touch_updated_at ON packages;
CREATE TRIGGER trg_packages_touch_updated_at
  BEFORE UPDATE ON packages
  FOR EACH ROW EXECUTE PROCEDURE packages_touch_updated_at();

-- 3. Orders: how the order is dialed, and the package as it was sold --------

ALTER TABLE orders ADD COLUMN IF NOT EXISTS ussd_dial_mode TEXT;
-- The rendered menu plan for an interactive order: first dial + replies +
-- checks. The PIN is NEVER stored here -- the PIN reply is the literal
-- "{pin}" token; the Agent App fetches the PIN only at that step.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ussd_plan JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_name_snapshot TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_validity_snapshot TEXT;

-- Frozen at creation (like send_count/list_price), so renaming a package
-- later never rewrites what an existing order was sold as.
CREATE OR REPLACE FUNCTION orders_copy_package_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW.package_name_snapshot IS NULL OR NEW.package_validity_snapshot IS NULL THEN
    SELECT COALESCE(NEW.package_name_snapshot, p.name), COALESCE(NEW.package_validity_snapshot, p.validity)
      INTO NEW.package_name_snapshot, NEW.package_validity_snapshot
      FROM packages p WHERE p.id = NEW.package_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_orders_copy_package_snapshot ON orders;
CREATE TRIGGER trg_orders_copy_package_snapshot
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE PROCEDURE orders_copy_package_snapshot();

-- 4. Somtel Dhameys Plus (only when the Somtel company exists) --------------
-- The seven packages start INACTIVE: an Agent App older than this release
-- can't drive a menu, so an admin turns them on (Admin > Dhameys Plus) once
-- every agent phone runs the new app and has Automated USSD enabled.

DO $$
DECLARE
  tpl_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = 'somtel') THEN
    RETURN;
  END IF;

  INSERT INTO service_categories (id, company_id, slug, name, status, service_types)
  VALUES (gen_random_uuid(), 'somtel', 'dhameys-plus', 'Dhameys Plus', 'enabled', ARRAY['data'])
  ON CONFLICT (company_id, slug) DO NOTHING;

  SELECT id INTO tpl_id FROM ussd_templates
   WHERE company_id = 'somtel' AND dial_mode = 'interactive' AND LOWER(service_name) = 'dhameys plus'
   LIMIT 1;
  IF tpl_id IS NULL THEN
    tpl_id := gen_random_uuid();
    INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status, notes, dial_mode, reply_steps, success_keywords)
    VALUES (
      tpl_id, 'somtel', 'Dhameys Plus', '*101#', 'enabled',
      'Somtel menu: *101# > 4 Dhameys Plus > package > 2 Ugu Shub Qof Kale > number > eDahab PIN',
      'interactive',
      '[
        {"reply": "4", "expect": ["Dhameys"]},
        {"reply": "{packageCode}", "expect": ["Dhameys"], "checkMenuPrice": true},
        {"reply": "2", "expect": ["Qof Kale"]},
        {"reply": "{number}", "expect": ["lambarka"]},
        {"reply": "{pin}", "expect": ["PIN"], "checkAmount": true, "checkNumber": true}
      ]'::jsonb,
      ARRAY['guuleysatay', 'guulaysatay', 'ugu shubto']
    );
  END IF;

  INSERT INTO packages (id, company_id, category_id, name, price, provider_amount, mb, minutes, sms, validity, active, code, ussd_template_id, sort_order, description)
  SELECT gen_random_uuid(), 'somtel', 'dhameys-plus', v.name, v.price, v.price, 0, 0, 0, v.validity, false, v.code, tpl_id, v.sort_order, v.description
    FROM (VALUES
      ('Dhameys Plus — 6 Hours',     0.20::numeric,  '6 hours',  '1', 1, 'Unlimited data & calls for 6 hours'),
      ('Dhameys Plus — 12 Hours',    0.35::numeric,  '12 hours', '2', 2, 'Unlimited data & calls for 12 hours'),
      ('Dhameys Plus — Daily',       0.50::numeric,  '24 hours', '3', 3, 'Unlimited data & calls for 24 hours'),
      ('Dhameys Plus — 48 Hours',    1.00::numeric,  '48 hours', '4', 4, 'Unlimited data & calls for 48 hours'),
      ('Dhameys Plus — Weekly',      3.40::numeric,  '7 days',   '5', 5, 'Unlimited data & calls for 7 days'),
      ('Dhameys Plus — 15 Days',     7.50::numeric,  '15 days',  '6', 6, 'Unlimited data & calls for 15 days'),
      ('Dhameys Plus — Monthly Plus', 15.00::numeric, 'Monthly',  '7', 7, 'Unlimited data & calls for a month')
    ) AS v(name, price, validity, code, sort_order, description)
   WHERE NOT EXISTS (
     SELECT 1 FROM packages p
      WHERE p.company_id = 'somtel' AND p.category_id = 'dhameys-plus' AND p.code = v.code
   );
END $$;

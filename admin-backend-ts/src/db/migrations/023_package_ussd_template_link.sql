-- Real ID-based link between a package and the USSD template that fulfills
-- it, replacing (for migrated packages) generateUssdForOrder's fragile
-- free-text service_name<->package.name matching -- the confirmed root
-- cause of orders (e.g. Amtel "Unlimited Data & Voice") getting stuck
-- in_progress forever with "No enabled USSD template matches...".
--
-- Many packages -> one template (a template's ussd_code pattern is reused
-- across several package tiers of the same provider, differing only in
-- {amount}/{packageCode} substituted per-order from the package/order, never
-- from the template) -- so the FK lives on packages, not ussd_templates.
-- Nullable + ON DELETE SET NULL: deleting a template must not corrupt/orphan
-- a package row -- it just reverts that package to the legacy name-matching
-- fallback (or "no template", surfaced by GET /admin/packages/missing-template).
ALTER TABLE packages ADD COLUMN IF NOT EXISTS ussd_template_id UUID REFERENCES ussd_templates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_packages_ussd_template_id ON packages(ussd_template_id);

-- One-time best-effort backfill pass 1: auto-link a package to its matching
-- template using the SAME precedence generateUssdForOrder already applies
-- (exact case-insensitive service_name = package.name), but only when
-- exactly one enabled template for that company matches -- ambiguous cases
-- are deliberately left NULL for manual review via the missing-template
-- endpoint rather than silently guessing a winner.
UPDATE packages p
SET ussd_template_id = matched.template_id
FROM (
  SELECT p2.id AS package_id, (array_agg(t.id))[1] AS template_id
  FROM packages p2
  JOIN ussd_templates t
    ON t.company_id = p2.company_id
   AND t.status = 'enabled'
   AND LOWER(t.service_name) = LOWER(p2.name)
  GROUP BY p2.id
  HAVING COUNT(*) = 1
) AS matched
WHERE p.id = matched.package_id AND p.ussd_template_id IS NULL;

-- Backfill pass 2: substring fallback (service_name is a substring of the
-- package name), only for packages pass 1 left NULL, and only when exactly
-- one enabled template qualifies -- same ambiguity guard as pass 1.
UPDATE packages p
SET ussd_template_id = matched.template_id
FROM (
  SELECT p2.id AS package_id, (array_agg(t.id))[1] AS template_id
  FROM packages p2
  JOIN ussd_templates t
    ON t.company_id = p2.company_id
   AND t.status = 'enabled'
   AND p2.ussd_template_id IS NULL
   AND POSITION(LOWER(t.service_name) IN LOWER(p2.name)) > 0
  GROUP BY p2.id
  HAVING COUNT(*) = 1
) AS matched
WHERE p.id = matched.package_id AND p.ussd_template_id IS NULL;

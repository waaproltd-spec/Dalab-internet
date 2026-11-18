-- Category order set by the Admin (Categories: move up / move down). The
-- Customer App shows categories in this order on Home, offline Rukumo and
-- the category screen (packages are listed category by category in it).
-- Backfilled with today's order (by slug, which is how packages were
-- listed), so nothing changes until an admin reorders.
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS sort_order INTEGER;
UPDATE service_categories sc SET sort_order = r.n
  FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY slug) AS n FROM service_categories) r
 WHERE sc.id = r.id AND sc.sort_order IS NULL;
ALTER TABLE service_categories ALTER COLUMN sort_order SET DEFAULT 0;
UPDATE service_categories SET sort_order = 0 WHERE sort_order IS NULL;
ALTER TABLE service_categories ALTER COLUMN sort_order SET NOT NULL;

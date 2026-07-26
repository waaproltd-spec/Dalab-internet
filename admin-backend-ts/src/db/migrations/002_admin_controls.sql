-- DALAB INTERNET — Super Admin full-control additions
-- Adds: per-admin configurable permissions, company app-visibility flags,
-- a first-class service-categories management table, agent<->company
-- scoping, and an order-reversal marker. Applied after 001_init.sql via
-- `npm run migrate` (see src/db/migrate.ts) — every statement is safe to
-- re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS visible_customer_app BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS visible_agent_app BOOLEAN NOT NULL DEFAULT true;

-- A management-only lookup table for "Service Categories" — deliberately NOT
-- a foreign key target for packages.category_id: category slugs are reused
-- across companies already (e.g. "unlimited-data-voice" for both Somtel and
-- Amtel), so identity here is scoped by (company_id, slug), and package
-- create/edit validates against this table in application code rather than
-- a DB constraint, so existing package rows never need to be touched.
CREATE TABLE IF NOT EXISTS service_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug)
);

-- Backfill one category row per distinct (company_id, category_id) pair
-- already present in packages, so existing packages immediately have a
-- matching manageable category instead of Super Admin needing to recreate
-- them from scratch.
INSERT INTO service_categories (company_id, slug, name)
SELECT DISTINCT company_id, category_id,
  initcap(replace(replace(category_id, '-', ' '), '_', ' '))
FROM packages
ON CONFLICT (company_id, slug) DO NOTHING;

-- Which companies an agent is scoped to for sales/orders. No rows for a
-- given agent = unrestricted (matches today's behavior exactly), so this is
-- backward compatible until an admin actually assigns companies.
CREATE TABLE IF NOT EXISTS agent_company_assignments (
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, company_id)
);

-- Marks an order as internally reversed (bookkeeping only — see
-- POST /admin/orders/:id/reverse — there is no real payment gateway here to
-- call for an actual refund).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

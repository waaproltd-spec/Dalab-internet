-- Real companies almost always have packages/orders referencing them, so the
-- existing hard DELETE (blocked by ON DELETE RESTRICT) never actually
-- succeeds for any of the 4 live providers — it just returns a 409 every
-- time. Add a soft-delete column: a company with history stays intact (so
-- existing orders/reports still resolve its name via a join) but disappears
-- from every company listing — public, admin, and everything sourced from
-- those listings (package/category dropdowns, provider selects, etc.).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

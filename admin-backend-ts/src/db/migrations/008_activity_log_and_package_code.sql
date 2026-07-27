-- Records every change to Super-Admin-controlled payment-gateway/USSD-template
-- configuration: who changed it, when, and the before/after values — the
-- Activity Log the dashboard's Payment Gateway and USSD Template sections need.
-- Not a general audit trail for every admin action in the system (that would
-- be a much bigger change) — scoped to the config surfaces this covers today.
CREATE TABLE IF NOT EXISTS admin_activity_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  old_value     JSONB,
  new_value     JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_activity_log_created_at ON admin_activity_log(created_at DESC);

-- Optional package/product code some providers' USSD templates need as its
-- own placeholder (previously always baked directly into the template
-- string, e.g. "*914*..." — this makes it swappable via {packageCode}
-- without editing the whole template when a provider's code changes).
ALTER TABLE packages ADD COLUMN IF NOT EXISTS code TEXT;

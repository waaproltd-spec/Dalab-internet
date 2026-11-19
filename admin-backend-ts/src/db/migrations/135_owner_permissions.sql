-- Owner / Admin / Agent permissions.
-- Each agent's services are granted by the Owner (super_admin) only
-- (agents.services; see src/auth/access.ts). Existing agents keep exactly
-- what they can do today: every service, with "operations" and "ciyaaraha"
-- following their current switches. A new agent starts with no services
-- until the Owner grants them (the phone's automatic SMS/USSD work never
-- depends on services).
-- Every grant and revoke, of an Admin's permissions or an Agent's services,
-- is kept in permission_audit: who, whom, what, when.
-- Idempotent: safe to replay on every deploy.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS services TEXT[];

UPDATE agents
   SET services = ARRAY['sales','customers','registration','schedule','transactions','balances','reports',
                        'exchange','shop','vip_numbers','promo_ads','other_agents']
                  || CASE WHEN operations_enabled THEN ARRAY['operations'] ELSE ARRAY[]::TEXT[] END
                  || CASE WHEN ciyaaraha_enabled THEN ARRAY['ciyaaraha'] ELSE ARRAY[]::TEXT[] END
 WHERE services IS NULL;

ALTER TABLE agents ALTER COLUMN services SET DEFAULT '{}';
ALTER TABLE agents ALTER COLUMN services SET NOT NULL;

CREATE TABLE IF NOT EXISTS permission_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id      UUID,                 -- the admin_users row that made the change (NULL = Admin Hub sync)
  actor_label   TEXT NOT NULL,        -- email / "Admin Hub", kept even if the account is deleted later
  source        TEXT NOT NULL,        -- 'dashboard' | 'admin_hub'
  target_type   TEXT NOT NULL CHECK (target_type IN ('admin', 'agent')),
  target_id     UUID NOT NULL,
  target_label  TEXT NOT NULL,
  granted       TEXT[] NOT NULL DEFAULT '{}',
  revoked       TEXT[] NOT NULL DEFAULT '{}',
  role_before   TEXT,
  role_after    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_permission_audit_created ON permission_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_permission_audit_target ON permission_audit(target_type, target_id, created_at DESC);
ALTER TABLE agents ALTER COLUMN operations_enabled SET DEFAULT false;

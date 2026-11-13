-- Maintenance Notices for the AGENT APP: admin-written announcements
-- (maintenance, info, warning) with an optional scheduled start and end.
-- Agents see every enabled notice that hasn't ended. Idempotent.
CREATE TABLE IF NOT EXISTS agent_notices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'maintenance' CHECK (kind IN ('maintenance', 'info', 'warning')),
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_agent_notices_live ON agent_notices (enabled, ends_at);

-- "Today" figures for agents read orders and dial attempts by day.
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_ussd_dial_attempts_agent_created ON ussd_dial_attempts (agent_id, created_at);

-- Push notification device tokens for the native Agent App (agents table
-- logins only, role='agent' -- Admin Dashboard staff use the browser, which
-- has no FCM token to register). Mirrors customer_device_tokens (migration
-- 050) exactly: one row per app install/token, globally unique so a token
-- refresh or a different agent logging into the same device just moves the
-- row rather than creating a duplicate -- see the ON CONFLICT upsert in
-- notifications.routes.ts.
CREATE TABLE IF NOT EXISTS agent_device_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  fcm_token    TEXT NOT NULL UNIQUE,
  platform     TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_device_tokens_agent ON agent_device_tokens(agent_id);

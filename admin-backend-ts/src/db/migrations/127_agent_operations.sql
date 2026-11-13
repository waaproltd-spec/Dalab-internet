-- Agent operations (WAAPRO LTD AGENT app): an authorized agent runs the
-- daily order workflow (approve / reject payments, cancel, retry, reverse)
-- without an admin. Admins can switch an agent's operational access off;
-- every agent action is written to the Activity Log with the agent's id.
-- Idempotent: safe to replay on every deploy.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS operations_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_admin_activity_log_agent ON admin_activity_log(agent_id, created_at DESC) WHERE agent_id IS NOT NULL;

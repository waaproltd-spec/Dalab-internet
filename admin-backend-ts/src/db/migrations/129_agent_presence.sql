-- Other Agents (AGENT APP): when each agent was last connected. Written by
-- the server from every authenticated agent request and the open live
-- order connection; an agent seen in the last few minutes is ONLINE.
-- Reuses the agents table -- no new table. Idempotent.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents (last_seen_at);

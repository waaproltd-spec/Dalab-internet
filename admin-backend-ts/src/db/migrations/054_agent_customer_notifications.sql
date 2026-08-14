-- Lets an Agent (not just Admin/Super Admin) send a customer notification
-- through the same POST /admin/notifications/send endpoint the Admin
-- Dashboard's Notifications page already uses, instead of building a
-- parallel send/inbox system for the Agent App. sent_by_admin_id's existing
-- FK to admin_users(id) can't hold an agent's id (a different table/id
-- space), so a sibling column is added rather than repurposing that one.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_sent_by_agent_id ON notifications (sent_by_agent_id) WHERE sent_by_agent_id IS NOT NULL;

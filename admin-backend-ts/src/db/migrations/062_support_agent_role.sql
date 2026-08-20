-- Broadens "who can handle an Agent Support conversation" from Admin
-- Dashboard staff only (admin_users, support.manage permission) to also
-- include native Agent App field agents (the `agents` table -- device-based
-- login, no per-agent permission toggle the way admin_users.permissions
-- has; any online field agent may claim a waiting customer, same as any
-- online staff member could before). A single FK can't reference either of
-- two different tables, so each id column keeps its existing name (avoiding
-- a non-idempotent rename) and gains a sibling *_role column that says which
-- table it actually points at; the FK constraint against admin_users is
-- dropped since the column can now legitimately hold an agents.id too.
-- Referential integrity for the agent case is enforced in application code
-- (every write path already looks up the row by req.auth before writing),
-- the same tradeoff already accepted elsewhere for polymorphic references.

ALTER TABLE support_conversations DROP CONSTRAINT IF EXISTS support_conversations_agent_id_fkey;
ALTER TABLE support_conversations ADD COLUMN IF NOT EXISTS agent_role TEXT CHECK (agent_role IN ('admin','agent'));

ALTER TABLE support_messages DROP CONSTRAINT IF EXISTS support_messages_sender_admin_id_fkey;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS sender_role TEXT CHECK (sender_role IN ('admin','agent'));
UPDATE support_messages SET sender_role = 'admin' WHERE sender_admin_id IS NOT NULL AND sender_role IS NULL;

ALTER TABLE support_agent_status DROP CONSTRAINT IF EXISTS support_agent_status_admin_id_fkey;
ALTER TABLE support_agent_status ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'admin' CHECK (actor_role IN ('admin','agent'));

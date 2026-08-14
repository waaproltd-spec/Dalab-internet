-- Customer support: an in-app AI-first help chat that escalates to a real
-- Agent or Admin when the deterministic Somali intent-matcher (see
-- src/support/supportAi.ts) can't confidently answer. The AI phase itself
-- is stateless server-side (no LLM call, no per-message cost) -- nothing is
-- persisted here until a customer actually escalates, at which point the
-- AI Q&A exchanged so far is carried into the ticket's first messages so
-- whoever picks it up has full context.

CREATE TABLE IF NOT EXISTS support_tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number     TEXT NOT NULL UNIQUE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  queue             TEXT NOT NULL CHECK (queue IN ('agent','admin')),
  status            TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','in_progress','resolved')),
  subject           TEXT NOT NULL,
  assigned_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  assigned_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at       TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Queue-position math (see support.routes.ts) orders 'waiting' tickets in
-- the same queue oldest-first, so this index covers exactly that query.
CREATE INDEX IF NOT EXISTS idx_support_tickets_queue ON support_tickets(queue, status, created_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer_id ON support_tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_agent_id ON support_tickets(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_admin_id ON support_tickets(assigned_admin_id);

CREATE TABLE IF NOT EXISTS support_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer','ai','agent','admin','system')),
  sender_id   UUID,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_id ON support_messages(ticket_id, created_at);

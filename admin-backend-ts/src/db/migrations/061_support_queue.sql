-- Real-time Agent Support queue: a customer's request lives as one
-- support_conversations row that moves through a small state machine --
-- 'queued' (live FIFO position shown to the customer, capped at 1 hour),
-- 'pending' (no live position -- either no agent was online when the
-- customer started, or a 'queued' row aged past the 1-hour cap; the
-- customer sees "an agent will respond when available" instead of a
-- position), 'assigned' (actively being handled by exactly one agent),
-- 'resolved' / 'closed' (done). 'queued' and 'pending' are both eligible
-- for the same atomic claim-next query, ordered by created_at, so a
-- request that left a message while every agent was offline is never
-- treated unfairly once an agent comes online -- true FIFO by original
-- request time regardless of which of the two waiting statuses it's in.
CREATE TABLE IF NOT EXISTS support_conversations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                 UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  topic                       TEXT NOT NULL DEFAULT 'agent_support'
                                CHECK (topic IN ('dalab_internet','payment_services','agent_support')),
  status                      TEXT NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued','pending','assigned','resolved','closed')),
  agent_id                    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  agent_offline_at_start      BOOLEAN NOT NULL DEFAULT false,
  assigned_at                 TIMESTAMPTZ,
  resolved_at                 TIMESTAMPTZ,
  closed_at                   TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The claim-next query filters on status and orders by created_at across
-- the whole table (queued+pending are always a small live set), and the
-- customer/agent detail lookups filter by their own id -- both covered.
CREATE INDEX IF NOT EXISTS idx_support_conversations_status_created ON support_conversations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_support_conversations_customer ON support_conversations(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_conversations_agent ON support_conversations(agent_id);
-- Enforces "one active conversation per customer at a time" the same way
-- every idempotency key elsewhere in this codebase is enforced -- a DB
-- constraint, not just app-level discipline, so a retried/duplicate
-- "start support" request from a flaky connection can never create two
-- open conversations for the same customer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_conversations_one_open_per_customer
  ON support_conversations(customer_id)
  WHERE status IN ('queued','pending','assigned');

CREATE TABLE IF NOT EXISTS support_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_type      TEXT NOT NULL CHECK (sender_type IN ('customer','agent','system')),
  sender_admin_id  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  body             TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(conversation_id, created_at);

-- One row per admin who has ever toggled support status -- "online" is the
-- single source of truth the claim-next query and the "agent went offline
-- mid-conversation" reassignment both read/write; never trust a client's
-- own idea of whether it's online.
CREATE TABLE IF NOT EXISTS support_agent_status (
  admin_id     UUID PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  online       BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

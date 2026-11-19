-- Agent Customer Registration: an agent registers a customer (name, payment
-- sender, internet receiver, network). The customer's Rukumo setup
-- (customers.offline_*) is saved, and which agent registered them.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS registered_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS registered_by_agent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_customers_registered_by_agent ON customers(registered_by_agent_id) WHERE registered_by_agent_id IS NOT NULL;

-- A payment from a registered customer that could not become an order (no
-- service at that amount, network offline, ...): kept open until an admin
-- resolves it; the internet is never sent for it. One row per transaction.
CREATE TABLE IF NOT EXISTS agent_registration_payment_issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  sender_phone    TEXT,
  amount          NUMERIC(12,2),
  transaction_ref TEXT,
  reason          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_reg_issue_tx ON agent_registration_payment_issues(customer_id, transaction_ref) WHERE transaction_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_reg_issue_open ON agent_registration_payment_issues(agent_id) WHERE resolved_at IS NULL;

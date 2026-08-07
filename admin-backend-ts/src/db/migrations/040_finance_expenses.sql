-- "Other Money Out" for the Financial Overview: real, admin-entered money
-- movements that aren't the cost of a data/package order (e.g. a SIM top-up
-- paid in cash, a refund actually wired to a customer, staff costs). No
-- other table tracks money leaving the system outside of what's paid to
-- providers for data (orders.provider_amount), so without this the Overview
-- would have to pretend that number is $0.
CREATE TABLE IF NOT EXISTS finance_expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  category      TEXT NOT NULL,
  note          TEXT,
  created_by    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_created_at ON finance_expenses(created_at DESC);

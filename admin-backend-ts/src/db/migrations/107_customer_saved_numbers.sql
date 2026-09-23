-- "My Numbers": lets a customer save any number of phone numbers, each
-- tagged with which carrier/wallet it belongs to (provider_key matches
-- payment_wallets.id / PHONE_COMPANIES exactly, same validation rules as
-- everywhere else -- see phoneValidation.ts), to reuse when placing an
-- Internet Store order instead of retyping the destination number every
-- time. Deliberately separate from and unrelated to the existing
-- evc_plus_number/edahab_number columns on customers (044_customer_wallet_
-- numbers.sql) -- that's a narrower, Money-Exchange-only feature with its
-- own 2-hour edit lock; this is a general-purpose address book scoped to
-- Internet purchases only, with no such lock.
CREATE TABLE IF NOT EXISTS customer_saved_numbers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone          TEXT NOT NULL,
  provider_key   TEXT NOT NULL,
  label          TEXT,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_saved_numbers_customer ON customer_saved_numbers(customer_id);

-- At most one default per customer, enforced here rather than only in app
-- logic, so a race between two "set as default" requests can never leave
-- two numbers both marked default at once -- a partial unique index, since
-- plenty of rows legitimately have is_default = false at the same time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_saved_numbers_one_default
  ON customer_saved_numbers(customer_id) WHERE is_default;

-- Per-company payment methods (e.g. Hormuud's own EVC Plus, eDahab, and
-- JEEB collection numbers), each with its own USSD dial template. This is
-- deliberately scoped to the company whose package is being purchased —
-- unlike payment_wallets (a global, intentionally cross-company "pay via
-- any provider's wallet" list, see 010_payment_wallets.sql), this table
-- answers "which of THIS company's own payment methods does the customer
-- want to pay with," each generating its own correct USSD code.
--
-- companies.payment_number/payment_ussd_template (single columns) remain the
-- legacy fallback for any company with zero rows here — the Customer App
-- keeps working exactly as before until an admin adds per-method entries.
CREATE TABLE IF NOT EXISTS company_payment_methods (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  method         TEXT NOT NULL,
  label          TEXT NOT NULL,
  payment_number TEXT,
  ussd_template  TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, method)
);

CREATE INDEX IF NOT EXISTS idx_company_payment_methods_company ON company_payment_methods(company_id);

-- Snapshot of which method's USSD template was handed to the customer at
-- order-creation time, same reasoning as payment_number_used
-- (033_order_payment_number.sql): the method's template can change later,
-- but the receipt / retry-dial should always reflect what was actually
-- shown at checkout.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_ussd_template_used TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method_id TEXT REFERENCES company_payment_methods(id) ON DELETE SET NULL;

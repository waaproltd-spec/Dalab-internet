-- Reseller wholesale-user feature, Stage 2: admin-registered payment
-- numbers. (Originally also introduced a per-company balance table; the
-- product spec was clarified to a single overall reseller wallet balance
-- only, no per-company balances — see reseller_wallets in 048_resellers.sql.
-- Since this branch is unmerged and has no deployed history, that table is
-- simply not created here rather than created-then-dropped in a later
-- migration.)
--
-- reseller_payment_numbers models TWO distinct number roles, confirmed
-- against the product spec: 'receiving' is Dalab's own collection number
-- for a given company, shown to the reseller during Deposit ("send money
-- to this number"); 'sending' is the reseller's own number, registered by
-- Admin, that the reseller uses when paying for/receiving a company order.
-- Kept as one table (not two) since both rows share the same shape and
-- admin-CRUD surface — only the `role` column and how each is surfaced to
-- the app differ. Mirrors company_payment_methods (034_company_payment_
-- methods.sql) in shape and admin-only-write convention.

CREATE TABLE IF NOT EXISTS reseller_payment_numbers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id    UUID NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  role           TEXT NOT NULL DEFAULT 'sending' CHECK (role IN ('sending','receiving')),
  payment_number TEXT NOT NULL,
  label          TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reseller_id, company_id, role)
);
CREATE INDEX IF NOT EXISTS idx_reseller_payment_numbers_reseller ON reseller_payment_numbers(reseller_id);
CREATE INDEX IF NOT EXISTS idx_reseller_payment_numbers_company ON reseller_payment_numbers(company_id);

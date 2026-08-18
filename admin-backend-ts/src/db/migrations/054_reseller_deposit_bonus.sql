-- Reseller Deposit Bonus, managed from Admin -> Resellers -> Payment.
--
-- Deliberately its own table, not the Internet Store's pricing/rate tables
-- (packages, company_payment_methods, etc.) -- per product instruction, the
-- Reseller bonus must never be copied from or wired to the Internet rate
-- system, even though both happen to key off the same `companies` identity
-- table (companies.id/name is just an identity reference here, same as
-- reseller_withdrawals.company_id already uses).
--
-- Deposit only ever offers EVC Plus / eDahab (reseller_deposit_methods, see
-- migration 053), not a company picker -- so each method maps to exactly one
-- company's bonus via bonus_company_id, seeded from the real collection
-- numbers already shared with that company (EVC Plus/610338686 -> Hormuud,
-- eDahab/620338686 -> Somtel). Somnet/Amtel get a configurable percentage
-- too (Admin may want it ready before either gets its own deposit rail) but
-- nothing credits from them until a method maps to them.
CREATE TABLE IF NOT EXISTS reseller_deposit_bonus_config (
  company_id        TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  bonus_percentage  NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (bonus_percentage >= 0 AND bonus_percentage <= 100),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        TEXT
);
INSERT INTO reseller_deposit_bonus_config (company_id, bonus_percentage) VALUES
  ('hormuud', 15),
  ('somtel', 20),
  ('somnet', 10),
  ('amtel', 5)
ON CONFLICT (company_id) DO NOTHING;

ALTER TABLE reseller_deposit_methods ADD COLUMN IF NOT EXISTS bonus_company_id TEXT REFERENCES companies(id);
UPDATE reseller_deposit_methods SET bonus_company_id = 'hormuud' WHERE method = 'evc' AND bonus_company_id IS NULL;
UPDATE reseller_deposit_methods SET bonus_company_id = 'somtel' WHERE method = 'edahab' AND bonus_company_id IS NULL;

-- Snapshotted onto the deposit row at verify time (the moment the wallet is
-- actually credited, same instant as the existing status flip to
-- 'verified') so a later Admin change to reseller_deposit_bonus_config never
-- alters a transaction that already happened -- "previous transactions must
-- remain unchanged and keep the percentage that was applied when they were
-- processed" (product instruction). No production reseller_deposits rows
-- exist yet, so these are plain additive columns, no backfill needed.
ALTER TABLE reseller_deposits ADD COLUMN IF NOT EXISTS bonus_company_id TEXT REFERENCES companies(id);
ALTER TABLE reseller_deposits ADD COLUMN IF NOT EXISTS bonus_percentage NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE reseller_deposits ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE reseller_deposits ADD COLUMN IF NOT EXISTS credited_amount NUMERIC(10,2);

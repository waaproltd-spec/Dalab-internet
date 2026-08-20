-- Reseller Payment config, managed from Admin -> Resellers -> Payment.
--
-- Deposit ("Lacag Ku Shub") switches from "pick a company, use that
-- company's collection number" to "pick a payment method (EVC Plus /
-- eDahab), dial Dalab's own collection number for that method" -- the
-- reseller's wallet has no per-company split (see reseller_wallets), so the
-- deposit side shouldn't have one either. Seeded from the real numbers
-- already live on every company's EVC/eDahab company_payment_methods rows
-- today (610338686/*712*.../620338686/*110*...) so nothing changes for a
-- reseller depositing right after this migration runs; Admin can update
-- either row going forward without touching any company record.
CREATE TABLE IF NOT EXISTS reseller_deposit_methods (
  method          TEXT PRIMARY KEY CHECK (method IN ('evc', 'edahab')),
  label           TEXT NOT NULL,
  payment_number  TEXT NOT NULL,
  ussd_template   TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);
INSERT INTO reseller_deposit_methods (method, label, payment_number, ussd_template)
VALUES
  ('evc', 'EVC Plus', '610338686', '*712*610338686*{amount}#'),
  ('edahab', 'eDahab', '620338686', '*110*620338686*{amount}#')
ON CONFLICT (method) DO NOTHING;

-- reseller_deposits.company_id -> method: no production rows exist for this
-- table yet (the feature only just deployed), so this is a clean structural
-- change rather than a backfill.
ALTER TABLE reseller_deposits DROP CONSTRAINT IF EXISTS reseller_deposits_company_id_fkey;
ALTER TABLE reseller_deposits DROP COLUMN IF EXISTS company_id;
ALTER TABLE reseller_deposits ADD COLUMN IF NOT EXISTS method TEXT REFERENCES reseller_deposit_methods(method);

-- Withdrawal ("Lacag Bixi") stays company-scoped (the reseller picks which
-- ISP's payment rail to pay the customer out through), but sending money
-- OUT needs a different USSD shape than the existing customer-facing
-- payment_ussd_template (receive-only, {amount} only) -- payout substitutes
-- both the destination {number} and {amount}, with each company's own
-- agent/merchant trailing code baked into the template string itself.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payout_ussd_template TEXT;

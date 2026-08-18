-- Reseller Withdraw Rate, managed from Admin -> Resellers -> Payment
-- (Reseller Manager).
--
-- Deposit ("Lacag Ku Shub") is a plain 1:1 credit -- no rate or bonus is
-- ever applied there; the Reseller Wallet receives exactly what the
-- customer sent (product instruction: "Deposit is only for receiving
-- money. No rate or bonus should be applied.").
--
-- Withdraw ("Lacag Bixi") is where the company-specific rate applies: the
-- Reseller Wallet is still deducted by the requested amount, but the
-- customer is sent MORE than that -- rate_percentage% of it -- per
-- company (e.g. Hormuud 115% -> a $100 withdrawal deducts $100 from the
-- wallet but sends the customer $115). Deliberately its own table, not the
-- Internet Store's rate/pricing tables, even though it keys off the same
-- `companies` identity table (just an identity reference, same as
-- reseller_withdrawals.company_id already uses).
CREATE TABLE IF NOT EXISTS reseller_withdrawal_rate_config (
  company_id       TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  rate_percentage  NUMERIC(6,2) NOT NULL DEFAULT 100 CHECK (rate_percentage > 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       TEXT
);
INSERT INTO reseller_withdrawal_rate_config (company_id, rate_percentage) VALUES
  ('hormuud', 115),
  ('somnet', 117),
  ('somtel', 119),
  ('amtel', 120)
ON CONFLICT (company_id) DO NOTHING;

-- Snapshotted onto the withdrawal row at request time -- the same instant
-- the wallet is reserved/deducted, and before the app needs to know the
-- payout USSD dial amount (customer_receives_amount, not the raw wallet
-- amount) -- so a later Admin change to the rate never alters an
-- already-processed withdrawal. No production reseller_withdrawals rows
-- exist yet, so these are plain additive columns, no backfill needed.
ALTER TABLE reseller_withdrawals ADD COLUMN IF NOT EXISTS rate_percentage NUMERIC(6,2) NOT NULL DEFAULT 100;
ALTER TABLE reseller_withdrawals ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE reseller_withdrawals ADD COLUMN IF NOT EXISTS customer_receives_amount NUMERIC(10,2);

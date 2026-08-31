-- Reseller Withdraw Commission, managed from Admin -> Resellers -> Payment
-- (Reseller Manager).
--
-- Deposit ("Lacag Ku Shub") is a plain 1:1 credit -- no commission or bonus
-- is ever applied there; the Reseller Wallet receives exactly what the
-- customer sent, regardless of which payment method (EVC Plus / eDahab)
-- they used (product instruction: "Deposit is only for receiving money...
-- The Deposit payment method does not determine the Withdraw commission.").
--
-- Withdraw ("Lacag Bixi") is where the commission applies, based entirely
-- on the payout company the customer selects at withdrawal time -- the
-- Reseller Wallet is still deducted by the requested amount, but the
-- customer is sent MORE than that: wallet amount + (wallet amount x
-- commission%), per company (e.g. Hormuud 15% -> a $50 withdrawal deducts
-- $50 from the wallet but sends the customer $57.50). Deliberately its own
-- table, not the Internet Store's rate/pricing tables, even though it keys
-- off the same `companies` identity table (just an identity reference, same
-- as reseller_withdrawals.company_id already uses).
CREATE TABLE IF NOT EXISTS reseller_withdrawal_commission_config (
  company_id             TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  commission_percentage  NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (commission_percentage >= 0),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             TEXT
);
INSERT INTO reseller_withdrawal_commission_config (company_id, commission_percentage) VALUES
  ('hormuud', 15),
  ('somnet', 15),
  ('somtel', 15),
  ('amtel', 20)
ON CONFLICT (company_id) DO NOTHING;

-- Snapshotted onto the withdrawal row at request time -- the same instant
-- the wallet is reserved/deducted, and before the app needs to know the
-- payout USSD dial amount (customer_receives_amount, not the raw wallet
-- amount) -- so a later Admin change to a company's commission never alters
-- an already-processed withdrawal. No production reseller_withdrawals rows
-- exist yet, so these are plain additive columns, no backfill needed.
ALTER TABLE reseller_withdrawals ADD COLUMN IF NOT EXISTS commission_percentage NUMERIC(6,2) NOT NULL DEFAULT 0;
ALTER TABLE reseller_withdrawals ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE reseller_withdrawals ADD COLUMN IF NOT EXISTS customer_receives_amount NUMERIC(10,2);

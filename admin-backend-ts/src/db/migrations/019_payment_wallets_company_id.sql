-- payment_wallets.provider_label is free text seeded 1:1 with companies.name
-- by convention only, with zero FK/validation — a typo, a blank value, or a
-- later company rename silently breaks any string-match-based lookup with
-- no error surfaced anywhere. Add a real FK so "which company's payment
-- number does this wallet belong to" is a join, never a string comparison.
-- Nullable — safest for a live table, never blocks on existing rows.
ALTER TABLE payment_wallets ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id);

-- Backfill from the existing provider_label <-> companies.name convention
-- (the same match the customer app currently performs client-side), so no
-- admin action is required for the already-seeded wallets.
UPDATE payment_wallets pw
SET company_id = c.id
FROM companies c
WHERE pw.company_id IS NULL
  AND pw.provider_label IS NOT NULL
  AND lower(c.name) = lower(pw.provider_label);

CREATE INDEX IF NOT EXISTS idx_payment_wallets_company_id ON payment_wallets(company_id);

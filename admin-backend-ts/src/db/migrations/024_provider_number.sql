-- Genuine, independent "Provider Number" — used only in the outgoing USSD
-- request to the telecom provider during order fulfillment. Deliberately
-- separate from companies.payment_number, which is used only for customer
-- payment collection (joined into payment_wallets for the Customer App's
-- checkout dial). The two must never share a column or a write path.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS provider_number TEXT;

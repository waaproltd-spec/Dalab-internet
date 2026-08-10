-- Two additions to the eBadal Money Exchange self-checkout flow:
--
-- 1. Wallet identity + correction window. Each saved wallet (EVC Plus,
--    eDahab) now carries a name alongside its number, and a *_saved_at
--    timestamp recording when it was first saved. customers.routes.ts'
--    PUT /customer/wallet-numbers uses that timestamp to give the customer
--    a fixed 2-hour self-service correction window after the first save;
--    once it's more than 2 hours old, only PUT /admin/customers/:id/wallet-
--    numbers (Super Admin dashboard) can change it. The timestamp is fixed
--    at first-save, not refreshed by later edits within the window.
--
-- 2. Exchange transaction limits. NULL means "use the platform default"
--    ($100/day, $500/month, $2,000/year, enforced in exchange.routes.ts'
--    createExchangeOrder against a rolling sum of that customer's completed
--    exchange_orders in each calendar period); a non-NULL value here is an
--    Admin-set custom limit for that one customer, settable via the new
--    PUT /admin/customers/:id/exchange-limits.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS evc_plus_name TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS evc_plus_saved_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS edahab_name TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS edahab_saved_at TIMESTAMPTZ;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS exchange_daily_limit NUMERIC(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS exchange_monthly_limit NUMERIC(10,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS exchange_yearly_limit NUMERIC(10,2);

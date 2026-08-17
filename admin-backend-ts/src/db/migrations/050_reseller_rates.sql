-- Reseller wholesale-user feature, Stage 2: admin-set current rate for
-- company orders. (Originally also introduced a company-to-company
-- exchange-rate table; the "Exchange Between Companies" requirement was
-- dropped from the product spec entirely, so it's simply not created here.)
--
-- Holds the CURRENT rate only — never touched by a completed order. Every
-- reseller_orders row freezes the rate it read from here into its own
-- rate_applied column at creation time (see Stage 3's migration), exactly
-- mirroring exchange_corridors/exchange_orders.rate_applied
-- (041_money_exchange.sql) so a later admin rate change can never
-- retroactively affect an existing order.

CREATE TABLE IF NOT EXISTS reseller_company_rates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           TEXT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE RESTRICT,
  rate                 NUMERIC(10,6) NOT NULL CHECK (rate > 0),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_admin_id  UUID REFERENCES admin_users(id) ON DELETE SET NULL
);

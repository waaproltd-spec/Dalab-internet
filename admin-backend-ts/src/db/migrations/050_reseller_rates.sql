-- Reseller wholesale-user feature, Stage 2 (part 2): admin-set current
-- rates for company orders and company-to-company exchange.
--
-- Both tables hold the CURRENT rate only — never touched by a completed
-- order. Every reseller_orders/reseller_exchange_orders row freezes the
-- rate it read from here into its own rate_applied column at creation time
-- (see Stage 3/4 migrations), exactly mirroring exchange_corridors/
-- exchange_orders.rate_applied (041_money_exchange.sql) so a later admin
-- rate change can never retroactively affect an existing order.
--
-- reseller_exchange_rates is a deliberate sibling of exchange_corridors,
-- not a reuse of it — exchange_corridors is FK'd to payment_wallets
-- (mobile-money wallet types: evc_plus/edahab/jeeb), while resellers trade
-- between companies (Hormuud/Somtel/eDahab as companies, a different
-- entity). Unifying the two would mean migrating the live eBadal exchange
-- feature onto a different FK target — out of scope here.

CREATE TABLE IF NOT EXISTS reseller_company_rates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       TEXT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE RESTRICT,
  rate             NUMERIC(10,6) NOT NULL CHECK (rate > 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS reseller_exchange_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  to_company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  rate            NUMERIC(10,6) NOT NULL CHECK (rate > 0),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  CHECK (from_company_id <> to_company_id),
  UNIQUE (from_company_id, to_company_id)
);
CREATE INDEX IF NOT EXISTS idx_reseller_exchange_rates_from ON reseller_exchange_rates(from_company_id);
CREATE INDEX IF NOT EXISTS idx_reseller_exchange_rates_to ON reseller_exchange_rates(to_company_id);

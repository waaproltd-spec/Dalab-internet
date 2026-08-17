-- Reseller wholesale-user feature, Stage 3: company orders (Req. 4/6).
--
-- rate_applied/amount_calculated are frozen at creation from
-- reseller_company_rates.rate — never re-read afterward, exactly mirroring
-- exchange_orders.rate_applied (041_money_exchange.sql) and this feature's
-- own reseller_company_rates (050_reseller_rates.sql) doc comment.
--
-- Status vocabulary is the spec's literal wording, with 'cancelled'/'failed'
-- added for symmetry with every other order table in this codebase (orders,
-- exchange_orders both have them; the spec doesn't mention them for
-- resellers but omitting an escape hatch from a stuck pending/payment_sent
-- order would be inconsistent with how every other order type here works).
-- 'confirmed' and 'completed' are two distinct, separately-settable states:
-- the wallet debit happens exactly at the confirm step ("After Admin
-- Confirm -> reseller balance is updated", per spec), and 'completed' is a
-- separate bookkeeping close-out with no further balance effect — so a
-- crash/retry between the two can never double-debit.
CREATE TABLE IF NOT EXISTS reseller_orders (
  id                   TEXT PRIMARY KEY,
  reseller_id          UUID NOT NULL REFERENCES resellers(id) ON DELETE RESTRICT,
  company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  receiving_number     TEXT NOT NULL,
  amount               NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  rate_applied         NUMERIC(10,6) NOT NULL,
  amount_calculated    NUMERIC(10,2) NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','payment_sent','confirmed','completed','cancelled','failed')),
  client_request_id    UUID,
  wallet_transaction_id UUID REFERENCES reseller_wallet_transactions(id) ON DELETE SET NULL,
  verified_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  payment_sent_at      TIMESTAMPTZ,
  confirmed_at         TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_orders_reseller ON reseller_orders(reseller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_orders_status ON reseller_orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_orders_client_request_id
  ON reseller_orders(client_request_id) WHERE client_request_id IS NOT NULL;

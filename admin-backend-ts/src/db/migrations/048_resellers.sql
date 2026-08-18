-- Reseller wholesale-user feature, Stage 1: identity, session auth, and the
-- wallet ledger skeleton. Resellers are a new actor type distinct from
-- customers/agents/admin_users — admin-created only (no self-registration),
-- authenticated with a stable reseller_login_id + an 8-digit PIN instead of
-- a phone+password pair. Modeled directly on `agents` (same admin-created,
-- status-toggle, hashed-credential shape) rather than introducing a new
-- pattern.
--
-- The wallet is split into a fast-read current-balance row
-- (reseller_wallets) plus an append-only audit trail
-- (reseller_wallet_transactions) recording every credit/debit with a
-- before/after snapshot — the same shape as sim_balances/sim_balance_history
-- (029_sim_balances.sql), chosen over a pure append-only ledger
-- (commission_records, 026_commission_management.sql) because reseller
-- order/withdrawal validation needs a cheap "what's the current balance"
-- read on every request, not just a report-time SUM. All balance-changing
-- writes must go through a single withTransaction-wrapped helper that does
-- the balance UPDATE and the history INSERT atomically — see
-- src/utils/resellerWallet.ts.

ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_subject_role_check;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_subject_role_check
  CHECK (subject_role IN ('customer','agent','admin','super_admin','reseller'));

CREATE TABLE IF NOT EXISTS resellers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_login_id  TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  pin_hash           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  phone              TEXT,
  notes              TEXT,
  created_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resellers_status ON resellers(status);

CREATE TABLE IF NOT EXISTS reseller_wallets (
  reseller_id UUID PRIMARY KEY REFERENCES resellers(id) ON DELETE CASCADE,
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- reference_type/source cover every stage of the feature up front (orders,
-- exchange, deposit, withdrawal + its reserve/release pair, and manual admin
-- corrections) so later stages only add rows, never alter this table's shape.
CREATE TABLE IF NOT EXISTS reseller_wallet_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id         UUID NOT NULL REFERENCES resellers(id) ON DELETE RESTRICT,
  previous_balance    NUMERIC(12,2) NOT NULL,
  new_balance         NUMERIC(12,2) NOT NULL,
  change_amount       NUMERIC(12,2) NOT NULL,
  reference_type      TEXT NOT NULL CHECK (reference_type IN
                         ('order','exchange','deposit','withdrawal_reservation','withdrawal_release','withdrawal','admin_adjustment')),
  reference_id        TEXT,
  source              TEXT NOT NULL CHECK (source IN ('sms','admin_manual','system')),
  changed_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_wallet_tx_reseller ON reseller_wallet_transactions(reseller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_wallet_tx_reference ON reseller_wallet_transactions(reference_type, reference_id);

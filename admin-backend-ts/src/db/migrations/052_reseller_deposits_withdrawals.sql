-- Reseller wholesale-user feature, Stage 4: Deposit ("Lacag Ku Shub", Req.
-- 8) and Withdrawal ("Lacag Bixi", Req. 9).
--
-- Deposit's "registered payment number to send money to" is Dalab's own
-- shared collection number for that company — reusing companies.payment_
-- number directly (already exists, already what Internet Store orders show
-- customers) rather than a new per-reseller "receiving" row, per the
-- product instruction to reuse existing infrastructure rather than build a
-- parallel one. reseller_payment_numbers (049) keeps its 'sending'/
-- 'receiving' role split for a possible future per-reseller override, but
-- nothing in Stage 4 requires a 'receiving' row to exist.
--
-- Withdrawal reserves the amount immediately at request time (per spec:
-- "the amount must be reserved/deducted... so the same balance cannot be
-- used for another transaction while processing") — status starts at
-- 'reserved', not 'pending', since the reservation is atomic with creation,
-- not a later step. A cancelled/failed withdrawal releases the reservation
-- back via a second, reversing reseller_wallet_transactions row (never an
-- UPDATE to the original) — same "never mutate a ledger row, always append
-- the reversal" principle used throughout this feature.

CREATE TABLE IF NOT EXISTS reseller_deposits (
  id                    TEXT PRIMARY KEY,
  reseller_id           UUID NOT NULL REFERENCES resellers(id) ON DELETE RESTRICT,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  to_number             TEXT NOT NULL,
  from_number           TEXT NOT NULL,
  amount                NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','completed','failed')),
  client_request_id     UUID,
  matched_sms_log_id    UUID REFERENCES sms_logs(id) ON DELETE SET NULL,
  wallet_transaction_id UUID REFERENCES reseller_wallet_transactions(id) ON DELETE SET NULL,
  verified_by_admin_id  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  verified_at           TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_deposits_reseller ON reseller_deposits(reseller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_deposits_status ON reseller_deposits(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_deposits_client_request_id
  ON reseller_deposits(client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reseller_withdrawals (
  id                     TEXT PRIMARY KEY,
  reseller_id            UUID NOT NULL REFERENCES resellers(id) ON DELETE RESTRICT,
  company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  destination_number     TEXT NOT NULL,
  amount                 NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  status                 TEXT NOT NULL DEFAULT 'reserved'
                           CHECK (status IN ('reserved','sent','completed','cancelled','failed')),
  client_request_id      UUID,
  reservation_tx_id      UUID REFERENCES reseller_wallet_transactions(id) ON DELETE SET NULL,
  release_tx_id          UUID REFERENCES reseller_wallet_transactions(id) ON DELETE SET NULL,
  matched_sms_log_id     UUID REFERENCES sms_logs(id) ON DELETE SET NULL,
  confirmed_by_admin_id  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  sent_at                TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_withdrawals_reseller ON reseller_withdrawals(reseller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_withdrawals_status ON reseller_withdrawals(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_withdrawals_client_request_id
  ON reseller_withdrawals(client_request_id) WHERE client_request_id IS NOT NULL;

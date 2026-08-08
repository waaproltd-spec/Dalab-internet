-- Money Exchange: converting between mobile-money wallet types (EVC Plus,
-- eDahab, JEEB, Amtel Pay — reusing the existing payment_wallets catalog
-- rather than a duplicate provider list). Settlement model mirrors Internet
-- Store exactly: DALAB holds float in each wallet (customer pays DALAB,
-- DALAB fulfills the payout from its own balance).

-- One row per physical payout wallet DALAB controls — the PIN needed to
-- authorize sending FROM this wallet. Normalized separately from
-- exchange_corridors so a PIN is stored exactly once even if multiple
-- corridors pay out from the same wallet. Encrypted with the same
-- AES-256-GCM utility already used for companies.pin_encrypted
-- (src/auth/crypto.ts) — never returned in any GET response, set only via a
-- dedicated Super-Admin-only endpoint, the same posture as the Internet
-- Store USSD PIN.
CREATE TABLE IF NOT EXISTS exchange_payout_wallets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     TEXT NOT NULL REFERENCES payment_wallets(id) ON DELETE RESTRICT,
  device_id     TEXT REFERENCES agent_devices(id) ON DELETE SET NULL,
  sim_slot      INTEGER CHECK (sim_slot IN (1,2)),
  phone_number  TEXT NOT NULL,
  pin_encrypted TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin-configured rate+fee for converting from one wallet to another.
-- amountReceived = amountSent * rate - fee (fee_value is a flat amount when
-- fee_type='fixed', a percentage of amountSent when fee_type='percentage').
CREATE TABLE IF NOT EXISTS exchange_corridors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_wallet_id    TEXT NOT NULL REFERENCES payment_wallets(id) ON DELETE RESTRICT,
  to_wallet_id      TEXT NOT NULL REFERENCES payment_wallets(id) ON DELETE RESTRICT,
  rate              NUMERIC(10,6) NOT NULL DEFAULT 1.0 CHECK (rate > 0),
  fee_type          TEXT NOT NULL DEFAULT 'fixed' CHECK (fee_type IN ('fixed','percentage')),
  fee_value         NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fee_value >= 0),
  min_amount        NUMERIC(10,2),
  max_amount        NUMERIC(10,2),
  payout_wallet_id  UUID REFERENCES exchange_payout_wallets(id) ON DELETE SET NULL,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_wallet_id <> to_wallet_id),
  UNIQUE (from_wallet_id, to_wallet_id)
);

-- The exchange transaction itself — status machine mirrors orders.status
-- exactly (pending -> in_progress -> completed/failed/cancelled), same
-- atomic compare-and-swap transition pattern used throughout orders.routes.ts.
CREATE TABLE IF NOT EXISTS exchange_orders (
  id                  TEXT PRIMARY KEY,
  customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
  corridor_id         UUID NOT NULL REFERENCES exchange_corridors(id) ON DELETE RESTRICT,
  from_wallet_id      TEXT NOT NULL REFERENCES payment_wallets(id),
  to_wallet_id        TEXT NOT NULL REFERENCES payment_wallets(id),
  amount_sent         NUMERIC(10,2) NOT NULL CHECK (amount_sent > 0),
  rate_applied        NUMERIC(10,6) NOT NULL,
  fee_applied         NUMERIC(10,2) NOT NULL,
  amount_received     NUMERIC(10,2) NOT NULL CHECK (amount_received >= 0),
  sender_phone        TEXT NOT NULL,
  receiver_phone      TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','in_progress','completed','failed','cancelled')),
  agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  channel             TEXT NOT NULL DEFAULT 'agent' CHECK (channel IN ('agent','admin','customer_app')),
  reversed_at         TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_customer_id ON exchange_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_status ON exchange_orders(status);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_created_at ON exchange_orders(created_at DESC);

-- Audit trail for the 2-step payout dial, mirroring ussd_dial_attempts.
-- Never stores the PIN — step1/step2 response text is the carrier's own
-- reply text, defensively scrubbed of any exact PIN match at the
-- application layer before being written here (not achievable in SQL).
CREATE TABLE IF NOT EXISTS exchange_dial_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_order_id TEXT NOT NULL REFERENCES exchange_orders(id) ON DELETE CASCADE,
  agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
  sim_slot          INTEGER CHECK (sim_slot IN (1,2)),
  attempt_number    INTEGER NOT NULL,
  step1_ussd_string TEXT,
  step1_response    TEXT,
  step2_response    TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','step1_success','success','failed','ambiguous')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  UNIQUE (exchange_order_id, attempt_number)
);

-- Reuses the existing generic notifications table for "your exchange
-- completed" messages — same widening pattern 030_feedback.sql already used
-- for feedback_update.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('push','promotion','maintenance','feedback_update','exchange_update'));

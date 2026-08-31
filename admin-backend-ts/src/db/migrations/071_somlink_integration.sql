-- SOMLINK Data Service: a REST-API-fulfilled provider, distinct from the
-- existing USSD-dial+SMS-confirmation flow every other provider uses.
-- fulfillment_method lets orders.routes.ts's verifyOrderAndGenerateUssd
-- branch per company instead of assuming USSD for everyone; 'ussd' is the
-- default so every existing company (Hormuud, Somnet, Somtel, Amtel, ...)
-- is completely unaffected.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fulfillment_method TEXT NOT NULL DEFAULT 'ussd'
  CHECK (fulfillment_method IN ('ussd','somlink'));

-- SOMLINK's own bundle catalog ID for this package -- required only for a
-- package belonging to a 'somlink' company; nullable so every existing
-- USSD-fulfilled package needs no admin action.
ALTER TABLE packages ADD COLUMN IF NOT EXISTS somlink_bundle_id INTEGER;

-- One row per outbound SOMLINK /data/send_data attempt for an order --
-- mirrors ussd_dial_attempts' role for the USSD flow. 'ambiguous' mirrors
-- ussd_dial_attempts.status's same value (038_dial_attempt_ambiguous_
-- status.sql): a network error/timeout where SOMLINK's actual outcome is
-- genuinely unknown, so the order is left in_progress for manual admin
-- review rather than guessed at either way -- the one outcome that must
-- never be auto-retried, since SOMLINK moves real wallet funds and offers
-- no "check status by reference" endpoint to safely disambiguate a retry.
CREATE TABLE IF NOT EXISTS somlink_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  bundle_id        INTEGER NOT NULL,
  wallet_phone     TEXT NOT NULL,
  data_phone       TEXT NOT NULL,
  amount           NUMERIC(10,2) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','ambiguous')),
  response_code    INTEGER,
  response_message TEXT,
  paid_amount      NUMERIC(10,2),
  balance_after    NUMERIC(10,2),
  error_detail     TEXT,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_somlink_tx_order_id ON somlink_transactions(order_id);

-- The core duplicate-prevention guarantee, same pattern as payment_
-- transactions' idx_payment_tx_ref_active: at most one row per order that
-- is still pending or already succeeded -- a second concurrent/retried
-- attempt for an order that's mid-flight or already paid is rejected by
-- this constraint at the database level, not raced past it in application
-- code. A 'failed' or 'ambiguous' row does NOT block a new attempt, so a
-- staff-approved manual retry (after confirming via SOMLINK's own
-- dashboard that a prior 'ambiguous' attempt did NOT actually go through)
-- can insert a fresh row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_somlink_tx_order_active
  ON somlink_transactions(order_id) WHERE status IN ('pending','success');

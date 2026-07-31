-- A single, explicit ledger row per real-world payment attempt, spanning the
-- full lifecycle from "SMS received" through to "USSD confirmed" — the
-- authoritative record for guaranteeing a payment is never processed twice,
-- even across an Agent App reconnect or a retried API call.
--
-- status is the explicit state machine requested: pending (SMS
-- received/matched, not yet dialed) -> processing (verify-payment done,
-- USSD dial in flight) -> completed | failed, or duplicate_blocked at any
-- point where this SMS is recognized as a re-delivery of an already-recorded
-- payment.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sms_log_id           UUID REFERENCES sms_logs(id) ON DELETE SET NULL,
  order_id             TEXT REFERENCES orders(id) ON DELETE SET NULL,
  transaction_ref      TEXT,
  customer_phone       TEXT,
  amount               NUMERIC(10,2),
  payment_timestamp    TIMESTAMPTZ,
  agent_device_id      TEXT REFERENCES agent_devices(id) ON DELETE SET NULL,
  sim_slot             INTEGER CHECK (sim_slot IS NULL OR sim_slot IN (1,2)),
  ussd_dial_attempt_id UUID REFERENCES ussd_dial_attempts(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','processing','completed','failed','duplicate_blocked')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_tx_order_id ON payment_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_sms_log_id ON payment_transactions(sms_log_id);

-- The core duplicate-prevention guarantee at the database level: the same
-- real-world payment (identified by its telecom-issued transaction
-- reference) can have at most one row that isn't itself a rejected
-- duplicate — a second concurrent or retried insert attempt for the same
-- transaction_ref fails this constraint rather than racing past it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_tx_ref_active
  ON payment_transactions(transaction_ref) WHERE transaction_ref IS NOT NULL AND status <> 'duplicate_blocked';

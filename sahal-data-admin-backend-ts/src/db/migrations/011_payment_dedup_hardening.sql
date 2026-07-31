-- Explicit transaction-reference dedup, stronger/more authoritative than the
-- existing sender+body+minute heuristic (idx_sms_logs_dedup, 004): captures
-- the telecom's own per-transaction reference code when the SMS format
-- includes one (e.g. Somtel eDahab's "Aqanoosiga" field), so the exact same
-- real-world payment can never be attached to a second order even if its
-- message body text ever varies slightly between deliveries.
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS transaction_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_logs_transaction_ref
  ON sms_logs (transaction_ref) WHERE transaction_ref IS NOT NULL;

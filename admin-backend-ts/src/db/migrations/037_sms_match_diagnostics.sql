-- Every branch inside findMatchingOrder() (smsLogs.routes.ts) that decides
-- NOT to link an SMS to an order (no candidate order at all, phone didn't
-- match, or the device/SIM-slot verification guardrail rejected every
-- amount+phone candidate) previously left zero trace anywhere — an
-- unmatched SMS looked identical on the dashboard whether there was truly
-- no order to match, or a real order existed but was rejected on a
-- device/SIM mismatch. This column records which one happened, in plain
-- language, directly on the row the Payment Transactions dashboard already
-- reads.
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS match_failure_reason TEXT;

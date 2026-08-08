-- The automatic incoming-payment-SMS matcher (smsLogs.routes.ts) now also
-- tries to match a Money Exchange collection payment, not just Internet
-- Store orders. It needs its own column rather than reusing
-- sms_logs.matched_order_id: that column is a hard FK to orders(id), and
-- exchange_orders is a separate table/id-space (DEX... refs), so an
-- exchange order id can never be stored there.
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS matched_exchange_order_id TEXT REFERENCES exchange_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sms_logs_matched_exchange_order ON sms_logs(matched_exchange_order_id);

-- Supports the new ORDER BY ... LIMIT on /admin/sms-logs and
-- /admin/execution-logs, which previously had no LIMIT at all.
CREATE INDEX IF NOT EXISTS idx_sms_logs_received_at ON sms_logs(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ussd_dial_attempts_created_at ON ussd_dial_attempts(created_at DESC);

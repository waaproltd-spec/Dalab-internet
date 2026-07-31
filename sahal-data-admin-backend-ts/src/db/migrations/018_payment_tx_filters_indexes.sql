-- Supports the new device/date-range filters on /admin/payment-transactions
-- and the entity_id lookup the new /:id/timeline endpoint does against
-- admin_activity_log (which had no supporting index at all before this).
CREATE INDEX IF NOT EXISTS idx_payment_tx_device_id ON payment_transactions(agent_device_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_created_at ON payment_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_activity_log_entity ON admin_activity_log(entity_type, entity_id);

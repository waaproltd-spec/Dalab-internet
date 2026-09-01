-- Lets a Shop payment method be tied to the physical agent device/SIM that
-- collects it, exactly like company_payment_methods (Internet Store) and
-- reseller_deposit_methods (Reseller) already are -- this is what resolves
-- "which Agent App gets the real-time payment-received push" once the
-- automatic SMS matcher (shopSmsMatching.ts) confirms a Shop order's
-- payment. NULL until the first successful match auto-links it (same
-- bootstrap behavior findMatchingResellerDeposit already has).
ALTER TABLE shop_payment_methods ADD COLUMN IF NOT EXISTS device_id TEXT REFERENCES agent_devices(id);
ALTER TABLE shop_payment_methods ADD COLUMN IF NOT EXISTS sim_slot INTEGER;

-- Traceability column, same purpose and shape as sms_logs' existing
-- matched_order_id/matched_exchange_order_id/matched_reseller_deposit_id/
-- matched_reseller_withdrawal_id -- which SMS confirmed which Shop order.
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS matched_shop_order_id TEXT REFERENCES shop_orders(id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_matched_shop_order ON sms_logs(matched_shop_order_id) WHERE matched_shop_order_id IS NOT NULL;

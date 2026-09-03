-- The automatic incoming-payment-SMS matcher (smsLogs.routes.ts) now also
-- tries to match a VIP Number / VIP Number Package order payment -- see
-- vipNumberSmsMatching.ts. This reverses migration 087/088's original
-- "not wired into the automatic SMS-matching pipeline" decision for VIP
-- Numbers specifically: real-world use showed a genuinely paid VIP order
-- sitting on 'Awaiting Payment' until an admin happened to notice the
-- incoming SMS and mark it paid by hand. Own columns rather than reusing
-- sms_logs.matched_order_id, same reasoning as matched_exchange_order_id
-- (043): vip_number_orders/vip_number_package_orders are separate
-- tables/id-spaces, not orders(id).
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS matched_vip_number_order_id TEXT REFERENCES vip_number_orders(id) ON DELETE SET NULL;
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS matched_vip_number_package_order_id TEXT REFERENCES vip_number_package_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sms_logs_matched_vip_number_order ON sms_logs(matched_vip_number_order_id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_matched_vip_number_package_order ON sms_logs(matched_vip_number_package_order_id);

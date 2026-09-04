-- The automatic incoming-payment-SMS matcher (smsLogs.routes.ts) now also
-- tries to match a Shop order payment -- see shopSmsMatching.ts. This
-- reverses migration 074's original "manual Admin action from the Shop
-- Orders panel... rather than wired into the automatic SMS-matching
-- pipeline" decision, for the same reason migration 092 already reversed it
-- for VIP Numbers: real-world use showed a genuinely paid Shop order
-- sitting on 'Awaiting Payment' until an admin happened to notice the
-- incoming SMS and mark it paid by hand. Own column rather than reusing
-- sms_logs.matched_order_id, same reasoning as matched_exchange_order_id
-- (043): shop_orders is a separate table/id-space, not orders(id).
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS matched_shop_order_id TEXT REFERENCES shop_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sms_logs_matched_shop_order ON sms_logs(matched_shop_order_id);

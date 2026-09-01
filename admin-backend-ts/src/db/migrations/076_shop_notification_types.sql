-- Widened again (same pattern as 030/041/073 before it) for the Shop
-- service's customer notification types (shop.routes.ts, shopAdmin.routes.ts,
-- shopSmsMatching.ts) -- reuses the existing generic notifications table
-- rather than a separate Shop-specific one. Caught by local end-to-end
-- testing: every one of these was silently failing the in-app
-- notifications-table write (customerNotify.ts's write is best-effort and
-- swallows the error, so the push itself still went out, but the customer's
-- own Notifications screen never got the row).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign',
    'shop_order_placed','shop_payment_confirmed','shop_order_processing','shop_order_shipped',
    'shop_order_delivered','shop_order_cancelled','shop_order_failed','shop_order_returned',
    'shop_order_refunded','shop_back_in_stock','shop_new_offer','shop_return_update'
  ));

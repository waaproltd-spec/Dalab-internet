-- Widened again (same pattern as 030/041/073 before it) for the one new
-- notification type Shop introduces: 'shop_order_update', reused for every
-- Shop order milestone (payment confirmed, processing, shipped, delivered,
-- cancelled) rather than one CHECK value per status -- same one-type-per-
-- feature convention 'exchange_update'/'order_update' already established.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign','shop_order_update'));

-- Phase 2 of the expanded Shop spec:
--  1. shop_settings -- a singleton row (id is always `true`, enforced by the
--     CHECK, same "one config row" pattern as a typical settings table) for
--     the two Super-Admin-configured checkout behaviors the spec calls
--     for: a flat delivery fee added to every order, and the Shop
--     Open/Closed schedule (working days + opening/closing time in
--     Africa/Mogadishu time, or a manual override that always wins over
--     the schedule). `manual_override` is nullable -- NULL means "follow
--     the schedule", 'open'/'closed' pins it either way regardless of time.
--  2. Checkout fields the spec calls for that shop_orders didn't have yet:
--     delivery_notes (free text), and gift order support (is_gift +
--     recipient name/phone/message/wrap). delivery_fee is stored per-order
--     (not just read live from shop_settings) so a later change to the
--     configured fee never rewrites the historical total of an order
--     already placed -- same snapshot principle shop_order_items already
--     uses for product_name/unit_price.
CREATE TABLE IF NOT EXISTS shop_settings (
  id               BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
  delivery_fee     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  working_days     INTEGER[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
  opening_time     TIME NOT NULL DEFAULT '08:00',
  closing_time     TIME NOT NULL DEFAULT '20:00',
  manual_override  TEXT CHECK (manual_override IN ('open', 'closed')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID REFERENCES admin_users(id) ON DELETE SET NULL
);
INSERT INTO shop_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS delivery_notes TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0);
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS is_gift BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS gift_recipient_name TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS gift_recipient_phone TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS gift_message TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS gift_wrap BOOLEAN NOT NULL DEFAULT false;

-- VIP Numbers: a small catalog of premium phone numbers (Gold/Silver tier),
-- one per company (Hormuud/Somnet/Somtel/Amtel), that a customer can browse
-- and purchase. Checkout reuses Shop's exact pattern (see migration 074's
-- header): the customer dials DALAB's own collection number themselves via
-- shop_payment_methods' ussd_template, and an Admin manually marks the
-- order paid from the Admin dashboard once the money arrives -- not wired
-- into the automatic SMS-matching pipeline in smsLogs.routes.ts, for the
-- same reason Shop wasn't: a brand-new, lower-traffic feature shouldn't add
-- a new matcher to Internet/eBadal/Reseller's real-money pipeline. Reuses
-- shop_payment_methods directly (not a new table) since VIP Numbers has no
-- need to repoint its collection number independently of Shop.

CREATE TABLE IF NOT EXISTS vip_numbers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  phone_number  TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('gold', 'silver')),
  price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  -- 'reserved' the instant an order is created (inside the same locked
  -- transaction that inserts the order row -- see vipNumbers.routes.ts),
  -- exactly like Shop's stock decrement at order-creation time, so two
  -- customers can never both "successfully" order the same number while a
  -- first payment is still in flight. 'sold' once an Admin confirms
  -- payment; a cancelled/failed order gives the number back to 'available'.
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, phone_number)
);
CREATE INDEX IF NOT EXISTS idx_vip_numbers_status ON vip_numbers(status);
CREATE INDEX IF NOT EXISTS idx_vip_numbers_company ON vip_numbers(company_id);

-- company_id/phone_number/category/price are snapshotted here (never
-- re-read from vip_numbers later) so a later catalog edit never alters the
-- historical record of what a customer actually agreed to pay -- same
-- reasoning as shop_order_items' own snapshot columns.
CREATE TABLE IF NOT EXISTS vip_number_orders (
  id                    TEXT PRIMARY KEY,
  vip_number_id         UUID NOT NULL REFERENCES vip_numbers(id) ON DELETE RESTRICT,
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  phone_number          TEXT NOT NULL,
  category              TEXT NOT NULL CHECK (category IN ('gold', 'silver')),
  price                 NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  -- The customer's full legal name, required for the real-world number
  -- registration/porting DALAB performs after payment -- validated
  -- server-side to be at least 3 words (given name + father's + grand-
  -- father's name, the standard Somali full-name convention), same
  -- validation applied again in vipNumbers.routes.ts.
  customer_full_name    TEXT NOT NULL,
  payment_method        TEXT NOT NULL REFERENCES shop_payment_methods(method),
  sender_phone          TEXT NOT NULL,
  payment_status        TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'failed')),
  verified_by_admin_id  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  paid_at               TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vip_number_orders_customer ON vip_number_orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vip_number_orders_status ON vip_number_orders(status);
-- Belt-and-suspenders alongside the FOR UPDATE reservation in
-- vipNumbers.routes.ts: at most one active (not yet cancelled/failed/
-- completed) order can ever exist for a given number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_number_orders_active_number
  ON vip_number_orders(vip_number_id) WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS vip_number_order_status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    TEXT NOT NULL REFERENCES vip_number_orders(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  note        TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Widened again (same pattern as 030/041/073/075/080/085 before it) for
-- this feature's own order-update notification. Must carry forward every
-- value 085 already allowed, not just add this one -- re-narrowing this
-- constraint is exactly the bug migration replay commit bf3f15c fixed.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign','shop_order_update','shop_return_update','shop_back_in_stock','vip_number_order_update'));

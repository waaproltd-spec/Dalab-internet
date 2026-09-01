-- Shop: DALAB's 4th independent customer-facing service, alongside
-- Internet | eBadal | Reseller (Home screen order: Internet, eBadal,
-- Reseller, Shop). A small physical-goods marketplace -- exactly 5 fixed
-- categories (Shoes/Eyewear/Perfumes/Watches/Gifts), deliberately no
-- clothing category. Adding this must never touch the orders/packages
-- tables the other three services depend on.
--
-- Checkout reuses the same "customer dials a USSD string themselves" UX as
-- the Internet Store, but the destination is DALAB's OWN collection
-- number, not a provider's -- exactly the reasoning migration 053 already
-- established for Reseller Deposit ("Dalab's own shared collection
-- number"), so shop_payment_methods below mirrors reseller_deposit_methods
-- rather than routing through `companies` (Shop isn't an internet
-- provider). Kept as its own table rather than reusing
-- reseller_deposit_methods directly so Admin can repoint Shop's collection
-- numbers independently later without touching Reseller Deposit, even
-- though the seeded numbers happen to be the same physical SIMs today.
--
-- Payment confirmation is a manual Admin action from the Shop Orders panel
-- (Admin sees the money arrive, taps "Mark Paid") rather than wired into
-- the automatic SMS-matching pipeline in smsLogs.routes.ts -- that file
-- already threads together Store/Exchange/Reseller Deposit/Reseller
-- Withdraw matching with careful ordering and locking guarantees; adding a
-- 5th matcher for a brand-new, lower-traffic feature is a needless risk to
-- Internet/eBadal/Reseller's real-money pipeline. Can be automated later
-- as its own follow-up once Shop has real order volume.

CREATE TABLE IF NOT EXISTS shop_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  emoji       TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO shop_categories (name, emoji, position) VALUES
  ('Shoes', '👟', 1),
  ('Eyewear', '🕶️', 2),
  ('Perfumes', '🌸', 3),
  ('Watches', '⌚', 4),
  ('Gifts', '🎁', 5)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS shop_products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   UUID NOT NULL REFERENCES shop_categories(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  stock         INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_products_category ON shop_products(category_id);

-- image_data is BYTEA, same as promo_images -- there is no S3/Cloudinary
-- pipeline anywhere in this codebase, so this stays consistent with the
-- one established image-storage pattern rather than introducing a second.
-- Never selected in a list/JSON response, only served raw by its own
-- dedicated route (see shop.routes.ts).
CREATE TABLE IF NOT EXISTS shop_product_images (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  image_data    BYTEA NOT NULL,
  mime_type     TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_product_images_product ON shop_product_images(product_id, position);

CREATE TABLE IF NOT EXISTS shop_payment_methods (
  method          TEXT PRIMARY KEY CHECK (method IN ('evc', 'edahab')),
  label           TEXT NOT NULL,
  payment_number  TEXT NOT NULL,
  ussd_template   TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);
INSERT INTO shop_payment_methods (method, label, payment_number, ussd_template) VALUES
  ('evc', 'EVC Plus', '610338686', '*712*610338686*{amount}#'),
  ('edahab', 'eDahab', '620338686', '*110*620338686*{amount}#')
ON CONFLICT (method) DO NOTHING;

-- Stock is reserved (decremented) at order-creation time, before payment is
-- confirmed -- same "reserve immediately, release on cancel" principle
-- reseller_withdrawals already uses, so two customers can never both
-- "successfully" order the last unit while a first payment is still in
-- flight. paid_at/delivered_at are separate from updated_at so the Customer
-- App's order-tracking screen can show real milestone timestamps, not just
-- "last touched".
CREATE TABLE IF NOT EXISTS shop_orders (
  id                    TEXT PRIMARY KEY,
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  payment_method        TEXT NOT NULL REFERENCES shop_payment_methods(method),
  sender_phone          TEXT NOT NULL,
  delivery_name         TEXT NOT NULL,
  delivery_phone        TEXT NOT NULL,
  delivery_address      TEXT NOT NULL,
  total_amount          NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
  payment_status        TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  tracking_reference    TEXT,
  tracking_note         TEXT,
  verified_by_admin_id  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  paid_at               TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_orders_customer ON shop_orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_orders_status ON shop_orders(status);

-- product_name/unit_price are snapshotted at order time (never re-read from
-- shop_products later) so a later price change or product deletion never
-- alters the historical record of what a customer actually paid --
-- product_id itself is nullable + ON DELETE SET NULL for the same reason.
CREATE TABLE IF NOT EXISTS shop_order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  product_id    UUID REFERENCES shop_products(id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,
  unit_price    NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  subtotal      NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0)
);
CREATE INDEX IF NOT EXISTS idx_shop_order_items_order ON shop_order_items(order_id);

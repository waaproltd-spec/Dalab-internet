-- Shop: DALAB's 4th independent customer-facing service (Internet | eBadal |
-- Reseller | Shop) -- one DALAB-owned store, Admin/Super-Admin managed, no
-- seller accounts. Mirrors the existing services' conventions throughout:
-- UUID PKs, a payment_transactions ledger row per real payment attempt
-- (reused as-is, not duplicated -- see shop_orders.id going into that
-- table's existing order_id column), product images stored as BYTEA and
-- served through their own route exactly like promo_images, and a
-- client_request_id idempotency column on shop_orders matching orders /
-- reseller_orders.

-- The 5 main categories are a fixed, spec-mandated set (Electronics,
-- Eyewear, Perfumes, Watches, Gifts) -- Admin can rename/reorder/toggle
-- them but the route layer never exposes create/delete for this table, so
-- a 6th category (e.g. Clothing) can't be added without a code change.
CREATE TABLE IF NOT EXISTS shop_categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO shop_categories (id, name, emoji, position) VALUES
  ('electronics', 'Electronics', '📱', 1),
  ('eyewear',     'Eyewear',     '🕶️', 2),
  ('perfumes',    'Perfumes',    '🌸', 3),
  ('watches',     'Watches',     '⌚', 4),
  ('gifts',       'Gifts',       '🎁', 5)
ON CONFLICT (id) DO NOTHING;

-- Electronics-only, fully dynamic: Admin creates/edits/deletes/toggles
-- these without a code change (Phone Covers, Chargers, ... "Other
-- Electronics"). Products in the other 4 categories never reference this
-- table -- shop_products.subcategory_id is NULL for them.
CREATE TABLE IF NOT EXISTS shop_electronics_subcategories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_brands (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     TEXT NOT NULL REFERENCES shop_categories(id),
  -- Only meaningful when category_id='electronics'; enforced in the route
  -- layer (a DB-level CHECK can't reference another column's *value*
  -- alongside a FK without a trigger, which is more machinery than this
  -- warrants for a single admin-facing form field).
  subcategory_id  UUID REFERENCES shop_electronics_subcategories(id),
  brand_id        UUID REFERENCES shop_brands(id),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  price           NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  -- NULL = no discount. Always < price when set; enforced in the route
  -- layer alongside the rest of the write-side validation.
  discount_price  NUMERIC(10,2),
  stock           INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  sizes           TEXT[] NOT NULL DEFAULT '{}',
  colors          TEXT[] NOT NULL DEFAULT '{}',
  is_featured     BOOLEAN NOT NULL DEFAULT false,
  is_new_arrival  BOOLEAN NOT NULL DEFAULT false,
  is_best_seller  BOOLEAN NOT NULL DEFAULT false,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_products_category ON shop_products(category_id);
CREATE INDEX IF NOT EXISTS idx_shop_products_subcategory ON shop_products(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_shop_products_brand ON shop_products(brand_id);
CREATE INDEX IF NOT EXISTS idx_shop_products_active_created ON shop_products(active, created_at DESC);

-- image_data (BYTEA) deliberately excluded from every column list except
-- the dedicated .../image route, exactly like promo_images.
CREATE TABLE IF NOT EXISTS shop_product_images (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  image_data BYTEA NOT NULL,
  mime_type  TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_product_images_product ON shop_product_images(product_id);

-- Shop's own payment methods -- a single DALAB-owned store, not scoped to
-- a company like company_payment_methods. ussd_template holds a
-- '{amount}'-placeholder string (e.g. '*712*61XXXXXXXX*{amount}#'); the
-- amount is substituted server-side at order-creation time via the same
-- formatUssdAmount rules ussd.routes.ts uses, then handed to the app as
-- shop_orders.dial_ussd -- never persisted, computed fresh from the order
-- total each time it's requested.
CREATE TABLE IF NOT EXISTS shop_payment_methods (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  method         TEXT NOT NULL,
  label          TEXT NOT NULL,
  payment_number TEXT,
  ussd_template  TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row table (id fixed at 1) holding the Open/Closed schedule.
-- manual_override, when set, wins over the computed schedule outright
-- ('closed' can take the store offline mid-schedule; 'open' can open it
-- outside configured hours) -- NULL means "follow the schedule".
CREATE TABLE IF NOT EXISTS shop_settings (
  id               INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  working_days     INTEGER[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}', -- 0=Sunday .. 6=Saturday
  opening_time     TIME NOT NULL DEFAULT '08:00',
  closing_time     TIME NOT NULL DEFAULT '20:00',
  manual_override  TEXT CHECK (manual_override IN ('open','closed')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO shop_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS shop_orders (
  id                    TEXT PRIMARY KEY,
  customer_id           UUID NOT NULL REFERENCES customers(id),
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','processing','shipped','delivered','cancelled','failed','returned','refunded')),
  payment_status        TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),
  payment_method        TEXT,
  sender_phone          TEXT NOT NULL,
  delivery_name         TEXT NOT NULL,
  delivery_phone        TEXT NOT NULL,
  delivery_address      TEXT NOT NULL,
  delivery_notes        TEXT,
  promo_code            TEXT,
  discount_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_fee          NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_amount          NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
  is_gift               BOOLEAN NOT NULL DEFAULT false,
  gift_recipient_name   TEXT,
  gift_recipient_phone  TEXT,
  gift_message          TEXT,
  gift_wrap             BOOLEAN NOT NULL DEFAULT false,
  courier_name          TEXT,
  tracking_reference    TEXT,
  tracking_note         TEXT,
  client_request_id     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_orders_customer ON shop_orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_orders_status ON shop_orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_orders_client_request_id ON shop_orders(client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shop_order_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  -- Nullable + name/price snapshotted: a product can be edited or removed
  -- long after an order shipped without ever altering that order's
  -- historical receipt.
  product_id   UUID REFERENCES shop_products(id),
  product_name TEXT NOT NULL,
  unit_price   NUMERIC(10,2) NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  subtotal     NUMERIC(10,2) NOT NULL,
  size         TEXT,
  color        TEXT
);
CREATE INDEX IF NOT EXISTS idx_shop_order_items_order ON shop_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_shop_order_items_product ON shop_order_items(product_id);

CREATE TABLE IF NOT EXISTS shop_favorites (
  customer_id UUID NOT NULL REFERENCES customers(id),
  product_id  UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);

-- One review per (customer, order_item) -- ties the review to a specific
-- line of a specific real order, so "only customers who purchased" is a
-- join, not a trust-the-client flag. A customer who bought the same
-- product across two separate orders may review it twice, once per order.
CREATE TABLE IF NOT EXISTS shop_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  product_id    UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL UNIQUE REFERENCES shop_order_items(id),
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text   TEXT NOT NULL DEFAULT '',
  photo_data    BYTEA,
  photo_mime    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_reviews_product ON shop_reviews(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shop_promo_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  discount_type    TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value   NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  min_order_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  usage_limit      INTEGER,
  used_count       INTEGER NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT true,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_flash_sales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  discount_price NUMERIC(10,2) NOT NULL CHECK (discount_price >= 0),
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_flash_sales_product ON shop_flash_sales(product_id);
CREATE INDEX IF NOT EXISTS idx_shop_flash_sales_window ON shop_flash_sales(starts_at, ends_at) WHERE active = true;

CREATE TABLE IF NOT EXISTS shop_returns (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   TEXT NOT NULL REFERENCES shop_orders(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  type       TEXT NOT NULL CHECK (type IN ('return','exchange','refund')),
  reason     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested','approved','rejected','processing','completed')),
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_returns_order ON shop_returns(order_id);
CREATE INDEX IF NOT EXISTS idx_shop_returns_customer ON shop_returns(customer_id, created_at DESC);

-- Back-in-stock subscriptions -- one row per (customer, product) "notify
-- me" tap; notified flips true (and stays true) once the restock push
-- actually fires, so a product going 0 -> 1 -> 0 -> 1 only re-notifies a
-- customer who asks again after the first notification.
CREATE TABLE IF NOT EXISTS shop_stock_notify_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  product_id UUID NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  notified   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_stock_notify_pending ON shop_stock_notify_requests(product_id) WHERE notified = false;

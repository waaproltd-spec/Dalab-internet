-- VIP Number Packages: an admin-curated bundle of 2-4 individual VIP
-- numbers (see migration 087) sold together as a single purchase/order at
-- one admin-set total price, for a customer who wants a matching/related
-- set of premium numbers instead of buying one at a time. Reuses
-- vip_numbers as the single source of truth for each included number's
-- own company/phone/category (never duplicated here) and mirrors
-- vip_number_orders' exact "reserve at order-creation, mark sold once
-- Admin confirms payment" flow, just applied to every number in the
-- package atomically instead of one number at a time.
--
-- A plain single-number purchase (migration 087, unchanged by this file)
-- stays exactly as it is -- this is a parallel, independent purchase path
-- for 2/3/4-number bundles, not a replacement.

CREATE TABLE IF NOT EXISTS vip_number_packages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  size          INTEGER NOT NULL CHECK (size IN (2, 3, 4)),
  price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  -- An inactive package is simply hidden from the customer catalog --
  -- its member numbers are NOT released back to individual sale by this
  -- flag alone (see vip_number_package_items' own comment); deleting the
  -- package (only allowed with no non-terminal order against it, same
  -- "only while available" rule vip_numbers' own DELETE route uses) is
  -- what actually frees its numbers.
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which vip_numbers belong to this package, and their display order.
-- A number can belong to at most one package at a time (enforced in
-- vipNumberPackages.routes.ts at create/edit time, not here) -- while it
-- belongs to any package, GET /vip-numbers (the individual/"1 Number"
-- public catalog, migration 087) excludes it, so the same physical number
-- can never be sold twice through both paths at once.
CREATE TABLE IF NOT EXISTS vip_number_package_items (
  package_id    UUID NOT NULL REFERENCES vip_number_packages(id) ON DELETE CASCADE,
  vip_number_id UUID NOT NULL REFERENCES vip_numbers(id) ON DELETE RESTRICT,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (package_id, vip_number_id)
);
CREATE INDEX IF NOT EXISTS idx_vip_number_package_items_number ON vip_number_package_items(vip_number_id);
-- A number can only ever be an active member of one package at a time --
-- belt-and-suspenders alongside the application-level check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_number_package_items_one_package_per_number
  ON vip_number_package_items(vip_number_id);

-- One purchase of an entire package -- mirrors vip_number_orders' own
-- shape/columns closely (migration 087) but references the package as a
-- whole rather than a single vip_number_id, since a package order always
-- covers every number in the package together, in one transaction.
CREATE TABLE IF NOT EXISTS vip_number_package_orders (
  id                    TEXT PRIMARY KEY,
  package_id            UUID NOT NULL REFERENCES vip_number_packages(id) ON DELETE RESTRICT,
  size                  INTEGER NOT NULL,
  price                 NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS idx_vip_number_package_orders_customer ON vip_number_package_orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vip_number_package_orders_status ON vip_number_package_orders(status);
-- Belt-and-suspenders alongside the FOR UPDATE reservation in
-- vipNumberPackages.routes.ts: at most one active (not yet cancelled/
-- failed/completed) order can ever exist for a given package.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_number_package_orders_active
  ON vip_number_package_orders(package_id) WHERE status IN ('pending', 'processing');

-- Snapshot of each number in a package order, taken at purchase time --
-- same "never re-read from the catalog later" reasoning as
-- vip_number_orders' own snapshot columns (migration 087), so a later
-- edit to the package's membership never alters the historical record of
-- what a customer actually agreed to buy.
CREATE TABLE IF NOT EXISTS vip_number_package_order_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_order_id  TEXT NOT NULL REFERENCES vip_number_package_orders(id) ON DELETE CASCADE,
  vip_number_id     UUID NOT NULL REFERENCES vip_numbers(id) ON DELETE RESTRICT,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  phone_number      TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('gold', 'silver'))
);
CREATE INDEX IF NOT EXISTS idx_vip_number_package_order_items_order ON vip_number_package_order_items(package_order_id);

CREATE TABLE IF NOT EXISTS vip_number_package_order_status_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_order_id  TEXT NOT NULL REFERENCES vip_number_package_orders(id) ON DELETE CASCADE,
  status            TEXT NOT NULL,
  note              TEXT,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Widened again (same pattern as 073/075/080/085/087 before it) for this
-- feature's own order-update notification -- must carry forward every
-- value 087 already allowed, not just add this one.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign','shop_order_update','shop_return_update','shop_back_in_stock','vip_number_order_update','vip_number_package_order_update'));

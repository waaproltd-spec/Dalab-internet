-- Extra Packages: an Admin-set "Send Count" -- how many times one paid
-- order delivers the package (e.g. pay once, receive it 2, 3 or 10 times).
-- Every existing package and order defaults to 1, so their delivery is
-- exactly what it was before. No rows are changed or deleted. Safe to
-- replay on every boot.

ALTER TABLE packages ADD COLUMN IF NOT EXISTS send_count INTEGER NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'packages_send_count_check') THEN
    ALTER TABLE packages ADD CONSTRAINT packages_send_count_check CHECK (send_count BETWEEN 1 AND 50);
  END IF;
END $$;

-- Frozen onto the order when it's created, so editing a package's Send
-- Count later never changes an order the customer already paid for.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS send_count INTEGER NOT NULL DEFAULT 1;

-- Set on INSERT from the order's package, whichever route created it
-- (customer, guest, agent or offline auto-order) -- none of them need to
-- know about Send Count.
CREATE OR REPLACE FUNCTION orders_copy_package_send_count() RETURNS trigger AS $$
BEGIN
  NEW.send_count := COALESCE((SELECT send_count FROM packages WHERE id = NEW.package_id), 1);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_copy_package_send_count ON orders;
CREATE TRIGGER trg_orders_copy_package_send_count
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE PROCEDURE orders_copy_package_send_count();

-- SOMLINK: one row per delivery. The "never two live attempts" guarantee
-- (071's idx_somlink_tx_order_active) now holds per delivery instead of per
-- order. Single-delivery orders only ever use delivery_index 1, which is
-- exactly the old rule.
ALTER TABLE somlink_transactions ADD COLUMN IF NOT EXISTS delivery_index INTEGER NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_somlink_tx_order_active' AND indexdef NOT LIKE '%delivery_index%'
  ) THEN
    DROP INDEX idx_somlink_tx_order_active;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_somlink_tx_order_active
  ON somlink_transactions(order_id, delivery_index) WHERE status IN ('pending','success');

-- Agent Reports: each order remembers its package's original ("old")
-- price at the moment it was created, so Discount (list price - amount
-- paid) stays exact even if the package's prices are edited later.
-- Additive; no rows are deleted. Safe to replay on every boot.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS list_price NUMERIC(10,2);

-- Set on INSERT from the order's package, whichever route created it.
-- A package without an old price is sold at its price (no discount).
CREATE OR REPLACE FUNCTION orders_copy_package_list_price() RETURNS trigger AS $$
BEGIN
  IF NEW.list_price IS NULL THEN
    NEW.list_price := (SELECT COALESCE(old_price, price) FROM packages WHERE id = NEW.package_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_copy_package_list_price ON orders;
CREATE TRIGGER trg_orders_copy_package_list_price
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE PROCEDURE orders_copy_package_list_price();

-- Orders from before this existed get today's package old price (the best
-- available record); only rows still missing it are touched.
UPDATE orders o
SET list_price = COALESCE(p.old_price, p.price)
FROM packages p
WHERE p.id = o.package_id AND o.list_price IS NULL;

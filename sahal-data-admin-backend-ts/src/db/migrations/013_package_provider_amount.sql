-- Separates the customer-facing payment amount from the amount actually
-- requested from the provider via USSD. Until now both were the single
-- packages.price / orders.amount value, so a package sold to the customer
-- at a discounted price (e.g. $0.09) generated a USSD request for that same
-- discounted amount ($0.09) instead of the provider's real, full package
-- cost (e.g. $0.10) — silently under-topping-up every discounted order.
--
-- provider_amount is nullable on both tables: NULL means "no separate
-- provider cost configured" and callers fall back to price/amount, so a
-- package that was never discounted needs no admin action and keeps
-- behaving exactly as before.
ALTER TABLE packages ADD COLUMN IF NOT EXISTS provider_amount NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_amount NUMERIC(10,2);

-- Backfill already-placed orders so a pending order created before this
-- migration still gets a real value (equal to what the customer paid,
-- matching today's behavior) rather than NULL.
UPDATE orders SET provider_amount = amount WHERE provider_amount IS NULL;

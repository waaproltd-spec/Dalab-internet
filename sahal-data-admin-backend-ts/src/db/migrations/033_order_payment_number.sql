-- Snapshot of companies.payment_number at the moment an order was created —
-- the company's own number can change later, but the receipt should always
-- show what the customer was actually told to pay to at the time.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_number_used TEXT;

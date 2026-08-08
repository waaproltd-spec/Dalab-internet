-- Customer App self-service Money Exchange support: idempotent order
-- creation (mirrors orders.client_request_id from 005_idempotency_and_dedup.sql)
-- and a snapshotted "where to send the money" collection number so the
-- Payment Instructions screen always reflects what the customer was
-- actually told at order-creation time, even if the admin edits the wallet
-- afterward (same rationale as orders.payment_number_used).

ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS client_request_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_orders_client_request_id
  ON exchange_orders (client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS collection_phone_number TEXT;

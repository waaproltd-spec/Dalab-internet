-- Prevent re-visiting the Money Exchange flow from creating multiple sibling
-- pending exchange orders for the exact same request (same customer,
-- corridor, amount). Same bug class already fixed for Internet Store orders
-- in 032_pending_order_dedup.sql: ExchangeConfirmScreen generates a fresh
-- clientRequestId per screen composition (late final _clientRequestId =
-- generateUuidV4()), so backing out and re-attempting the same exchange
-- legitimately creates a second, distinct pending row — and
-- findMatchingExchangeOrder's oldest-first matching then lets a real
-- payment SMS silently complete the abandoned one instead of the order the
-- customer is actually looking at.
--
-- Unlike 032, exchange_orders has no scheduled_at concept, so no equivalent
-- exclusion is needed.
--
-- Same production-safety step as 032: cancel every duplicate except the
-- oldest per group before creating the index, in case any pre-existing
-- duplicate pending rows would otherwise fail the index creation. Never
-- deletes rows, so order history/audit stays intact.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY customer_id, corridor_id, amount_sent
           ORDER BY created_at ASC
         ) AS rn
  FROM exchange_orders
  WHERE status = 'pending'
)
UPDATE exchange_orders
SET status = 'cancelled'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_orders_pending_content_dedup
  ON exchange_orders (customer_id, corridor_id, amount_sent)
  WHERE status = 'pending';

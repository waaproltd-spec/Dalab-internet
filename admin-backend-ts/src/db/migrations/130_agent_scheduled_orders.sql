-- Agent "Schedule Transaction": an agent registers a customer's order to be
-- sent at a set time (orders.scheduled_at, migration 025).
--   scheduled_paid_at: the payment is confirmed (prepaid by the agent, or the
--     customer's payment SMS matched) but the scheduled time hasn't come yet,
--     so the order is held as 'pending' and not dialed. At scheduled_at the
--     server releases it into the normal processing flow.
--   payment_mode: 'prepaid' (agent confirmed payment when registering) or
--     'pay_at_execution' (wait for the customer's payment, before or after
--     the scheduled time). NULL for every ordinary order.
--   schedule_note: the agent's optional internal note.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_paid_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_mode TEXT CHECK (payment_mode IN ('prepaid','pay_at_execution'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS schedule_note TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_scheduled_due ON orders(scheduled_at)
  WHERE status='pending' AND scheduled_paid_at IS NOT NULL;

-- Customer-funds protection: neither an Internet/Data order nor a Money
-- Exchange payout may ever sit silently unresolved after the customer's
-- payment is confirmed. Two safety windows (7 minutes for delivery, 20
-- minutes for payout) act as a last-resort net; the moment automation
-- reports a definitive failure (a final dial-attempt failure, a USSD
-- generation failure) the order/exchange is promoted to its review status
-- immediately — these deadlines only catch the "stuck with no signal at
-- all" case (e.g. no device ever picked it up).
--
-- payment_confirmed_at is the moment status first reaches 'in_progress'
-- (the existing pending -> in_progress transition already means "payment
-- verified" — see verifyOrderAndGenerateUssd / autoAdvanceExchangeOrderToInProgress).
-- No new "payment confirmed" status value is introduced: the admin
-- dashboard derives "Payment: Confirmed" from payment_confirmed_at being
-- non-null, kept orthogonal to how delivery/payout is progressing.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending','in_progress','pending_admin_review','completed','completed_manual','failed','cancelled'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_deadline_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_completed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_completed_at TIMESTAMPTZ;

-- Powers the 7-minute safety sweep (WHERE status='in_progress' AND
-- delivery_deadline_at < now()) without a full table scan.
CREATE INDEX IF NOT EXISTS idx_orders_delivery_deadline ON orders (delivery_deadline_at) WHERE status = 'in_progress';

ALTER TABLE exchange_orders DROP CONSTRAINT IF EXISTS exchange_orders_status_check;
ALTER TABLE exchange_orders ADD CONSTRAINT exchange_orders_status_check
  CHECK (status IN ('pending','in_progress','pending_manual_payout','completed','completed_manual','failed','cancelled'));

ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS payout_deadline_at TIMESTAMPTZ;
ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS payout_failure_reason TEXT;
ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS manual_payout_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS manual_payout_at TIMESTAMPTZ;
ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS manual_payout_reference TEXT;

CREATE INDEX IF NOT EXISTS idx_exchange_orders_payout_deadline ON exchange_orders (payout_deadline_at) WHERE status = 'in_progress';

-- Schedule Recharge: lets a customer defer a package's provider-side
-- fulfillment (USSD/data delivery) to a future date/time, independent of
-- payment (which still happens immediately via the existing wallet-dial +
-- SMS-match flow, completely unchanged). A NULL scheduled_at means "process
-- immediately" -- the default, existing behavior for every current order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

-- A customer-requested cancellation of a scheduled (already-paid) recharge
-- is never auto-refunded -- it becomes a review item for the Super Admin.
-- cancellation_decision stays NULL while pending review; 'approved' triggers
-- the existing bookkeeping-only order reversal; 'rejected' means the
-- recharge proceeds as originally scheduled.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_decision TEXT CHECK (cancellation_decision IN ('approved', 'rejected'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_decided_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_decided_by TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_scheduled_at ON orders(scheduled_at) WHERE scheduled_at IS NOT NULL;

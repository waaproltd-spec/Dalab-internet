-- Customer Feedback / Make Suggestion: real backend persistence for the
-- Customer App's Feedback screen (previously a pure front-end mock with no
-- storage at all). One row per submission; status flows
-- pending -> reviewed/implemented/rejected, with an optional admin reply.
CREATE TABLE IF NOT EXISTS feedback (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  message      TEXT NOT NULL,
  device_info  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','implemented','rejected')),
  admin_reply  TEXT,
  replied_by   UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  replied_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
CREATE INDEX IF NOT EXISTS idx_feedback_customer_id ON feedback(customer_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);

-- Widen the existing broadcast-only notifications table to also support a
-- single customer as the target (nullable = existing broadcast behavior,
-- unchanged) so a status update on their own feedback can notify just them
-- instead of every customer.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_notifications_customer_id ON notifications(customer_id);

DO $$
BEGIN
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('push','promotion','maintenance','feedback_update'));
END $$;

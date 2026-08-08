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

-- The notifications_type_check constraint itself is intentionally NOT set
-- here anymore. migrate.ts replays every migration file on every deploy
-- (no tracking table), so this file must stay safe to re-run indefinitely.
-- This block used to unconditionally narrow the constraint to
-- ('push','promotion','maintenance','feedback_update') on every replay --
-- fine on a fresh database, but once 041_money_exchange.sql's later,
-- wider constraint (which adds 'exchange_update') has actually been applied
-- and real exchange_update rows exist, replaying THIS narrower version
-- first on every subsequent deploy fails with "check constraint ... is
-- violated by some row" and blocks every migration after it, forever.
-- 041_money_exchange.sql (which runs after this file, sorted by filename)
-- is the sole source of truth for this constraint's final, correct value.

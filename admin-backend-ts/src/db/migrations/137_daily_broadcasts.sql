-- Daily customer messages: a scheduled broadcast with repeat = 'daily' is
-- sent at its time every day; each day's copy is its own campaign in the
-- history, linked by series_id. Cancelling the waiting copy stops the
-- series. Idempotent: safe to replay on every deploy.
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS repeat TEXT NOT NULL DEFAULT 'none';
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS series_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_campaigns_repeat_check') THEN
    ALTER TABLE notification_campaigns ADD CONSTRAINT notification_campaigns_repeat_check CHECK (repeat IN ('none','daily'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_notification_campaigns_series ON notification_campaigns (series_id, status) WHERE series_id IS NOT NULL;

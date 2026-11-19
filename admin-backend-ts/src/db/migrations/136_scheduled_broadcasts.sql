-- Customer broadcasts: send now (in the background for a large audience,
-- so the app gets its answer at once) or at a set time (scheduled; can be
-- cancelled until it goes out). Every past campaign stays 'sent'.
-- One "Send" tap = one campaign (request_id), and a send that a restart
-- interrupted resumes without notifying anyone twice (one recipient row
-- per customer per campaign). Idempotent: safe to replay on every deploy.
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_campaigns_request_id
  ON notification_campaigns (created_by_id, request_id) WHERE request_id IS NOT NULL;

ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE notification_campaigns ADD COLUMN IF NOT EXISTS customer_ids TEXT[];
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_campaigns_status_check') THEN
    ALTER TABLE notification_campaigns ADD CONSTRAINT notification_campaigns_status_check
      CHECK (status IN ('scheduled','sending','sent','cancelled'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_notification_campaigns_due ON notification_campaigns (scheduled_at) WHERE status = 'scheduled';

-- One recipient row per customer per campaign (keeps the oldest if an old
-- campaign somehow listed a customer twice).
DELETE FROM notification_campaign_recipients r
 USING notification_campaign_recipients d
 WHERE r.campaign_id = d.campaign_id AND r.customer_id = d.customer_id AND r.ctid > d.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_campaign_recipients_unique
  ON notification_campaign_recipients (campaign_id, customer_id);

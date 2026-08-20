-- A staff/agent-initiated broadcast push -- distinct from the existing
-- `notifications` table's single-row-per-recipient model (which is fine for
-- an automatic per-order update, but gives no way to see "who did we send
-- this campaign to and did it land" for a deliberate broadcast). One row
-- per Send action; notification_campaign_recipients below has one row per
-- customer that campaign targeted. Reachable identically from the Admin
-- dashboard and the Agent app -- see notifications.routes.ts's shared
-- /notifications/broadcast route, gated for super_admin+admin+agent alike
-- so there is no capability difference between the two apps.
CREATE TABLE IF NOT EXISTS notification_campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  target_type      TEXT NOT NULL CHECK (target_type IN ('single','multiple','all','recent')),
  service_filter   TEXT NOT NULL DEFAULT 'all' CHECK (service_filter IN ('all','internet','ebadal','reseller')),
  recipient_count  INTEGER NOT NULL DEFAULT 0,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  delivered_count  INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  -- Not FK'd: a staff sender's id lives in admin_users, an agent sender's in
  -- agents -- two disjoint tables. created_by_role disambiguates which one
  -- created_by_id refers to; the history view resolves the display name by
  -- looking it up in the right table for that role.
  created_by_id    UUID,
  created_by_role  TEXT NOT NULL CHECK (created_by_role IN ('super_admin','admin','agent')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_campaigns_created_at ON notification_campaigns(created_at DESC);

-- Per-customer outcome for a campaign. 'sent' means the push was handed to
-- FCM for that customer's device token(s); 'delivered' means FCM accepted
-- every one of them with no error; 'failed' means every token for that
-- customer errored (e.g. app uninstalled, token expired) -- FCM's send API
-- confirms acceptance, not that the device actually displayed it, so
-- "delivered" here is the closest honest signal available without a
-- separate client-side read-receipt round trip.
CREATE TABLE IF NOT EXISTS notification_campaign_recipients (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES notification_campaigns(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','failed')),
  error_detail TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_campaign_recipients_campaign ON notification_campaign_recipients(campaign_id);

-- Widened again (same pattern as 030/041 before it) for the two new
-- automatic/campaign notification types this push-notification feature
-- introduces: 'order_update' (orders.routes.ts's completeOrderById) and
-- 'campaign' (a targeted Admin/Agent broadcast's per-recipient in-app row,
-- so anything a customer got as a push also shows up if they later open
-- the app's own Notifications screen).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign'));

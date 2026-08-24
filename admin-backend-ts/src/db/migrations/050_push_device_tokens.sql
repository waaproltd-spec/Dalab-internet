-- Push notification device tokens (Firebase Cloud Messaging), one row per
-- app install that has registered -- a customer with multiple devices (or
-- who reinstalled) gets a token per device/install, and every push sent to
-- that customer_id fans out to all of them. fcm_token is globally UNIQUE:
-- FCM tokens are already unique per app-install, and re-registering the
-- same token (app reopened after a token refresh, or a different customer
-- logs into the same device) should move the single row rather than create
-- a duplicate -- see the ON CONFLICT upsert in notifications.routes.ts.
CREATE TABLE IF NOT EXISTS customer_device_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  fcm_token    TEXT NOT NULL UNIQUE,
  platform     TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_device_tokens_customer ON customer_device_tokens(customer_id);

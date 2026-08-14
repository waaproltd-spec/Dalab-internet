-- Turns the existing notifications table (previously write-once broadcast
-- rows, no per-customer read tracking, no push delivery) into a real
-- per-customer inbox the Admin Dashboard can target and a device can
-- receive an actual push for. Extends the table already used by
-- notifications.routes.ts/GET /notifications rather than introducing a
-- second, parallel notifications system.

-- read_at: null = unread. Every notification this migration's new admin
-- send flow creates always has a concrete customer_id (never the old
-- broadcast-to-everyone NULL), so read tracking is accurate per customer —
-- see notifications.routes.ts for why pre-existing NULL-customer_id rows
-- are treated as always-read instead of needing a separate join table.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS related_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS related_exchange_order_id TEXT REFERENCES exchange_orders(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_by_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_type TEXT CHECK (target_type IN ('single','multiple','group','all'));

-- 'order_update' is new — the existing set (push/promotion/maintenance/
-- feedback_update/exchange_update) had no Internet-Store-order equivalent
-- of exchange_update, needed for the "related order" deep-link case.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('push','promotion','maintenance','feedback_update','exchange_update','order_update'));

CREATE INDEX IF NOT EXISTS idx_notifications_customer_unread ON notifications (customer_id, read_at) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_customer_sent_at ON notifications (customer_id, sent_at DESC);

-- One row per registered device (a customer can be signed in on more than
-- one phone). token is globally unique — re-registering the same device
-- (reinstall, re-login, a token FCM itself rotated) upserts onto the
-- existing row rather than accumulating stale duplicates that would each
-- receive their own copy of every push.
CREATE TABLE IF NOT EXISTS customer_push_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  platform    TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android','ios')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_push_tokens_customer_id ON customer_push_tokens (customer_id);

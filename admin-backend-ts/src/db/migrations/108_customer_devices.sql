-- Trusted Devices: lets a customer see and manage every device signed into
-- their DALAB account (Account -> Security -> Trusted Devices in the
-- Customer App), and lets the backend tie a specific refresh token back to
-- the device that requested it, so removing one device's access can revoke
-- exactly that device's session instead of every session at once.

-- Nullable and best-effort: only customer-app login calls that actually
-- send a deviceId populate this; every other role's tokens (admin/agent/
-- reseller) simply leave it null, completely unaffected.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device ON refresh_tokens(subject_id, device_id) WHERE device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- A stable identifier the Customer App generates once per install and
  -- persists locally (see device_identity.dart) -- reinstalling the app
  -- creates a new one, which is the correct behavior: a fresh install is a
  -- fresh "device" from a security standpoint even on the same physical
  -- hardware.
  device_id      TEXT NOT NULL,
  device_name    TEXT NOT NULL,
  device_type    TEXT NOT NULL DEFAULT 'unknown' CHECK (device_type IN ('phone','tablet','desktop','unknown')),
  platform       TEXT NOT NULL DEFAULT 'unknown',
  os_version     TEXT,
  app_version    TEXT,
  location       TEXT,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  UNIQUE (customer_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_devices_customer ON customer_devices(customer_id, last_active_at DESC);

-- One row per login/open event for a device -- what Trusted Devices' own
-- detail screen shows as "Recent Activity" for that device specifically.
CREATE TABLE IF NOT EXISTS customer_device_activity (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   UUID NOT NULL REFERENCES customer_devices(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('login','app_open','removed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_device_activity_device ON customer_device_activity(device_id, created_at DESC);

-- notifications.type is whitelisted by a CHECK constraint -- widen it to
-- accept this feature's one new type ('new_device_login', written by
-- notifyCustomer() when a customer's account is signed into from a device
-- it hasn't seen before). Recreated NOT VALID, matching how the existing
-- constraint is already declared (see 104_customer_friends.sql), so this
-- doesn't force a full-table validation scan of every historical
-- notifications row.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  type = ANY (ARRAY[
    'push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign',
    'shop_order_update','shop_return_update','shop_back_in_stock','vip_number_order_update','vip_number_package_order_update',
    'friend_request','friend_accepted','friend_message','new_device_login'
  ])
) NOT VALID;
